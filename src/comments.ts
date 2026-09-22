// Optional comment collection (npm run scrape:comments). Kept apart from the metadata path: it has its own
// status columns on `posts` (comments_*), never touches extraction_status, and a failure here is recorded
// against the comment run only.
//
// Sources, in order of trust: Instagram's own JSON (network responses and inline script data) > the visible
// comment list (fallback, used only when no JSON comments were seen). Only what the comment UI shows is
// kept: username, text, time, like count, reply link, and Instagram's comment id.

import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { BrowserContext, Page } from 'playwright';
import { waitForResponses } from './browser.js';
import type { InstagramSessionManager } from './instagram-session.js';
import {
  assertStillAllowed, classify, delay, finishJob, isBatchFatal, PACING_MS, RateLimitedError, startJob, writeDebugFiles,
  type ScrapeFailure, type ScrapeOptions,
} from './profile-scraper.js';
import { MAX_FAILED_RUNS } from './post-scraper.js';

const READY_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_500;
const SEEN_COMMENT_KEYS = /"comment_like_count"|"child_comment_count"|"edge_liked_by"/;
const OWN_COMMENTS_CONNECTION = /"xdt_api__v1__media__media_id__comments__connection"/;
export const DEFAULT_COMMENT_LIMIT = 100;

export interface CommentLimits {
  maxRounds: number;
  maxIdleRounds: number;
  maxSeconds: number;
  roundDelayMs: number;
}

export interface CommentOptions extends ScrapeOptions {
  /** null = `--limit all` (the safety limits still apply). */
  limit: number | null;
  force: boolean;
  limits: CommentLimits;
  /** Only these posts, whatever their comment status (used by retry:failed). */
  postIds?: number[];
  /** Test hook; production uses https://www.instagram.com. */
  baseUrl?: string;
}

// ---- Parsing (pure) ------------------------------------------------------------------------------

export interface ParsedComment {
  id: string | null;
  parentId: string | null;
  username: string;
  text: string;
  likes: number | null;
  publishedAt: string | null;
  /** Public comment fields only, not the full API object. */
  raw: Record<string, unknown>;
}

export interface CommentsPage {
  comments: ParsedComment[];
  /** Whether Instagram says more top-level comments exist; null when the payload does not say. */
  hasMore: boolean | null;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const idString = (value: unknown): string | null => (typeof value === 'string' && value !== '' && value !== '0') || typeof value === 'number' ? String(value) : null;

function isoTime(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A comment object, in either the REST (`user`, `comment_like_count`) or the older GraphQL (`owner`, `edge_liked_by`) shape. */
function asComment(obj: Obj, parentId: string | null): ParsedComment | null {
  const who = isObj(obj.user) ? obj.user : isObj(obj.owner) ? obj.owner : null;
  const username = typeof who?.username === 'string' ? who.username : '';
  const text = typeof obj.text === 'string' ? obj.text : '';
  const likeCount = typeof obj.comment_like_count === 'number' ? obj.comment_like_count : isObj(obj.edge_liked_by) && typeof obj.edge_liked_by.count === 'number' ? obj.edge_liked_by.count : null;
  // The post caption has the same text/user/created_at shape; comments also carry engagement counters.
  const looksLikeComment = likeCount !== null || typeof obj.child_comment_count === 'number';
  if (!username || !text.trim() || !looksLikeComment) return null;
  const id = idString(obj.pk ?? obj.id);
  const parent = idString(obj.parent_comment_id) ?? parentId;
  const publishedAt = isoTime(obj.created_at ?? obj.created_at_utc);
  return {
    id, parentId: parent, username, text, likes: likeCount, publishedAt,
    raw: {
      id, username, text, created_at: publishedAt, comment_like_count: likeCount, parent_comment_id: parent,
      child_comment_count: typeof obj.child_comment_count === 'number' ? obj.child_comment_count : null,
      is_verified: typeof who?.is_verified === 'boolean' ? who.is_verified : null,
    },
  };
}

/** Finds every comment anywhere in a JSON payload, with replies linked to the comment they sit under. */
export function parseCommentsPayload(payload: unknown): CommentsPage {
  const comments: ParsedComment[] = [];
  let hasMore: boolean | null = null;
  const walk = (node: unknown, parentId: string | null, depth: number, inReplies = false): void => {
    if (depth > 40 || typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, parentId, depth + 1, inReplies); return; }
    const obj = node as Obj;
    const comment = asComment(obj, parentId);
    if (comment) comments.push(comment);
    // Inspect the outer connection first. An exhausted replies connection cannot end the top-level thread.
    if (!comment && !inReplies && hasMore === null) {
      const pageInfo = isObj(obj.page_info) ? obj.page_info : null;
      if (typeof obj.has_more_comments === 'boolean') hasMore = obj.has_more_comments;
      else if (typeof pageInfo?.has_next_page === 'boolean') hasMore = pageInfo.has_next_page;
      else if ('next_min_id' in obj || 'next_max_id' in obj) hasMore = Boolean(obj.next_min_id ?? obj.next_max_id);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'caption' || key === 'user' || key === 'owner') continue;
      walk(value, comment ? comment.id ?? parentId : parentId, depth + 1, inReplies || comment !== null);
    }
  };
  walk(payload, null, 0);
  return { comments, hasMore };
}

