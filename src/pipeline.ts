// npm run scrape: the whole collector for one competitor, stage by stage, sequentially.
//
// Every stage is already resumable and idempotent on its own (it selects work from SQLite state). This layer adds
// one scrape_jobs row (job_type 'pipeline') whose stages_json is rewritten after each stage, and the rules that
// keep a late failure from costing earlier work:
//   - a stage that throws is recorded and the next stage runs;
//   - a session problem, challenge or rate limit ("blocked") skips the remaining instagram.com stages, while
//     local stages (CDN downloads, frames, transcripts) still run;
//   - Ctrl-C stops after the current stage's own cleanup; the rerun resumes the same job, skipping stages it
//     already finished.

import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { BrowserContext } from 'playwright';
import { scrapeComments } from './comments.js';
import type { AppConfig } from './config.js';
import { discoverPosts } from './discovery.js';
import { checkFfmpeg, processCompetitorFrames } from './frames.js';
import { ManualInterventionError, SessionExpiredError, type InstagramSessionManager } from './instagram-session.js';
import type { Logger } from './logger.js';
import { processCompetitorMedia, type MediaOptions, type MediaRunSummary } from './media.js';
import { scrapePosts } from './post-scraper.js';
import { classify, collectProfiles, finishJob, isBatchFatal, startJob } from './profile-scraper.js';
import { processCompetitorReels, type ReelRunSummary } from './reels.js';
import { createTranscriptionProvider, type TranscriptionProvider } from './transcription-provider.js';
import { processCompetitorTranscripts } from './transcripts.js';

export type StageName = 'session' | 'profile' | 'discovery' | 'metadata' | 'media' | 'reels' | 'frames' | 'transcripts' | 'comments';
export type StageStatus = 'ok' | 'partial' | 'failed' | 'blocked' | 'skipped' | 'interrupted';

export interface StageRecord {
  status: StageStatus;
  detail: string | null;
  counts: Record<string, number>;
  at: string;
}

export interface StageResult {
  status: StageStatus;
  detail?: string | null;
  counts?: Record<string, number>;
}

export interface Stage {
  name: StageName;
  /** Loads instagram.com pages; not run once the session is blocked. */
  browser: boolean;
  run: (state: { browserBlocked: string | null }) => Promise<StageResult>;
}

export interface PipelineRun {
  jobId: number;
  resumed: boolean;
  status: 'complete' | 'failed' | 'blocked' | 'interrupted';
  stages: Partial<Record<StageName, StageRecord>>;
  /** Why instagram.com stages were blocked, if they were; a batch carries it to the next competitor. */
  browserBlocked: string | null;
}

// ponytail: fixed resume window; an unfinished job older than this starts over (profile and discovery rerun).
const RESUME_WINDOW = '-24 hours';

/** Whether the competitor's latest pipeline job finished completely within the last `hours`. */
export function recentlyCompleted(db: Database.Database, competitorId: number, hours: number): boolean {
  if (hours <= 0) return false;
  const row = db.prepare(`SELECT status, finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS fresh FROM scrape_jobs
    WHERE competitor_id = ? AND job_type = 'pipeline' ORDER BY id DESC LIMIT 1`).get(`-${hours} hours`, competitorId) as { status: string; fresh: number } | undefined;
  return row?.status === 'complete' && row.fresh === 1;
}

/** The unfinished pipeline job to continue: the latest one, if it is not complete and recent enough. */
export function resumableJob(db: Database.Database, competitorId: number): { id: number; stages: PipelineRun['stages'] } | null {
  const row = db.prepare(`SELECT id, status, stages_json, started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS fresh
    FROM scrape_jobs WHERE competitor_id = ? AND job_type = 'pipeline' ORDER BY id DESC LIMIT 1`)
    .get(RESUME_WINDOW, competitorId) as { id: number; status: string; stages_json: string | null; fresh: number } | undefined;
  if (!row || row.status === 'complete' || !row.fresh) return null;
  return { id: row.id, stages: row.stages_json ? JSON.parse(row.stages_json) as PipelineRun['stages'] : {} };
}

