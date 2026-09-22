import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import { waitForResponses } from './browser.js';
import type { InstagramSessionManager } from './instagram-session.js';
import {
  assertStillAllowed, classify, delay, finishJob, isBatchFatal, openProfile, PACING_MS, ProfileScrapeError, profileUrl, 
  saveFailure, saveProfile, startJob, writeDebugFiles, type ScrapeFailure, type ScrapeOptions,
} from './profile-scraper.js';

// In incremental mode (the profile was walked to the end before), this many already-known posts in a row
// means we have caught up. Pinned posts (up to 3, often old) sit at the top of the grid, so it must exceed 3.
const KNOWN_STREAK_TO_STOP = 24;
// Hard ceiling so a misbehaving page can never scroll forever (~12 posts per scroll => ~24k posts).
const MAX_SCROLLS = 2_000;
// One recovery attempt before giving up: a long pause and an up-then-down scroll to retrigger loading.
const RECOVERY_WAIT_MS = 30_000;
// Extra time allowed while a timeline request is still in flight before a scroll counts as idle.
const IN_FLIGHT_WAIT_MS = 15_000;

export type PostType = 'image' | 'carousel' | 'reel' | 'unknown';
export interface DiscoveredPost { shortcode: string; url: string; type: PostType }

export interface DiscoveryOptions extends ScrapeOptions {
  scrollDelayMs: number;
  maxIdleScrolls: number;
  /** Walk to the end even if an earlier run already did. */
  full: boolean;
}

export interface DiscoveryCheckpoint {
  version: 1;
  status: 'in_progress' | 'complete' | 'incomplete';
  /** When a run last reached the end of the profile (or caught up after one did). Enables incremental mode. */
  completedAt: string | null;
  lastRunAt: string;
  endReason: string | null;
  /** Oldest post reached by the most recent run, in grid order. Logged when a resumed run passes it. */
  deepestShortcode: string | null;
  lastRun: { mode: 'full' | 'incremental'; seen: number; new: number; known: number; scrolls: number };
}

export interface DiscoveryResult {
  username: string;
  mode: 'full' | 'incremental' | 'skipped';
  status: DiscoveryCheckpoint['status'] | 'private' | 'unavailable';
  endReason: string;
  seen: number;
  new: number;
  known: number;
  savedForCompetitor: number;
  profilePostsCount: number | null;
}

// ---- URL and response parsing (pure) -------------------------------------------------------------

const POST_PATH = /^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})\/?$/;

/**
 * Accepts absolute or relative post links, with or without a /<username>/ prefix, query or fragment.
 * Returns the canonical URL (/reel/ for Reels, /p/ for everything else) and the shortcode.
 */
export function normalizePostUrl(href: string): DiscoveredPost | null {
  let url: URL;
  try {
    url = new URL(href, 'https://www.instagram.com/');
  } catch {
    return null;
  }
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(POST_PATH);
  if (!match?.[1] || !match[2]) return null;
  const reel = match[1] === 'reel' || match[1] === 'reels';
  const shortcode = match[2];
  return { shortcode, url: `https://www.instagram.com/${reel ? 'reel' : 'p'}/${shortcode}/`, type: reel ? 'reel' : 'unknown' };
}

export interface TimelinePage { posts: DiscoveredPost[]; hasNextPage: boolean | null }

/**
 * Pulls the profile grid pages out of an Instagram GraphQL response. Only connections whose key names the
 * user timeline are used; the home feed (`feed__timeline__connection`) also arrives on profile pages.
 */
export function parseTimelineResponse(text: string): TimelinePage[] {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^for \(;;\);/, ''));
  } catch {
    return [];
  }
  const pages: TimelinePage[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value !== 'object' || value === null || depth > 40) return;
    for (const [key, child] of Object.entries(value)) {
      if (/user_timeline|ordered_timeline/i.test(key) && isConnection(child)) {
        const posts = child.edges.flatMap((edge) => {
          const node = edge && typeof edge === 'object' ? (edge as { node?: Record<string, unknown> }).node : undefined;
          const code = node?.code;
          if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,}$/.test(code)) return [];
          const type = mediaType(node!);
          return [{ shortcode: code, url: `https://www.instagram.com/${type === 'reel' ? 'reel' : 'p'}/${code}/`, type }];
        });
        const hasNext = (child.page_info as Record<string, unknown> | undefined)?.has_next_page;
        pages.push({ posts, hasNextPage: typeof hasNext === 'boolean' ? hasNext : null });
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(json, 0);
  return pages;
}