export function parseCommentsText(text: string): CommentsPage {
  try {
    return parseCommentsPayload(JSON.parse(text.replace(/^for \(;;\);/, '')));
  } catch {
    return { comments: [], hasMore: null };
  }
}

/** A mixed page payload may contain comments for several posts; keep only the matching media object. */
export function parsePostCommentsText(text: string, shortcode: string, instagramPostId: string | null): CommentsPage {
  let payload: unknown;
  try { payload = JSON.parse(text.replace(/^for \(;;\);/, '')); } catch { return { comments: [], hasMore: null }; }
  const matches: unknown[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 40) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (!isObj(node)) return;
    if (node.code === shortcode || (instagramPostId && (String(node.pk) === instagramPostId || String(node.id) === instagramPostId))) {
      matches.push(node);
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(payload, 0);
  const pages = matches.map(parseCommentsPayload);
  return { comments: pages.flatMap((page) => page.comments), hasMore: pages.find((page) => page.hasMore !== null)?.hasMore ?? null };
}

const commentKey = (c: Pick<ParsedComment, 'id' | 'username' | 'text' | 'publishedAt'>): string => c.id ?? `${c.username}\u0000${c.text}\u0000${c.publishedAt ?? ''}`;

// ---- Stop decision (pure) ------------------------------------------------------------------------

export interface StopState {
  /** Comments saved for this post, including earlier runs. */
  total: number;
  limit: number | null;
  rounds: number;
  /** Consecutive rounds that showed nothing new this run. */
  idleRounds: number;
  hasMore: boolean | null;
  /** False once a round found neither a load-more control nor anything left to scroll. */
  moreControl: boolean;
  elapsedMs: number;
  aborted: boolean;
}

export type Decision =
  | { action: 'continue' }
  | { action: 'stop'; completion: 'complete' | 'partial'; reason: string };

/** Every branch that ends a post; the caps below are what stop `--limit all` from looping forever. */
export function decide(s: StopState, limits: CommentLimits): Decision {
  if (s.aborted) return { action: 'stop', completion: 'partial', reason: 'interrupted' };
  if (s.limit !== null && s.total >= s.limit) return { action: 'stop', completion: 'partial', reason: 'limit_reached' };
  if (s.hasMore === false) return { action: 'stop', completion: 'complete', reason: 'end_of_comments' };
  if (s.idleRounds >= 1 && !s.moreControl && s.hasMore !== true) return { action: 'stop', completion: 'complete', reason: 'end_of_comments' };
  if (s.idleRounds >= limits.maxIdleRounds) return { action: 'stop', completion: 'partial', reason: 'stalled' };
  if (s.rounds >= limits.maxRounds) return { action: 'stop', completion: 'partial', reason: 'max_rounds' };
  if (s.elapsedMs >= limits.maxSeconds * 1000) return { action: 'stop', completion: 'partial', reason: 'time_limit' };
  return { action: 'continue' };
}

export interface CollectResult { completion: 'complete' | 'partial'; reason: string; interrupted: boolean }

/** Turns the stop decision into what is recorded. Finding nothing is complete only when the post claims no comments. */
export function finalOutcome(decision: Extract<Decision, { action: 'stop' }>, saved: number, commentsCount: number | null): CollectResult {
  const interrupted = decision.reason === 'interrupted';
  if (decision.reason === 'end_of_comments') {
    if (saved === 0 && commentsCount !== 0) return { completion: 'partial', reason: 'none_visible', interrupted };
    if (commentsCount !== null && saved < commentsCount) return { completion: 'partial', reason: 'count_mismatch', interrupted };
    if (saved === 0) return { completion: 'complete', reason: 'no_comments', interrupted };
  }
  return { completion: decision.completion, reason: decision.reason, interrupted };
}

// ---- Persistence ---------------------------------------------------------------------------------

export interface CommentPost {
  id: number;
  instagramPostId: string | null;
  shortcode: string;
  url: string;
  status: string;
  caption: string | null;
  commentsCount: number | null;
  commentsDisabled: number | null;
  collected: number;
}

const now = (): string => new Date().toISOString();
const savedCount = (db: Database.Database, postId: number): number =>
  (db.prepare('SELECT count(*) AS n FROM comments WHERE post_id = ?').get(postId) as { n: number }).n;

/**
 * Saves a batch in one transaction and returns how many rows are new. Same Instagram id, or (without an id)
 * same user + text + time, is the same comment: it is never inserted twice. A comment first read from the page
 * without an id is upgraded in place when the JSON later supplies the id.
 */
export function saveComments(db: Database.Database, postId: number, batch: ParsedComment[], limit: number | null = null): number {
  const exists = db.prepare('SELECT 1 FROM comments WHERE post_id = ? AND instagram_comment_id = ?');
  const twin = db.prepare('SELECT 1 FROM comments WHERE post_id = ? AND username = ? AND text = ? AND published_at IS ?');
  const upgrade = db.prepare(`UPDATE comments SET instagram_comment_id = @id, likes_count = @likes, parent_comment_id = @parentId, raw_json = @raw
    WHERE post_id = @postId AND username = @username AND text = @text AND published_at IS @publishedAt AND instagram_comment_id IS NULL`);
  const insert = db.prepare(`INSERT INTO comments (post_id, instagram_comment_id, username, text, likes_count, published_at, parent_comment_id, raw_json)
    VALUES (@postId, @id, @username, @text, @likes, @publishedAt, @parentId, @raw)`);
  const refresh = db.prepare(`UPDATE comments SET likes_count = @likes, raw_json = @raw WHERE post_id = @postId AND instagram_comment_id = @id`);
  let added = 0;
  db.transaction(() => {
    const room = limit === null ? Infinity : Math.max(0, limit - savedCount(db, postId));
    for (const c of batch) {
      const row = { postId, id: c.id, username: c.username, text: c.text, likes: c.likes, publishedAt: c.publishedAt, parentId: c.parentId, raw: JSON.stringify(c.raw) };
      if (c.id) {
        if (exists.get(postId, c.id)) refresh.run(row);
        else if (upgrade.run(row).changes === 0 && added < room) { insert.run(row); added += 1; }
      } else if (!twin.get(postId, c.username, c.text, c.publishedAt) && !(c.publishedAt === null && db.prepare(
        'SELECT 1 FROM comments WHERE post_id = ? AND username = ? AND text = ?').get(postId, c.username, c.text))) {
        if (added < room) { insert.run(row); added += 1; }
      }
    }
    db.prepare('UPDATE posts SET comments_collected = (SELECT count(*) FROM comments WHERE post_id = ?), comments_last_collected_at = ? WHERE id = ?').run(postId, now(), postId);
  })();
  return added;
}

/** A finished run for one post (any completion): status, counters, stop reason; earlier comment errors resolved. */
export function finishPost(db: Database.Database, post: CommentPost, completion: 'complete' | 'partial', reason: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE posts SET comments_status = 'complete', comments_completion = ?, comments_stop_reason = ?,
      comments_attempts = CASE WHEN ? = 'partial' AND ? != 'limit_reached' THEN comments_attempts + 1 ELSE 0 END,
      comments_collected = ?, comments_last_collected_at = ? WHERE id = ?`).run(completion, reason, completion, reason, savedCount(db, post.id), now(), post.id);
    db.prepare(`UPDATE scrape_errors SET resolved_at = ? WHERE post_id = ? AND stage = 'comments' AND resolved_at IS NULL`).run(now(), post.id);
  })();
}

/**
 * A failed comment attempt. Comments saved before the failure are kept. Batch-stopping causes (session,
 * challenge, rate limit) and Ctrl-C say nothing about the post, so its status is restored and no attempt counted.
 * posts.extraction_status is never touched.
 */
export function failPost(db: Database.Database, post: CommentPost, competitorId: number, failure: ScrapeFailure, countsAgainstPost: boolean): void {
  const message = failure.debugFiles.length ? `${failure.message} [debug: ${failure.debugFiles.join(', ')}]` : failure.message;
  db.transaction(() => {
    if (countsAgainstPost) {
      db.prepare(`UPDATE posts SET comments_status = 'failed', comments_attempts = comments_attempts + 1, comments_stop_reason = ?,
        comments_collected = ?, comments_last_collected_at = ? WHERE id = ?`).run(failure.type, savedCount(db, post.id), now(), post.id);
    } else {
      db.prepare('UPDATE posts SET comments_status = ?, comments_collected = ? WHERE id = ?').run(post.status === 'in_progress' ? 'pending' : post.status, savedCount(db, post.id), post.id);
    }
    db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, url, stage, error_type, error_message, retryable, attempt)
      VALUES (?, ?, ?, 'comments', ?, ?, ?, ?)`).run(competitorId, post.id, post.url, failure.type, message, Number(failure.retryable), failure.attempts);
  })();
}