export async function runPipeline(
  db: Database.Database,
  competitor: { id: number; username: string },
  stages: Stage[],
  options: { force: boolean; log: Logger; signal?: AbortSignal; browserBlocked?: string | null },
): Promise<PipelineRun> {
  const { log, signal } = options;
  const previous = options.force ? null : resumableJob(db, competitor.id);
  const jobId = previous?.id ?? startJob(db, competitor.id, 'pipeline');
  const run: PipelineRun = { jobId, resumed: previous !== null, status: 'complete', stages: previous?.stages ?? {}, browserBlocked: null };
  if (previous) {
    db.prepare(`UPDATE scrape_jobs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?`).run(jobId);
    const done = Object.entries(run.stages).filter(([, r]) => r?.status === 'ok').map(([name]) => name);
    log.info(`@${competitor.username}: resuming pipeline job ${jobId}${done.length ? ` (already done: ${done.join(', ')})` : ''}.`);
  }
  const save = (current: StageName): void => {
    const finished = Object.values(run.stages).filter((r) => r?.status === 'ok' || r?.status === 'skipped').length;
    db.prepare('UPDATE scrape_jobs SET stages_json = ?, current_stage = ?, processed_items = ?, total_items = ? WHERE id = ?')
      .run(JSON.stringify(run.stages), current, finished, stages.length, jobId);
  };

  let browserBlocked: string | null = options.browserBlocked ?? null;
  let rerunLater = false;
  for (const stage of stages) {
    if (signal?.aborted) { run.status = 'interrupted'; break; }
    // The session check is cheap and always current. Finished stages are not repeated until one stage runs
    // again: its work can create work for the stages after it (a retried post still needs media and comments),
    // so those run too. Each selects only its own unfinished items, so an up-to-date stage costs nothing.
    if (stage.name !== 'session' && !rerunLater && run.stages[stage.name]?.status === 'ok') continue;
    if (stage.name !== 'session') rerunLater = true;
    let result: StageResult;
    if (stage.browser && browserBlocked) {
      result = { status: 'blocked', detail: `not run: ${browserBlocked}` };
    } else {
      db.prepare('UPDATE scrape_jobs SET current_stage = ? WHERE id = ?').run(stage.name, jobId);
      log.info(`@${competitor.username}: ${stage.name}`);
      try {
        result = await stage.run({ browserBlocked });
      } catch (error) {
        throwIfStorageError(error);
        const original = (error as { original?: unknown }).original ?? error;
        const failure = (error as { failure?: { type: string; message: string } }).failure ?? classify(original, 1, '');
        result = signal?.aborted ? { status: 'interrupted' } : { status: isBatchFatal(original) ? 'blocked' : 'failed', detail: `${failure.type}: ${failure.message}` };
      }
      if (signal?.aborted && result.status !== 'skipped') result = { ...result, status: 'interrupted' };
      if (result.status === 'blocked') browserBlocked ??= result.detail ?? stage.name;
    }
    run.stages[stage.name] = { status: result.status, detail: result.detail ?? null, counts: result.counts ?? {}, at: new Date().toISOString() };
    save(stage.name);
    const line = `@${competitor.username}: ${stage.name} ${result.status}${result.detail ? ` (${result.detail})` : ''}`;
    if (result.status === 'ok' || result.status === 'skipped') log.info(line); else log.warn(line);
    if (result.status === 'interrupted') { run.status = 'interrupted'; break; }
  }

  run.browserBlocked = browserBlocked;
  const statuses = Object.values(run.stages).map((r) => r?.status);
  if (run.status !== 'interrupted') {
    run.status = statuses.includes('blocked') ? 'blocked' : statuses.some((s) => s === 'failed' || s === 'partial') ? 'failed' : 'complete';
  }
  const failedStages = Object.entries(run.stages).filter(([, r]) => r && !['ok', 'skipped'].includes(r.status)).map(([n, r]) => `${n}: ${r!.status}`);
  finishJob(db, jobId, run.status === 'interrupted' ? 'failed' : run.status,
    run.status === 'interrupted' ? 'interrupted' : failedStages.length ? failedStages.join(', ') : null);
  return run;
}