function isConnection(value: unknown): value is { edges: unknown[]; page_info?: unknown } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { edges?: unknown }).edges);
}

function mediaType(node: Record<string, unknown>): PostType {
  if (node.media_type === 8) return 'carousel';
  if (node.product_type === 'clips') return 'reel';
  if (node.media_type === 1) return 'image';
  return 'unknown';
}

// ---- When to stop (pure) --------------------------------------------------------------------------

export interface LoopState {
  mode: 'full' | 'incremental';
  scrolls: number;
  idle: number;
  maxIdle: number;
  recoveryUsed: boolean;
  /** has_next_page from the latest user-timeline response, or null if none was seen. */
  hasNextPage: boolean | null;
  knownStreak: number;
  /** Distinct posts observed during this walk; historical rows do not prove today's grid is complete. */
  seenThisRun: number;
  profilePostsCount: number | null;
  aborted: boolean;
}

export type LoopDecision =
  | { action: 'continue' }
  | { action: 'recover' }
  | { action: 'stop'; status: 'complete' | 'incomplete'; reason: string };

/**
 * The end of the grid must be confirmed, never assumed from one quiet scroll:
 * 1. Instagram's own `has_next_page: false` is the definitive signal.
 * 2. Otherwise, `maxIdle` scrolls in a row with nothing unseen; then the saved count is compared with the
 *    profile's post count. A shortfall earns one recovery pass before the run is recorded as incomplete.
 */
export function decide(state: LoopState): LoopDecision {
  if (state.aborted) return { action: 'stop', status: 'incomplete', reason: 'interrupted' };
  if (state.hasNextPage === false) return { action: 'stop', status: 'complete', reason: 'end_of_profile' };
  if (state.mode === 'incremental' && state.knownStreak >= KNOWN_STREAK_TO_STOP) {
    return { action: 'stop', status: 'complete', reason: 'caught_up' };
  }
  if (state.profilePostsCount === 0 && state.seenThisRun === 0 && state.hasNextPage !== true) return { action: 'stop', status: 'complete', reason: 'no_posts' };
  if (state.scrolls >= MAX_SCROLLS) return { action: 'stop', status: 'incomplete', reason: 'scroll_limit' };
  if (state.idle < state.maxIdle) return { action: 'continue' };

  if (state.hasNextPage !== true && state.profilePostsCount !== null && state.seenThisRun >= state.profilePostsCount) {
    return { action: 'stop', status: 'complete', reason: 'all_posts_found' };
  }
  if (!state.recoveryUsed) return { action: 'recover' };
  const reason = state.hasNextPage === true ? 'loading_stalled' : state.profilePostsCount === null ? 'end_unverified' : 'posts_missing';
  return { action: 'stop', status: 'incomplete', reason };
}

// ---- Persistence -----------------------------------------------------------------------------------

export interface SavedFlag {
  isNew: boolean;
  /** When this competitor was first linked to the post (null for new posts). */
  knownSince: string | null;
}

/**
 * Saves a batch in one short transaction. "New" means not yet linked to this competitor; a post already saved
 * under another competitor (a collab) gets a link, not a second row. Returns a flag per post, in order.
 */