/**
 * Posts still worth visiting, in discovery order. Default: never attempted, interrupted, failed under the retry
 * cap, and partial posts that could yield more (this run's limit is above what is saved, or is `all`).
 * Comments are optional, so only posts with complete metadata that are still available are considered.
 */
export function selectCommentPosts(db: Database.Database, competitorId: number, limit: number | null, force: boolean, postIds?: number[]): CommentPost[] {
  const eligible = postIds ? `p.id IN (${postIds.map(Number).join(',') || 'NULL'})` : `(@force = 1 OR p.comments_status IN ('pending', 'in_progress')
        OR (p.comments_status = 'failed' AND p.comments_attempts < @max)
        OR (p.comments_status = 'complete' AND p.comments_completion = 'partial' AND p.comments_attempts < @max
          AND (@limit IS NULL OR p.comments_collected < @limit)))`;
  const rows = db.prepare(`SELECT p.id, p.shortcode, p.instagram_post_id AS instagramPostId, p.url, p.comments_status AS status, p.caption, p.comments_count AS commentsCount,
      p.comments_disabled AS commentsDisabled, p.comments_collected AS collected
    FROM posts p
    WHERE (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
      AND p.extraction_status = 'complete' AND p.availability = 'available'
      AND ${eligible}
    ORDER BY p.id`).all({ cid: competitorId, force: Number(force), max: MAX_FAILED_RUNS, limit });
  return rows as CommentPost[];
}