// ---- Media stages with link refresh (shared with the media/reels commands) -----------------------

export interface BrowserAccess {
  context: BrowserContext;
  session: Pick<InstagramSessionManager, 'inspect'>;
}

/**
 * Downloads media; with a browser, posts whose signed links expired are re-extracted from their post pages and
 * downloaded again. Without one, nothing is requested from instagram.com.
 */
export async function mediaWithRefresh(db: Database.Database, browser: BrowserAccess | null, competitor: { id: number; username: string }, options: MediaOptions, postIds?: number[]): Promise<MediaRunSummary> {
  const summary = await processCompetitorMedia(db, competitor, options, postIds);
  if (!browser || !summary.expiredPostIds.length || summary.stoppedBy || options.signal?.aborted) return summary;
  options.log.info(`@${competitor.username}: refreshing ${summary.expiredPostIds.length} post(s) with expired media links from their post pages.`);
  const extraction = await scrapePosts(db, browser.context, browser.session, competitor, { dataDir: options.dataDir, log: options.log, signal: options.signal, sleep: options.sleep, force: true, limit: null, postIds: summary.expiredPostIds });
  if (extraction.stoppedBy) return { ...summary, stoppedBy: extraction.stoppedBy, browserBlocked: extraction.stoppedBy !== 'interrupted' };
  const retry = await processCompetitorMedia(db, competitor, options, summary.expiredPostIds);
  // A carousel can have several expired items. Count items, not the number of affected posts.
  const replacedFailures = summary.expiredPostFailures;
  return {
    ...summary,
    saved: summary.saved + retry.saved,
    failed: summary.failed - replacedFailures + retry.failed,
    complete: summary.complete + retry.complete,
    expiredPostIds: retry.expiredPostIds,
    stoppedBy: extraction.stoppedBy ?? retry.stoppedBy,
  };
}

/** The Reel lifecycle; with a browser, Reels waiting on metadata or a fresh link are re-extracted first, then retried. */
export async function reelsWithRefresh(db: Database.Database, browser: BrowserAccess | null, competitor: { id: number; username: string }, options: MediaOptions): Promise<ReelRunSummary> {
  const summary = await processCompetitorReels(db, competitor, options);
  const waiting = [...summary.needMetadata, ...summary.needFreshLink];
  if (!browser || !waiting.length || summary.stoppedBy || options.signal?.aborted) return summary;
  options.log.info(`@${competitor.username}: opening ${waiting.length} Reel page(s) to collect metadata or fresh links.`);
  const extraction = await scrapePosts(db, browser.context, browser.session, competitor, { dataDir: options.dataDir, log: options.log, signal: options.signal, sleep: options.sleep, force: true, limit: null, postIds: waiting });
  if (extraction.stoppedBy) return { ...summary, stoppedBy: extraction.stoppedBy, browserBlocked: extraction.stoppedBy !== 'interrupted' };
  const again = await processCompetitorReels(db, competitor, options, waiting);
  const counts = { ...summary.counts };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += again.counts[key];
  counts.pending -= waiting.length; // those were counted as pending in the first pass
  return { ...summary, counts, needMetadata: again.needMetadata, needFreshLink: again.needFreshLink, stoppedBy: extraction.stoppedBy ?? again.stoppedBy };
}