export function saveDiscovered(db: Database.Database, competitorId: number, posts: DiscoveredPost[]): SavedFlag[] {
  const findPost = db.prepare('SELECT id, competitor_id AS competitorId, discovered_at AS discoveredAt FROM posts WHERE shortcode = ?');
  const linkedAt = db.prepare('SELECT discovered_at AS at FROM competitor_posts WHERE competitor_id = ? AND post_id = ?');
  const insertPost = db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, discovery_status)
    VALUES (?, ?, ?, ?, 'complete')`);
  const fillType = db.prepare(`UPDATE posts SET type = ? WHERE id = ? AND type = 'unknown' AND ? != 'unknown'`);
  const link = db.prepare('INSERT OR IGNORE INTO competitor_posts (competitor_id, post_id) VALUES (?, ?)');
  return db.transaction(() => posts.map((post): SavedFlag => {
    const existing = findPost.get(post.shortcode) as { id: number; competitorId: number | null; discoveredAt: string } | undefined;
    if (!existing) {
      const id = insertPost.run(competitorId, post.shortcode, post.url, post.type).lastInsertRowid;
      link.run(competitorId, id);
      return { isNew: true, knownSince: null };
    }
    const link_ = linkedAt.get(competitorId, existing.id) as { at: string } | undefined;
    const knownSince = link_?.at ?? (existing.competitorId === competitorId ? existing.discoveredAt : null);
    fillType.run(post.type, existing.id, post.type);
    link.run(competitorId, existing.id);
    return { isNew: knownSince === null, knownSince };
  }))();
}

export function countSaved(db: Database.Database, competitorId: number): number {
  return (db.prepare(`SELECT count(*) AS n FROM posts p WHERE p.competitor_id = ?
    OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = ?)`)
    .get(competitorId, competitorId) as { n: number }).n;
}

export function readCheckpoint(db: Database.Database, competitorId: number): DiscoveryCheckpoint | null {
  const row = db.prepare("SELECT cursor_json AS json FROM collection_checkpoints WHERE competitor_id = ? AND stage = 'discovery'")
    .get(competitorId) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as DiscoveryCheckpoint : null;
}

export function writeCheckpoint(db: Database.Database, competitorId: number, checkpoint: DiscoveryCheckpoint): void {
  db.prepare(`INSERT INTO collection_checkpoints (competitor_id, stage, cursor_json) VALUES (?, 'discovery', ?)
    ON CONFLICT (competitor_id, stage) DO UPDATE SET cursor_json = excluded.cursor_json,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(competitorId, JSON.stringify(checkpoint));
}

// ---- Browser loop ----------------------------------------------------------------------------------

/**
 * Discovers one competitor's posts. Every scroll's findings are written before the next scroll, and the
 * checkpoint is updated as it goes, so an interruption loses at most one scroll of work.
 */