// ---- Browser -------------------------------------------------------------------------------------

interface DomComment { username: string; text: string; datetime: string | null }

/** The visible top-level comments. Replies sit in a nested list and are skipped here. */
async function readDomComments(page: Page): Promise<DomComment[]> {
  return page.evaluate(() => {
    const out: Array<{ username: string; text: string; datetime: string | null }> = [];
    for (const li of document.querySelectorAll('main ul li')) {
      const list = li.parentElement;
      if (!list || list.closest('li')) continue;
      const time = li.querySelector('time[datetime]');
      const username = li.querySelector('a[href^="/"]')?.getAttribute('href')?.match(/^\/([A-Za-z0-9._]{1,30})\/$/)?.[1];
      if (!time || !username || time.closest('ul') !== list) continue;
      const span = [...li.querySelectorAll('span[dir="auto"]')].find((s) => s.closest('ul') === list && !s.closest('a, time, button') && (s.textContent ?? '').trim() && s.textContent !== username);
      if (span) out.push({ username, text: (span.textContent ?? '').trim(), datetime: time.getAttribute('datetime') });
    }
    return out;
  });
}

/**
 * One step towards more comments: click a "load more comments" control, else scroll the comment list.
 * Reply expanders ("View replies") are never clicked, so replies stay collapsed unless Instagram sent them.
 */