/** One home-page load; throws the batch-stopping error when the saved session no longer works. */
export async function verifySession(session: Pick<InstagramSessionManager, 'verify'>, context: BrowserContext): Promise<StageResult> {
  const state = await session.verify(context);
  if (state === 'challenge') throw new ManualInterventionError('Instagram is showing a security challenge. Run `npm run instagram:login` and complete it yourself.');
  if (state === 'logged_out') throw new SessionExpiredError('Instagram session expired. Run: npm run instagram:login');
  return { status: 'ok' };
}

// ---- Summary -------------------------------------------------------------------------------------

export interface PipelineTotals {
  posts: number;
  reels: number;
  mediaPosts: number;
  mediaComplete: number;
  frames: number;
  transcripts: number;
  comments: number;
}

/** What the dataset holds for this competitor now (all runs), as opposed to what this run did. */
export function pipelineTotals(db: Database.Database, competitorId: number): PipelineTotals {
  return db.prepare(`WITH owned AS (SELECT p.* FROM posts p WHERE p.competitor_id = @cid
      OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
    SELECT count(*) AS posts,
      coalesce(sum(type = 'reel'), 0) AS reels,
      coalesce(sum(type != 'reel' AND extraction_status = 'complete'), 0) AS mediaPosts,
      coalesce(sum(type != 'reel' AND extraction_status = 'complete' AND media_status = 'complete'), 0) AS mediaComplete,
      coalesce(sum(type = 'reel' AND frames_status = 'complete'), 0) AS frames,
      coalesce(sum(type = 'reel' AND transcript_status = 'complete'), 0) AS transcripts,
      (SELECT count(*) FROM comments c WHERE c.post_id IN (SELECT id FROM owned)) AS comments
    FROM owned`).get({ cid: competitorId }) as PipelineTotals;
}

const ICON: Record<StageStatus, string> = { ok: '✅', partial: '⚠️', failed: '❌', blocked: '⛔', skipped: '⏭️', interrupted: '⏸️' };

export function formatPipelineSummary(username: string, run: PipelineRun, totals: PipelineTotals): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  const stage = (name: StageName): StageRecord | undefined => run.stages[name];
  const count = (name: StageName, key: string): number => stage(name)?.counts[key] ?? 0;
  const orSkipped = (name: StageName, value: string): string => {
    const s = stage(name);
    return !s ? 'not run' : s.status === 'skipped' || s.status === 'blocked' ? `${s.status}${s.detail ? ` (${s.detail})` : ''}` : value;
  };
  const errors = Object.values(run.stages).reduce((sum, s) => sum + (s?.counts.failed ?? 0) + (s && ['failed', 'blocked'].includes(s.status) ? 1 : 0), 0);
  const rows: Array<[string, string]> = [
    ['Profile', stage('profile') ? ICON[stage('profile')!.status] : 'not run'],
    ['Posts discovered', n(totals.posts)],
    ['Previously processed', n(count('metadata', 'previously'))],
    ['New posts', n(count('metadata', 'selected'))],
    ['Metadata', orSkipped('metadata', `${n(count('metadata', 'extracted'))}/${n(count('metadata', 'selected'))}`)],
    ['Media', orSkipped('media', `${n(totals.mediaComplete)}/${n(totals.mediaPosts)}`)],
    ['Reels', n(totals.reels)],
    ['Frames', orSkipped('frames', `${n(totals.frames)}/${n(totals.reels)}`)],
    ['Transcripts', orSkipped('transcripts', `${n(totals.transcripts)}/${n(totals.reels)}`)],
    ['Comments', orSkipped('comments', n(totals.comments))],
    ['Errors', n(errors)],
  ];
  const problems = Object.entries(run.stages)
    .filter(([, s]) => s && !['ok', 'skipped'].includes(s.status))
    .map(([name, s]) => `  ${ICON[s!.status]} ${name}: ${s!.status}${s!.detail ? ` (${s!.detail})` : ''}`);
  return [
    `Competitor: ${username}`,
    '',
    ...rows.map(([label, value]) => `${label.padEnd(22)}${value}`),
    ...(problems.length ? ['', 'Stages needing attention (rerun the same command to continue):', ...problems] : []),
    '',
    `Job ${run.jobId}: ${run.status}${run.resumed ? ' (resumed)' : ''}`,
  ].join('\n');
}