export async function discoverPosts(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitor: { id: number; username: string },
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const { log } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const { username } = competitor;
  const previous = readCheckpoint(db, competitor.id);
  const mode: 'full' | 'incremental' = previous?.completedAt && !options.full ? 'incremental' : 'full';
  const savedBefore = countSaved(db, competitor.id);

  if (!previous) log.info(`@${username}: first discovery run; walking the whole grid.`);
  else if (mode === 'incremental') log.info(`@${username}: profile fully walked on ${previous.completedAt}; ${savedBefore} posts saved. Looking for newer posts only.`);
  else log.info(`@${username}: previous run ended "${previous.endReason ?? previous.status}" with ${savedBefore} posts saved. Continuing: known posts are skipped, only unseen posts are written.`);

  // Grid pages arrive as GraphQL responses, starting during the initial page load, so listen before opening.
  const timeline: TimelinePage[] = [];
  const pendingBodies = new Set<Promise<void>>();
  // GraphQL requests started since the last scroll. Long-lived requests from before do not hold up the wait.
  const inFlight = new Set<Request>();
  const isGraphql = (url: string): boolean => /instagram\.com\/(api\/)?graphql/.test(url);
  const onRequest = (request: Request): void => { if (isGraphql(request.url())) inFlight.add(request); };
  const onRequestDone = (request: Request): void => { inFlight.delete(request); };
  const onResponse = (response: Response): void => {
    if (!isGraphql(response.url())) return;
    const body = response.text().then((text) => {
      if (/user_timeline|ordered_timeline/.test(text)) timeline.push(...parseTimelineResponse(text));
    }, () => undefined);
    pendingBodies.add(body);
    void body.finally(() => pendingBodies.delete(body));
  };
  context.on('request', onRequest);
  context.on('requestfinished', onRequestDone);
  context.on('requestfailed', onRequestDone);
  context.on('response', onResponse);

  let page: Page | undefined;
  // A job still 'running' here was cut off by a hard kill; its posts are saved, only the job row is stale.
  db.prepare(`UPDATE scrape_jobs SET status = 'failed', error = 'abandoned (process killed)', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE competitor_id = ? AND job_type = 'discovery' AND status = 'running'`).run(competitor.id);
  const jobId = startJob(db, competitor.id, 'discovery');
  const counts = { seen: 0, new: 0, known: 0 };
  const seen = new Set<string>(); // shortcodes seen this run; ~20 bytes each, so memory stays small
  let scrolls = 0;
  let deepest: string | null = null;
  const checkpoint = (status: DiscoveryCheckpoint['status'], endReason: string | null, completedAt = previous?.completedAt ?? null): void => {
    writeCheckpoint(db, competitor.id, {
      version: 1, status, completedAt, lastRunAt: new Date().toISOString(), endReason,
      deepestShortcode: deepest ?? previous?.deepestShortcode ?? null,
      lastRun: { mode, seen: counts.seen, new: counts.new, known: counts.known, scrolls },
    });
  };

  try {
    let opened;
    try {
      opened = await openProfile(context, session, username, options);
    } catch (error) {
      if (error instanceof ProfileScrapeError) throw error;
      throw new ProfileScrapeError(classify(error, 1, profileUrl(username)), error);
    }
    page = opened.page;
    const profile = opened.result;
    saveProfile(db, competitor.id, startJob(db, competitor.id), profile);
    const postsCount = profile.fields.postsCount;
    if (profile.status !== 'active') {
      log.warn(`@${username}: profile is ${profile.status}; no posts to discover.`);
      finishJob(db, jobId, 'complete', `skipped: ${profile.status}`);
      return { username, mode: 'skipped', status: profile.status, endReason: profile.status, seen: 0, new: 0, known: 0, savedForCompetitor: savedBefore, profilePostsCount: postsCount };
    }
    db.prepare('UPDATE scrape_jobs SET total_items = ? WHERE id = ?').run(postsCount, jobId);
    checkpoint('in_progress', null);

    let idle = 0;
    let knownStreak = 0;
    let recoveryUsed = false;
    let hasNextPage: boolean | null = null;
    let passedPreviousFrontier = previous?.deepestShortcode ? false : true;

    for (;;) {
      await assertStillAllowed(page, session);
      await waitForResponses(pendingBodies);
      // Collect: network grid pages (exact order and type) first, then whatever links the DOM currently holds.
      const batch: DiscoveredPost[] = [];
      for (const pageOfPosts of timeline.splice(0)) {
        if (pageOfPosts.hasNextPage !== null) hasNextPage = pageOfPosts.hasNextPage;
        batch.push(...pageOfPosts.posts);
      }
      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href') ?? ''));
      for (const href of hrefs) {
        const post = normalizePostUrl(href);
        if (post) batch.push(post);
      }
      const fresh = dedupe(batch).filter((post) => !seen.has(post.shortcode));

      if (fresh.length > 0) {
        const flags = saveDiscovered(db, competitor.id, fresh);
        fresh.forEach((post, i) => {
          seen.add(post.shortcode);
          const flag = flags[i]!;
          if (flag.isNew) counts.new += 1; else counts.known += 1;
          // Only posts known since the last complete walk prove we have caught up. Posts saved by an
          // interrupted incremental run do not: older unsaved posts may still lie beyond them.
          const caughtUpEvidence = !flag.isNew && previous?.completedAt != null && flag.knownSince !== null && flag.knownSince <= previous.completedAt;
          knownStreak = caughtUpEvidence ? knownStreak + 1 : 0;
          if (!passedPreviousFrontier && post.shortcode === previous?.deepestShortcode) {
            passedPreviousFrontier = true;
            log.info(`@${username}: reached where the previous run stopped (${post.shortcode}) after ${scrolls} scrolls.`);
          }
        });
        counts.seen = seen.size;
        deepest = fresh.at(-1)?.shortcode ?? deepest;
        idle = 0;
        db.prepare('UPDATE scrape_jobs SET processed_items = ? WHERE id = ?').run(counts.seen, jobId);
        checkpoint('in_progress', null);
        log.info(`@${username}: seen ${counts.seen}${postsCount !== null ? `/${postsCount}` : ''} (new ${counts.new}, known ${counts.known}), scroll ${scrolls}`);
      } else if (scrolls > 0) {
        idle += 1;
        log.debug(`@${username}: nothing unseen after scroll ${scrolls} (idle ${idle}/${options.maxIdleScrolls})`);
        await assertStillAllowed(page, session); // a stalled grid can be a logout, challenge or throttle page
      }

      const decision = decide({
        mode, scrolls, idle, maxIdle: options.maxIdleScrolls, recoveryUsed, hasNextPage, knownStreak,
        seenThisRun: counts.seen,
        // Rounded meta/DOM counts cannot establish that a full grid has been traversed.
        profilePostsCount: profile.sources.postsCount === 'json' ? postsCount : null, aborted: options.signal?.aborted ?? false,
      });
      if (decision.action === 'stop') {
        checkpoint(decision.status, decision.reason, decision.status === 'complete' ? new Date().toISOString() : undefined);
        finishJob(db, jobId, decision.status === 'complete' ? 'complete' : 'failed', decision.status === 'complete' ? null : decision.reason);
        const result = { username, mode, status: decision.status, endReason: decision.reason, ...counts, savedForCompetitor: countSaved(db, competitor.id), profilePostsCount: postsCount };
        if (decision.status === 'complete') {
          db.prepare(`UPDATE scrape_errors SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE competitor_id = ? AND stage = 'discovery' AND resolved_at IS NULL`).run(competitor.id);
        }
        return result;
      }
      if (decision.action === 'recover') {
        recoveryUsed = true;
        idle = 0;
        log.warn(`@${username}: no new posts after ${options.maxIdleScrolls} scrolls but the profile likely has more; pausing ${RECOVERY_WAIT_MS / 1000}s and retrying once.`);
        await sleep(RECOVERY_WAIT_MS);
        await wheel(page, -1);
        await sleep(1_000);
      }

      // Scroll: two viewport heights, then a jittered pause; idle scrolls wait longer and nudge up first,
      // which re-triggers Instagram's load-more observer if the previous load failed.
      if (idle >= 2) {
        await wheel(page, -0.5);
        await sleep(800);
      }
      inFlight.clear();
      await wheel(page, 2);
      scrolls += 1;
      await sleep(options.scrollDelayMs * (1 + Math.random() * 0.5) + options.scrollDelayMs * Math.min(idle, 4) * 0.5);
      for (let waited = 0; inFlight.size > 0 && waited < IN_FLIGHT_WAIT_MS && !options.signal?.aborted; waited += 500) await sleep(500);
    }
  } catch (error) {
    throwIfStorageError(error);
    if (options.signal?.aborted) {
      // A user stop is not an error: record where we got to and report it like any other incomplete run.
      if (counts.seen > 0 || previous) checkpoint('incomplete', 'interrupted');
      finishJob(db, jobId, 'failed', 'interrupted');
      return { username, mode, status: 'incomplete', endReason: 'interrupted', ...counts, savedForCompetitor: countSaved(db, competitor.id), profilePostsCount: null };
    }
    const failure: ScrapeFailure = error instanceof ProfileScrapeError ? error.failure : classify(error, 1, profileUrl(username));
    const original = error instanceof ProfileScrapeError ? error.original : error;
    if (!(error instanceof ProfileScrapeError) && page) {
      failure.debugFiles = await writeDebugFiles(page, username, failure, options);
    }
    if (counts.seen > 0 || previous) checkpoint('incomplete', failure.type);
    saveFailure(db, competitor.id, jobId, failure, isBatchFatal(original), 'discovery');
    throw new ProfileScrapeError(failure, original);
  } finally {
    context.off('request', onRequest);
    context.off('requestfinished', onRequestDone);
    context.off('requestfailed', onRequestDone);
    context.off('response', onResponse);
    await page?.close().catch(() => undefined);
  }
}