async function loadMore(page: Page): Promise<'click' | 'scroll' | null> {
  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-cc-more]').forEach((el) => el.removeAttribute('data-cc-more'));
    const label = (el: Element): string => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
    const control = [...document.querySelectorAll('main button, main [role="button"], main [aria-label]')]
      .find((el) => /(load|view) more comments/i.test(label(el)) && !/repl/i.test(label(el)) && !el.closest('li li'));
    if (!control) return false;
    (control.closest('button, [role="button"]') ?? control).setAttribute('data-cc-more', '1');
    return true;
  });
  if (marked) {
    await page.locator('[data-cc-more]').first().click({ timeout: 5_000 });
    return 'click';
  }
  const moved = await page.evaluate(() => {
    const scrollable = (el: Element): boolean => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
    const scroll = (el: Element): boolean => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return el.scrollTop !== before;
    };
    const list = [...document.querySelectorAll('main ul')].find((ul) => ul.querySelector('time'));
    for (let el: Element | null = list ?? null; el; el = el.parentElement) if (scrollable(el)) return scroll(el);
    // Current layout (2026): no lists; the comment panel is a scrollable div holding the comment times, and
    // scrolling it to the bottom loads the next page of comments.
    const panel = [...document.querySelectorAll('main div')].find((el) => scrollable(el) && el.querySelector('time'));
    return panel ? scroll(panel) : false;
  });
  return moved ? 'scroll' : null;
}

class CommentFailure extends Error {
  constructor(readonly failure: ScrapeFailure, readonly original: unknown) {
    super(failure.message);
  }
}

