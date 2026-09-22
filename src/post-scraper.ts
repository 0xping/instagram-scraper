import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { BrowserContext, Page } from 'playwright';
import { waitForResponses } from './browser.js';
import type { InstagramSessionManager } from './instagram-session.js';
import { RATE_LIMIT_TEXT } from './profile-extract.js';
import {
  assertStillAllowed, classify, delay, finishJob, isBatchFatal, RateLimitedError, startJob, writeDebugFiles,
  type ScrapeFailure, type ScrapeOptions,
} from './profile-scraper.js';
import { extractPost, PostExtractionError, type MediaItem, type PostFields, type PostSnapshot } from './post-extract.js';

/** Attempts per post within one run (first try + retries). */
const ATTEMPTS_PER_RUN = 3;
/** Backoff before retry n: 5 s, then 15 s (x3 each time). */
const BACKOFF_BASE_MS = 5_000;
/** Runs a post may fail before it is left alone (until --force). */
export const MAX_FAILED_RUNS = 5;
const READY_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_500;
// ponytail: fixed jittered pause between posts; make it configurable if a larger backlog needs tuning.
const POST_PACING_MS = [4_000, 9_000] as const;

export interface PostScrapeOptions extends ScrapeOptions {
  force: boolean;
  limit: number | null;
  /** Only these posts, regardless of status (used to refresh expired media URLs). */
  postIds?: number[];
}

export interface PendingPost {
  id: number;
  shortcode: string;
  url: string;
  status: string;
}

export interface PostRunSummary {
  username: string;
  selected: number;
  extracted: number;
  unavailable: number;
  restricted: number;
  failed: number;
  alreadyComplete: number;
  stoppedBy: string | null;
}

// ---- Selection -----------------------------------------------------------------------------------

/**
 * Posts to process for a competitor, in discovery order (newest first).
 * Default: pending, interrupted (`in_progress`), and failed posts under the retry cap. Deleted and restricted
 * posts are permanent outcomes and are skipped. --force selects every post, complete ones included.
 */
export function selectPosts(db: Database.Database, competitorId: number, force: boolean, limit: number | null, postIds?: number[]): PendingPost[] {
  const owned = `(p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))`;
  const eligible = postIds ? `p.id IN (${postIds.map(Number).join(',') || 'NULL'})` : force ? '1' : `(p.extraction_status IN ('pending', 'in_progress')
    OR (p.extraction_status = 'failed' AND p.availability NOT IN ('unavailable', 'restricted') AND p.extraction_attempts < @max))`;
  return db.prepare(`SELECT p.id, p.shortcode, p.url, p.extraction_status AS status FROM posts p
    WHERE ${owned} AND ${eligible} ORDER BY p.id LIMIT @limit`)
    .all({ cid: competitorId, max: MAX_FAILED_RUNS, limit: limit ?? -1 }) as PendingPost[];
}

export function countComplete(db: Database.Database, competitorId: number): number {
  return (db.prepare(`SELECT count(*) AS n FROM posts p WHERE p.extraction_status = 'complete' AND (p.competitor_id = ?
    OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = ?))`).get(competitorId, competitorId) as { n: number }).n;
}

// ---- Persistence ---------------------------------------------------------------------------------

/**
 * One transaction per post: latest fields on `posts` (raw_json change appends a raw_post_snapshots row via
 * trigger), one metrics observation per job, one `media` row per item, and earlier extraction errors resolved.
 */