function dedupe(posts: DiscoveredPost[]): DiscoveredPost[] {
  const byCode = new Map<string, DiscoveredPost>();
  for (const post of posts) {
    const existing = byCode.get(post.shortcode);
    if (!existing || (existing.type === 'unknown' && post.type !== 'unknown')) byCode.set(post.shortcode, post);
  }
  return [...byCode.values()];
}

/** Scrolls by a multiple of the viewport height with the mouse wheel, like a person would. */
async function wheel(page: Page, viewports: number): Promise<void> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 2);
  await page.mouse.wheel(0, size.height * viewports);
}

// ---- Batch -------------------------------------------------------------------------------------------

export function formatDiscovery(result: DiscoveryResult): string {
  if (result.mode === 'skipped') return `Competitor: ${result.username}\nSkipped: profile is ${result.status}`;
  const count = result.profilePostsCount;
  const expected = count === null ? '' : result.status === 'complete' && result.savedForCompetitor < count
    ? ` (profile shows ${count}; Instagram's grid ended first, the count includes posts the grid does not show)`
    : ` (profile shows ${count})`;
  return [
    `Competitor: ${result.username}`,
    '',
    `Discovered total: ${result.seen}`,
    `New: ${result.new}`,
    `Previously known: ${result.known}`,
    '',
    `Saved for this competitor: ${result.savedForCompetitor}${expected}`,
    `Run: ${result.mode}, ${result.status} (${describeEnd(result.endReason)})`,
  ].join('\n');
}