/** Opens the post once and collects until `decide` says stop. Comments are saved after every round. */
async function collectOne(context: BrowserContext, session: Pick<InstagramSessionManager, 'inspect'>, db: Database.Database, username: string, post: CommentPost, options: CommentOptions): Promise<CollectResult> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const page = await context.newPage();
  try {
    const queue: ParsedComment[] = [];
    const pending: Array<Promise<void>> = [];
    let hasMore: boolean | null = null;
    let jsonSeen = false;
    let rateLimited = false;
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      const direct = path.match(/^\/api\/v1\/media\/([^/]+)\/comments(?:\/|$)/)?.[1];
      if (!direct && !/\/(api\/)?graphql/.test(path)) return;
      if (response.status() === 429) rateLimited = true;
      const request = `${response.url()} ${response.request().postData() ?? ''}`;
      const scoped = direct === post.shortcode || direct === post.instagramPostId ||
        request.includes(post.shortcode) || (post.instagramPostId !== null && request.includes(post.instagramPostId));
      pending.push(response.text().then((text) => {
        const parsed = scoped
          ? parseCommentsText(text) : parsePostCommentsText(text, post.shortcode, post.instagramPostId);
        if (parsed.comments.length) { jsonSeen = true; queue.push(...parsed.comments); }
        if (parsed.hasMore !== null) hasMore = parsed.hasMore;
      }, () => undefined));
    });

    const response = await page.goto(`${options.baseUrl ?? 'https://www.instagram.com'}/p/${post.shortcode}/`, { waitUntil: 'domcontentloaded' });
    if (response?.status() === 429) throw new RateLimitedError('Instagram returned HTTP 429 (too many requests). Stopping; try again later.');
    if (response && response.status() >= 400) throw new Error(`Comments page returned HTTP ${response.status()}`);
    await page.waitForFunction(() => document.querySelector('main article, main h1, main time, main video, h2, input[name="password"]') !== null,
      undefined, { timeout: READY_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    await assertStillAllowed(page, session);

    const seen = new Set<string>();
    const started = Date.now();
    let total = savedCount(db, post.id);
    let rounds = 0;
    let idleRounds = 0;
    let moreControl = true;
    for (;;) {
      await assertStillAllowed(page, session);
      await waitForResponses(pending.splice(0));
      if (rateLimited) throw new RateLimitedError('Instagram answered a comments request with HTTP 429. Stopping; try again later.');
      if (rounds === 0) {
        const inline = await page.evaluate(() => [...document.querySelectorAll('script[type="application/json"]')].map((s) => s.textContent ?? ''));
        // The post page embeds its first comment page as a media-id comments connection that names neither the
        // shortcode nor the media id. Exactly one such block is this post's; any other comment JSON must name the post.
        const own = inline.filter((text) => OWN_COMMENTS_CONNECTION.test(text));
        for (const text of inline) {
          if (!SEEN_COMMENT_KEYS.test(text)) continue;
          const p = own.length === 1 && text === own[0] ? parseCommentsText(text) : parsePostCommentsText(text, post.shortcode, post.instagramPostId);
          if (p.comments.length) { jsonSeen = true; queue.push(...p.comments); }
          if (p.hasMore !== null) hasMore = p.hasMore;
        }
      }
      const found: ParsedComment[] = queue.splice(0);
      if (!jsonSeen) {
        const caption = post.caption?.trim();
        for (const d of await readDomComments(page)) {
          if (caption && d.text === caption) continue; // the caption is listed first on the post page
          const at = d.datetime ? new Date(d.datetime) : null;
          const publishedAt = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
          found.push({ id: null, parentId: null, username: d.username, text: d.text, likes: null, publishedAt, raw: { source: 'dom', username: d.username, text: d.text, datetime: d.datetime } });
        }
      }
      const fresh = found.filter((c) => { const key = commentKey(c); if (seen.has(key)) return false; seen.add(key); return true; });
      idleRounds = fresh.length ? 0 : idleRounds + 1;
      // Honor the limit exactly: saved comments (earlier runs included) plus this batch never exceed it.
      if (fresh.length) saveComments(db, post.id, fresh, options.limit);
      total = savedCount(db, post.id);
      if (fresh.length) options.log.debug(`  ${post.shortcode}: +${fresh.length} (${total} saved)`);

      const decision = decide({ total, limit: options.limit, rounds, idleRounds, hasMore, moreControl, elapsedMs: Date.now() - started, aborted: options.signal?.aborted === true }, options.limits);
      if (decision.action === 'stop') return finalOutcome(decision, total, post.commentsCount);
      moreControl = (await loadMore(page)) !== null;
      rounds += 1;
      await sleep(options.limits.roundDelayMs * (0.75 + Math.random() * 0.5));
    }
  } catch (error) {
    throwIfStorageError(error);
    const failure = classify(error, 1, post.url);
    if (!options.signal?.aborted && !isBatchFatal(error)) failure.debugFiles = await writeDebugFiles(page, `${username}-${post.shortcode}`, failure, options, 'comments');
    throw new CommentFailure(failure, error);
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ---- Per competitor ------------------------------------------------------------------------------

export interface CommentRunSummary {
  username: string;
  selected: number;
  /** New comment rows saved this run. */
  collected: number;
  complete: number;
  partial: number;
  failed: number;
  stoppedBy: string | null;
}

export async function scrapeComments(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitor: { id: number; username: string },
  options: CommentOptions,
): Promise<CommentRunSummary> {
  const { log } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const posts = selectCommentPosts(db, competitor.id, options.limit, options.force, options.postIds);
  const summary: CommentRunSummary = { username: competitor.username, selected: posts.length, collected: 0, complete: 0, partial: 0, failed: 0, stoppedBy: null };
  if (posts.length === 0) {
    log.info(`@${competitor.username}: no posts need comment collection (${options.force ? 'none extracted' : 'use --force to recollect'}).`);
    return summary;
  }
  log.info(`@${competitor.username}: ${posts.length} post(s) for comments, ${options.limit === null ? 'no comment limit (safety limits apply)' : `up to ${options.limit} each`}.`);
  const jobId = startJob(db, competitor.id, 'comments');
  db.prepare('UPDATE scrape_jobs SET total_items = ? WHERE id = ?').run(posts.length, jobId);
  const setStatus = db.prepare('UPDATE posts SET comments_status = ? WHERE id = ?');
  let visited = false;

  for (const [index, post] of posts.entries()) {
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }
    const label = `[${index + 1}/${posts.length}] ${post.shortcode}`;

    // Answerable from saved metadata: no page load.
    if (post.commentsDisabled === 1 || post.commentsCount === 0) {
      finishPost(db, post, 'complete', post.commentsDisabled === 1 ? 'comments_disabled' : 'no_comments');
      summary.complete += 1;
      log.info(`${label} ${post.commentsDisabled === 1 ? 'comments are turned off' : 'no comments'}`);
      continue;
    }

    if (visited) await sleep(PACING_MS[0] + Math.random() * (PACING_MS[1] - PACING_MS[0]));
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }
    visited = true;
    setStatus.run('in_progress', post.id);
    const before = savedCount(db, post.id);
    try {
      const result = await collectOne(context, session, db, competitor.username, post, options);
      const gained = savedCount(db, post.id) - before;
      summary.collected += gained;
      if (result.interrupted) {
        setStatus.run(post.status === 'in_progress' ? 'pending' : post.status, post.id);
        db.prepare('UPDATE posts SET comments_collected = ? WHERE id = ?').run(savedCount(db, post.id), post.id);
        summary.stoppedBy = 'interrupted';
        break;
      }
      finishPost(db, post, result.completion, result.reason);
      summary[result.completion] += 1;
      log.info(`${label} ${result.completion}: +${gained} new, ${savedCount(db, post.id)} saved (${result.reason})`);
    } catch (error) {
      throwIfStorageError(error);
      const failure = error instanceof CommentFailure ? error.failure : classify(error, 1, post.url);
      const original = error instanceof CommentFailure ? error.original : error;
      summary.collected += savedCount(db, post.id) - before;
      if (options.signal?.aborted) {
        failPost(db, post, competitor.id, failure, false);
        summary.stoppedBy = 'interrupted';
        break;
      }
      const fatal = isBatchFatal(original);
      failPost(db, post, competitor.id, failure, !fatal);
      log.error(`${label} ${failure.type}: ${failure.message}${failure.debugFiles.length ? ` (debug: ${failure.debugFiles.join(', ')})` : ''}`);
      if (fatal) { summary.stoppedBy = failure.type; break; }
      summary.failed += 1;
    }
    db.prepare('UPDATE scrape_jobs SET processed_items = ? WHERE id = ?').run(summary.complete + summary.partial, jobId);
  }

  const status = summary.stoppedBy && summary.stoppedBy !== 'interrupted' ? 'blocked' : summary.stoppedBy || summary.failed ? 'failed' : 'complete';
  finishJob(db, jobId, status, summary.stoppedBy ?? (summary.failed ? `${summary.failed} post(s) failed` : null));
  return summary;
}