// ---- The collector's stages ----------------------------------------------------------------------

export interface CollectorFlags {
  force: boolean;
  skipMedia: boolean;
  skipFrames: boolean;
  skipTranscripts: boolean;
  skipComments: boolean;
  /** null = all (the comment safety limits still apply). */
  commentLimit: number | null;
}

export interface CollectorContext {
  db: Database.Database;
  context: BrowserContext;
  session: InstagramSessionManager;
  competitor: { id: number; username: string };
  config: AppConfig;
  log: Logger;
  signal: AbortSignal;
  flags: CollectorFlags;
}

const stopped = (by: string | null): StageResult | null =>
  by === 'interrupted' ? { status: 'interrupted' } : by ? { status: 'blocked', detail: by } : null;

/** The nine stages, in order. Optional ones report `skipped` (with the reason) instead of failing. */
export function collectorStages(ctx: CollectorContext): Stage[] {
  const { db, context, session, competitor, config, log, signal, flags } = ctx;
  const base = { dataDir: config.dataDir, log, signal };
  const media: MediaOptions = { ...base, limit: null };
  const browser = (blocked: string | null): BrowserAccess | null => (blocked ? null : { context, session });
  const ffmpegMissing = (): string | null => { try { checkFfmpeg(); return null; } catch (error) { return (error as Error).message; } };
  const inaccessibleProfile = (): StageResult | null => {
    const row = db.prepare('SELECT account_status FROM competitors WHERE id = ?').get(competitor.id) as { account_status: string };
    return ['private', 'unavailable'].includes(row.account_status) ? { status: 'skipped', detail: `profile is ${row.account_status}` } : null;
  };
  const unresolved = (condition: string): number => (db.prepare(`SELECT count(*) AS n FROM posts p WHERE
    (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
    AND (${condition})`).get({ cid: competitor.id }) as { n: number }).n;

  return [
    { name: 'session', browser: true, run: () => verifySession(session, context) },
    {
      name: 'profile', browser: true, run: async () => {
        const s = await collectProfiles(db, context, session, [competitor], base);
        return stopped(s.stoppedBy) ?? (s.failed.length ? { status: 'failed', detail: 'profile scrape failed (see scrape_errors)' } : { status: 'ok' });
      },
    },
    {
      name: 'discovery', browser: true, run: async () => {
        const r = await discoverPosts(db, context, session, competitor, { ...base, ...config.discovery, full: flags.force });
        const counts = { seen: r.seen, new: r.new, saved: r.savedForCompetitor };
        if (r.endReason === 'interrupted') return { status: 'interrupted', counts };
        if (r.status === 'private' || r.status === 'unavailable') return { status: 'ok', detail: `profile is ${r.status}`, counts };
        return { status: r.status === 'incomplete' ? 'partial' : 'ok', detail: r.status === 'incomplete' ? r.endReason : null, counts };
      },
    },
    {
      name: 'metadata', browser: true, run: async () => {
        const inaccessible = inaccessibleProfile();
        if (inaccessible) return inaccessible;
        const s = await scrapePosts(db, context, session, competitor, { ...base, force: flags.force, limit: null });
        const counts = { selected: s.selected, extracted: s.extracted, unavailable: s.unavailable, restricted: s.restricted,
          failed: s.failed, previously: s.alreadyComplete,
          unresolved: unresolved("p.extraction_status = 'failed' AND p.availability NOT IN ('unavailable', 'restricted')") };
        return { ...(stopped(s.stoppedBy) ?? { status: counts.unresolved ? 'partial' : 'ok' }), counts };
      },
    },
    {
      name: 'media', browser: false, run: async ({ browserBlocked }) => {
        if (flags.skipMedia) return { status: 'skipped', detail: '--skip-media' };
        const ids = (db.prepare(`SELECT p.id FROM posts p WHERE p.type != 'reel' AND p.extraction_status = 'complete'
          AND (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))`)
          .all({ cid: competitor.id }) as Array<{ id: number }>).map((r) => r.id);
        const s = await mediaWithRefresh(db, browser(browserBlocked), competitor, media, ids);
        const counts = { posts: s.posts, complete: s.complete, saved: s.saved, failed: s.failed };
        if (s.stoppedBy === 'interrupted') return { status: 'interrupted', counts };
        // A CDN 429 is not an instagram.com block: record it, let later stages run.
        return { status: s.browserBlocked ? 'blocked' : s.failed || s.stoppedBy ? 'partial' : 'ok', detail: s.stoppedBy, counts };
      },
    },
    {
      name: 'reels', browser: false, run: async ({ browserBlocked }) => {
        if (flags.skipMedia) return { status: 'skipped', detail: '--skip-media' };
        const s = await reelsWithRefresh(db, browser(browserBlocked), competitor, media);
        const counts = { ...s.counts };
        if (s.stoppedBy === 'interrupted') return { status: 'interrupted', counts };
        return { status: s.browserBlocked ? 'blocked' : s.counts.failed || s.counts.pending || s.stoppedBy ? 'partial' : 'ok', detail: s.stoppedBy, counts };
      },
    },
    {
      name: 'frames', browser: false, run: async () => {
        if (flags.skipFrames) return { status: 'skipped', detail: '--skip-frames' };
        const missing = ffmpegMissing();
        if (missing) return { status: 'skipped', detail: missing };
        const s = await processCompetitorFrames(db, competitor, { ...base, limit: null, interval: config.frameInterval, maxFrames: null, force: flags.force });
        const counts = { ...s.counts, unresolved: unresolved("p.type = 'reel' AND p.reel_status IS NOT 'unavailable' AND p.frames_status = 'failed'") };
        return s.stoppedBy ? { status: 'interrupted', counts } : { status: counts.failed || counts.unresolved || counts.no_video ? 'partial' : 'ok', counts };
      },
    },
    {
      name: 'transcripts', browser: false, run: async () => {
        if (flags.skipTranscripts) return { status: 'skipped', detail: '--skip-transcripts' };
        let provider: TranscriptionProvider;
        try { provider = createTranscriptionProvider(); } catch (error) { return { status: 'skipped', detail: `not configured: ${(error as Error).message}` }; }
        const missing = ffmpegMissing();
        if (missing) return { status: 'skipped', detail: missing };
        const s = await processCompetitorTranscripts(db, competitor, { ...base, force: flags.force, provider });
        const counts = { ...s.counts, unresolved: unresolved("p.type = 'reel' AND p.reel_status IS NOT 'unavailable' AND p.transcript_status = 'failed'") };
        if (signal.aborted) return { status: 'interrupted', counts };
        return { status: counts.failed || counts.unresolved || counts.no_video ? 'partial' : 'ok', counts };
      },
    },
    {
      name: 'comments', browser: true, run: async () => {
        if (flags.skipComments) return { status: 'skipped', detail: '--skip-comments' };
        const inaccessible = inaccessibleProfile();
        if (inaccessible) return inaccessible;
        const s = await scrapeComments(db, context, session, competitor, { ...base, limit: flags.commentLimit, force: flags.force, limits: config.comments });
        const counts = { posts: s.selected, collected: s.collected, complete: s.complete, partial: s.partial, failed: s.failed,
          unresolved: unresolved("p.extraction_status = 'complete' AND p.availability = 'available' AND (p.comments_status = 'failed' OR (p.comments_completion = 'partial' AND p.comments_stop_reason != 'limit_reached'))") };
        return { ...(stopped(s.stoppedBy) ?? { status: counts.unresolved ? 'partial' : 'ok' }), counts };
      },
    },
  ];
}