function describeEnd(reason: string): string {
  return {
    end_of_profile: 'Instagram reported no more posts',
    caught_up: `reached ${KNOWN_STREAK_TO_STOP} already-known posts in a row`,
    all_posts_found: 'grid stopped growing and every post the profile counts is saved',
    no_posts: 'profile has no posts',
    loading_stalled: 'Instagram said more posts exist but stopped loading them; rerun to continue',
    posts_missing: 'grid stopped growing before reaching the profile post count; rerun to continue',
    end_unverified: 'grid stopped growing and the profile post count is unknown; rerun to confirm',
    scroll_limit: `stopped at the ${MAX_SCROLLS}-scroll safety limit; rerun to continue`,
    interrupted: 'stopped by user; rerun to continue',
  }[reason] ?? reason;
}

export async function discoverBatch(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitors: Array<{ id: number; username: string }>,
  options: DiscoveryOptions,
): Promise<{ results: DiscoveryResult[]; failed: string[]; skipped: string[]; stoppedBy: string | null }> {
  const results: DiscoveryResult[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let stoppedBy: string | null = null;
  for (const [index, competitor] of competitors.entries()) {
    if (stoppedBy || options.signal?.aborted) {
      stoppedBy ??= 'interrupted';
      skipped.push(competitor.username);
      continue;
    }
    if (index > 0) await (options.sleep ?? delay)(PACING_MS[0] + Math.random() * (PACING_MS[1] - PACING_MS[0]));
    options.log.info(`[${index + 1}/${competitors.length}] discovering @${competitor.username}`);
    try {
      const result = await discoverPosts(db, context, session, competitor, options);
      results.push(result);
      process.stdout.write(`\n${formatDiscovery(result)}\n\n`);
      if (result.endReason === 'interrupted') stoppedBy = 'interrupted';
    } catch (error) {
      throwIfStorageError(error);
      const failure = error instanceof ProfileScrapeError ? error.failure : classify(error, 1, profileUrl(competitor.username));
      const original = error instanceof ProfileScrapeError ? error.original : error;
      failed.push(competitor.username);
      options.log.error(`@${competitor.username}: discovery ${failure.type}: ${failure.message}${failure.debugFiles.length ? ` (debug files: ${failure.debugFiles.join(', ')})` : ''}`);
      if (isBatchFatal(original)) stoppedBy = failure.type;
      if (options.signal?.aborted) stoppedBy = 'interrupted';
    }
  }
  return { results, failed, skipped, stoppedBy };
}