export function formatCommentRun(s: CommentRunSummary): string {
  return [
    `Competitor: ${s.username}`,
    '',
    `Posts visited: ${s.selected}`,
    `New comments saved: ${s.collected}`,
    `Complete (everything visible collected): ${s.complete}`,
    `Partial (stopped by a limit; rerun with a higher --limit to continue): ${s.partial}`,
    `Failed (retried on the next run, up to ${MAX_FAILED_RUNS} runs): ${s.failed}`,
    ...(s.stoppedBy ? [`Stopped early: ${s.stoppedBy}`] : []),
  ].join('\n');
}

export async function scrapeCommentsBatch(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitors: Array<{ id: number; username: string }>,
  options: CommentOptions,
): Promise<{ summaries: CommentRunSummary[]; stoppedBy: string | null }> {
  const summaries: CommentRunSummary[] = [];
  let stoppedBy: string | null = null;
  for (const competitor of competitors) {
    if (stoppedBy || options.signal?.aborted) break;
    const summary = await scrapeComments(db, context, session, competitor, options);
    summaries.push(summary);
    if (summary.selected > 0) process.stdout.write(`\n${formatCommentRun(summary)}\n\n`);
    stoppedBy = summary.stoppedBy;
  }
  return { summaries, stoppedBy };
}