export function saveExtracted(
  db: Database.Database,
  postId: number,
  jobId: number,
  fields: PostFields,
  items: MediaItem[],
  raw: Record<string, unknown> | null,
  at: string,
): void {
  // Without Instagram's media object (raw), fields came from DOM/meta fallbacks: lower trust, often missing or
  // truncated. They only fill gaps, so a degraded refresh never erases or downgrades what was collected before.
  const fallback = raw === null;
  const json = (values: string[]): string | null => (fallback && values.length === 0 ? null : JSON.stringify(values));
  const set = (column: string, param: string): string => `${column} = CASE WHEN @fallback = 1 THEN coalesce(${column}, @${param}) ELSE @${param} END`;
  db.transaction(() => {
    db.prepare(`UPDATE posts SET
      instagram_post_id = coalesce(@instagramPostId, instagram_post_id),
      type = CASE WHEN @type != 'unknown' THEN @type ELSE type END,
      ${[['product_type', 'productType'], ['owner_username', 'ownerUsername'], ['caption', 'caption'], ['hashtags_json', 'hashtags'],
    ['mentions_json', 'mentions'], ['tagged_users_json', 'taggedUsers'], ['coauthors_json', 'coauthors'], ['location', 'location'],
    ['published_at', 'publishedAt'], ['accessibility_caption', 'accessibilityCaption'], ['likes_count', 'likesCount'],
    ['likes_hidden', 'likesHidden'], ['comments_count', 'commentsCount'], ['comments_disabled', 'commentsDisabled'],
    ['views_count', 'viewsCount'], ['plays_count', 'playsCount'], ['duration_seconds', 'durationSeconds'], ['audio_title', 'audioTitle'],
    ['audio_artist', 'audioArtist'], ['audio_type', 'audioType'], ['thumbnail_url', 'thumbnailUrl'], ['width', 'width'],
    ['height', 'height'], ['carousel_count', 'carouselCount']].map(([column, param]) => set(column!, param!)).join(',\n      ')},
      raw_json = coalesce(@raw, raw_json),
      extraction_status = 'complete', availability = 'available', extraction_attempts = 0,
      first_scraped_at = coalesce(first_scraped_at, @at), last_scraped_at = @at, last_attempt_at = @at, updated_at = @at
      WHERE id = @postId`).run({
      ...fields,
      postId,
      at,
      fallback: Number(fallback),
      hashtags: json(fields.hashtags),
      mentions: json(fields.mentions),
      taggedUsers: json(fields.taggedUsers),
      coauthors: json(fields.coauthors),
      likesHidden: bool(fields.likesHidden),
      commentsDisabled: bool(fields.commentsDisabled),
      raw: raw ? JSON.stringify(raw) : null,
    });
    // The unique (post_id, scrape_job_id) index makes a retry within the same job a no-op. A page that showed no
    // metric at all is not an observation.
    const metrics = [fields.likesCount, fields.commentsCount, fields.viewsCount, fields.playsCount];
    if (metrics.some((value) => value !== null)) {
      db.prepare(`INSERT OR IGNORE INTO post_metrics_history (post_id, scrape_job_id, likes_count, comments_count, views_count, plays_count, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(postId, jobId, ...metrics, at);
    }
    const upsert = db.prepare(`INSERT INTO media (post_id, position, media_type, source_url, width, height, duration_seconds, alt_text, raw_json)
      VALUES (@postId, @position, @mediaType, @sourceUrl, @width, @height, @durationSeconds, @altText, @raw)
      ON CONFLICT (post_id, position) DO UPDATE SET media_type = excluded.media_type, source_url = excluded.source_url,
        width = excluded.width, height = excluded.height, duration_seconds = excluded.duration_seconds,
        alt_text = excluded.alt_text, raw_json = excluded.raw_json,
        download_status = CASE WHEN media.download_status = 'failed' AND excluded.source_url IS NOT media.source_url THEN 'pending' ELSE media.download_status END,
        last_error = CASE WHEN excluded.source_url IS NOT media.source_url THEN NULL ELSE media.last_error END,
        download_attempts = CASE WHEN excluded.source_url IS NOT media.source_url THEN 0 ELSE media.download_attempts END`);
    for (const item of items) upsert.run({ ...item, postId, raw: item.raw ? JSON.stringify(item.raw) : null });
    db.prepare(`UPDATE scrape_errors SET resolved_at = ? WHERE post_id = ? AND stage = 'extraction' AND resolved_at IS NULL`).run(at, postId);
  })();
}

/** Deleted or restricted: a permanent outcome, recorded once and not retried without --force. */
export function savePermanent(db: Database.Database, post: PendingPost, competitorId: number, availability: 'unavailable' | 'restricted', reason: string, at: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE posts SET extraction_status = ?, availability = ?, last_attempt_at = ?, last_scraped_at = ?, updated_at = ? WHERE id = ?`)
      .run(availability === 'restricted' ? 'blocked' : 'failed', availability, at, at, at, post.id);
    db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, url, stage, error_type, error_message, retryable, attempt)
      VALUES (?, ?, ?, 'extraction', ?, ?, 0, 1)`).run(competitorId, post.id, post.url, `post_${availability}`, reason);
  })();
}

/**
 * A failure after this run's retries. Batch-stopping causes (session, challenge, rate limit) and user stops
 * say nothing about the post itself, so its status is restored and its attempt count left alone.
 */
export function saveFailedAttempt(db: Database.Database, post: PendingPost, competitorId: number, failure: ScrapeFailure, countsAgainstPost: boolean): void {
  const message = failure.debugFiles.length ? `${failure.message} [debug: ${failure.debugFiles.join(', ')}]` : failure.message;
  db.transaction(() => {
    if (countsAgainstPost) {
      db.prepare(`UPDATE posts SET extraction_status = 'failed', extraction_attempts = extraction_attempts + 1,
        last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(post.id);
    } else {
      db.prepare('UPDATE posts SET extraction_status = ? WHERE id = ?').run(post.status === 'in_progress' ? 'pending' : post.status, post.id);
    }
    db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, url, stage, error_type, error_message, retryable, attempt)
      VALUES (?, ?, ?, 'extraction', ?, ?, ?, ?)`).run(competitorId, post.id, post.url, failure.type, message, Number(failure.retryable), failure.attempts);
  })();
}

const bool = (value: boolean | null): number | null => (value === null ? null : Number(value));

// ---- Browser -------------------------------------------------------------------------------------

/** Opens /p/<code>/ (it serves the full media object for Reels too) and captures everything extraction reads. */
async function capturePost(page: Page, session: Pick<InstagramSessionManager, 'inspect'>, shortcode: string): Promise<PostSnapshot> {
  const networkJson: string[] = [];
  const pending: Array<Promise<void>> = [];
  const needle = `"code":"${shortcode}"`;
  page.on('response', (response) => {
    if (!/instagram\.com\/(api\/)?graphql|instagram\.com\/api\/v1\//.test(response.url())) return;
    pending.push(response.text().then((text) => { if (text.includes(needle)) networkJson.push(text); }, () => undefined));
  });

  const response = await page.goto(`https://www.instagram.com/p/${shortcode}/`, { waitUntil: 'domcontentloaded' });
  const httpStatus = response?.status() ?? null;
  if (httpStatus === 429) throw new RateLimitedError('Instagram returned HTTP 429 (too many requests). Stopping; try again later.');
  if (httpStatus !== null && httpStatus >= 500) throw new PostExtractionError(`Instagram returned HTTP ${httpStatus}`, 'http_error', true);

  await page.waitForFunction(() => document.querySelector('main article, main h1, main time, main video, h2, input[name="password"]') !== null,
    undefined, { timeout: READY_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
  await assertStillAllowed(page, session);
  await waitForResponses(pending);

  const inPage = await page.evaluate((code) => {
    const meta: Record<string, string> = {};
    for (const tag of document.querySelectorAll('meta[property^="og:"], meta[name="description"]')) {
      const key = tag.getAttribute('property') ?? tag.getAttribute('name');
      const content = tag.getAttribute('content');
      if (key && content) meta[key] = content;
    }
    const main = document.querySelector('main') ?? document.body;
    const video = main.querySelector('video');
    const mainText = (main as HTMLElement).innerText ?? '';
    return {
      title: document.title,
      meta,
      jsonTexts: [...document.querySelectorAll('script[type="application/json"]')].map((s) => s.textContent ?? '').filter((t) => t.includes(`"code":"${code}"`)),
      dom: {
        caption: main.querySelector('h1')?.textContent ?? null,
        datetime: main.querySelector('time[datetime]')?.getAttribute('datetime') ?? null,
        likesText: mainText.match(/([\d][\d.,\s]*[KMB]?)\s+likes?\b/i)?.[0] ?? null,
        videoDuration: video && Number.isFinite(video.duration) ? video.duration : null,
        hasVideo: video !== null,
        bodyText: (document.body?.innerText ?? '').slice(0, 4000),
      },
    };
  }, shortcode);
  return { url: page.url(), httpStatus, ...inPage, jsonTexts: [...inPage.jsonTexts, ...networkJson] };
}

type Outcome =
  | { kind: 'extracted'; fields: PostFields; items: MediaItem[]; raw: Record<string, unknown> | null; sources: Record<string, string>; attempts: number }
  | { kind: 'unavailable' | 'restricted'; reason: string };

/** One post, with up to ATTEMPTS_PER_RUN tries for retryable failures. Throws PostFailure when it gives up. */
async function extractOne(context: BrowserContext, session: Pick<InstagramSessionManager, 'inspect'>, username: string, post: PendingPost, options: PostScrapeOptions): Promise<Outcome> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  for (let attempt = 1; ; attempt += 1) {
    const page = await context.newPage();
    try {
      const snapshot = await capturePost(page, session, post.shortcode);
      let result;
      try {
        result = extractPost(snapshot, post.shortcode);
      } catch (error) {
        if (error instanceof PostExtractionError && RATE_LIMIT_TEXT.test(snapshot.dom.bodyText)) {
          throw new RateLimitedError('Instagram asked to wait before trying again (rate limited). Stopping; try again later.');
        }
        throw error;
      }
      if (result.availability !== 'available') return { kind: result.availability, reason: result.reason };
      return { kind: 'extracted', fields: result.fields, items: result.items, raw: result.raw, sources: result.sources, attempts: attempt };
    } catch (error) {
      throwIfStorageError(error);
      const failure = error instanceof PostExtractionError
        ? { type: error.type, message: error.message, retryable: error.retryable, attempts: attempt, url: post.url, debugFiles: [] as string[] }
        : classify(error, attempt, post.url);
      const retry = failure.retryable && attempt < ATTEMPTS_PER_RUN && !isBatchFatal(error) && !options.signal?.aborted;
      if (retry) {
        const wait = BACKOFF_BASE_MS * 3 ** (attempt - 1);
        options.log.warn(`  ${post.shortcode}: ${failure.type} (attempt ${attempt}/${ATTEMPTS_PER_RUN}); retrying in ${wait / 1000}s`);
        await page.close().catch(() => undefined);
        await sleep(wait);
        continue;
      }
      if (!options.signal?.aborted) failure.debugFiles = await writeDebugFiles(page, `${username}-${post.shortcode}`, failure, options, 'posts');
      throw new PostFailure(failure, error);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

class PostFailure extends Error {
  constructor(readonly failure: ScrapeFailure, readonly original: unknown) {
    super(failure.message);
  }
}

// ---- Per competitor ------------------------------------------------------------------------------

/** Extracts one competitor's selected posts, saving each as soon as it is done. */
export async function scrapePosts(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitor: { id: number; username: string },
  options: PostScrapeOptions,
): Promise<PostRunSummary> {
  const { log } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const posts = selectPosts(db, competitor.id, options.force, options.limit, options.postIds);
  const summary: PostRunSummary = {
    username: competitor.username, selected: posts.length, extracted: 0, unavailable: 0, restricted: 0, failed: 0,
    alreadyComplete: options.force ? 0 : countComplete(db, competitor.id), stoppedBy: null,
  };
  if (posts.length === 0) {
    log.info(`@${competitor.username}: nothing to extract (${summary.alreadyComplete} already complete${options.force ? '' : '; --force refreshes them'}).`);
    return summary;
  }
  const interrupted = posts.filter((p) => p.status === 'in_progress').length;
  log.info(`@${competitor.username}: ${posts.length} post(s) to extract` +
    (summary.alreadyComplete ? `, ${summary.alreadyComplete} already complete (skipped)` : '') +
    (interrupted ? `, ${interrupted} resumed from an interrupted run` : '') + '.');

  const jobId = startJob(db, competitor.id, 'posts');
  db.prepare('UPDATE scrape_jobs SET total_items = ? WHERE id = ?').run(posts.length, jobId);
  const markInProgress = db.prepare(`UPDATE posts SET extraction_status = 'in_progress' WHERE id = ?`);

  for (const [index, post] of posts.entries()) {
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }
    if (index > 0) await sleep(POST_PACING_MS[0] + Math.random() * (POST_PACING_MS[1] - POST_PACING_MS[0]));
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }

    markInProgress.run(post.id);
    const label = `[${index + 1}/${posts.length}] ${post.shortcode}`;
    try {
      const outcome = await extractOne(context, session, competitor.username, post, options);
      const at = new Date().toISOString();
      if (outcome.kind === 'extracted') {
        saveExtracted(db, post.id, jobId, outcome.fields, outcome.items, outcome.raw, at);
        summary.extracted += 1;
        log.info(`${label} ${describe(outcome.fields, outcome.sources)}`);
      } else {
        savePermanent(db, post, competitor.id, outcome.kind, outcome.reason, at);
        summary[outcome.kind] += 1;
        log.warn(`${label} ${outcome.kind}: ${outcome.reason}`);
      }
    } catch (error) {
      throwIfStorageError(error);
      const failure = error instanceof PostFailure ? error.failure : classify(error, 1, post.url);
      const original = error instanceof PostFailure ? error.original : error;
      if (options.signal?.aborted) {
        db.prepare('UPDATE posts SET extraction_status = ? WHERE id = ?').run(post.status === 'in_progress' ? 'pending' : post.status, post.id);
        summary.stoppedBy = 'interrupted';
        break;
      }
      const fatal = isBatchFatal(original);
      saveFailedAttempt(db, post, competitor.id, failure, !fatal);
      log.error(`${label} ${failure.type}: ${failure.message}${failure.debugFiles.length ? ` (debug: ${failure.debugFiles.join(', ')})` : ''}`);
      if (fatal) { summary.stoppedBy = failure.type; break; }
      summary.failed += 1;
    }
    db.prepare('UPDATE scrape_jobs SET processed_items = ? WHERE id = ?').run(summary.extracted + summary.unavailable + summary.restricted, jobId);
  }

  const status = summary.stoppedBy && summary.stoppedBy !== 'interrupted' ? 'blocked' : summary.stoppedBy || summary.failed ? 'failed' : 'complete';
  finishJob(db, jobId, status, summary.stoppedBy ?? (summary.failed ? `${summary.failed} post(s) failed` : null));
  return summary;
}

function describe(f: PostFields, sources: Record<string, string>): string {
  const parts: string[] = [f.type];
  if (f.carouselCount) parts.push(`${f.carouselCount} items`);
  if (f.durationSeconds !== null) parts.push(`${f.durationSeconds}s`);
  parts.push(f.likesHidden ? 'likes hidden' : `${f.likesCount ?? '?'} likes`);
  parts.push(`${f.commentsCount ?? '?'} comments`);
  if (f.viewsCount !== null) parts.push(`${f.viewsCount} views`);
  if (f.playsCount !== null) parts.push(`${f.playsCount} plays`);
  if (f.publishedAt) parts.push(f.publishedAt.slice(0, 10));
  const fallback = Object.entries(sources).filter(([, s]) => s === 'dom' || s === 'meta').map(([k]) => k);
  return parts.join(', ') + (sources.caption === undefined && f.caption === null ? ', no caption' : '') +
    (fallback.length ? ` (from page fallback: ${fallback.join(', ')})` : '');
}

// ---- Batch ---------------------------------------------------------------------------------------

export function formatPostRun(s: PostRunSummary): string {
  return [
    `Competitor: ${s.username}`,
    '',
    `Extracted: ${s.extracted}`,
    `Unavailable (deleted): ${s.unavailable}`,
    `Restricted: ${s.restricted}`,
    `Failed (will retry on the next run, up to ${MAX_FAILED_RUNS} runs): ${s.failed}`,
    `Already complete, skipped: ${s.alreadyComplete}`,
    ...(s.stoppedBy ? [`Stopped early: ${s.stoppedBy}; ${s.selected - s.extracted - s.unavailable - s.restricted - s.failed} post(s) left for the next run`] : []),
  ].join('\n');
}

export async function scrapePostsBatch(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitors: Array<{ id: number; username: string }>,
  options: PostScrapeOptions,
): Promise<{ summaries: PostRunSummary[]; stoppedBy: string | null }> {
  const summaries: PostRunSummary[] = [];
  let stoppedBy: string | null = null;
  for (const competitor of competitors) {
    if (stoppedBy || options.signal?.aborted) break;
    if (summaries.at(-1)?.selected) await (options.sleep ?? ((ms: number) => delay(ms, options.signal)))(POST_PACING_MS[1]);
    const summary = await scrapePosts(db, context, session, competitor, options);
    summaries.push(summary);
    if (summary.selected > 0) process.stdout.write(`\n${formatPostRun(summary)}\n\n`);
    stoppedBy = summary.stoppedBy;
  }
  return { summaries, stoppedBy };
}
