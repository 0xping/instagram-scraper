// Dataset-wide views and repair: `npm run status` and `npm run retry:failed`.

import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import { scrapeComments, DEFAULT_COMMENT_LIMIT } from './comments.js';
import { formatTable } from './competitors.js';
import type { AppConfig } from './config.js';
import { checkFfmpeg, DEFAULT_FRAME_INTERVAL, processCompetitorFrames } from './frames.js';
import type { Logger } from './logger.js';
import { MAX_DOWNLOAD_ATTEMPTS, type MediaOptions } from './media.js';
import { mediaWithRefresh, type BrowserAccess } from './pipeline.js';
import { MAX_FAILED_RUNS, scrapePosts } from './post-scraper.js';
import { isBatchFatal } from './profile-scraper.js';
import { processCompetitorReels } from './reels.js';
import { createTranscriptionProvider } from './transcription-provider.js';
import { processCompetitorTranscripts } from './transcripts.js';

// ---- npm run status ------------------------------------------------------------------------------

export interface StatusRow {
  username: string;
  discovered: number;
  metadata: number;
  media: number;
  failed: number;
  lastScrapedAt: string | null;
  jobStatus: string | null;
  jobError: string | null;
  jobAt: string | null;
}

/** One row per competitor. Failed = posts with a failure in any stage that is not a deleted/restricted post. */
export function competitorStatus(db: Database.Database): StatusRow[] {
  return db.prepare(`WITH owned AS (
      SELECT competitor_id, id AS post_id FROM posts
      UNION SELECT competitor_id, post_id FROM competitor_posts
    ), counts AS (
      SELECT o.competitor_id,
      count(p.id) AS discovered,
      coalesce(sum(p.extraction_status = 'complete'), 0) AS metadata,
      coalesce(sum(p.media_status = 'complete'), 0) AS media,
      coalesce(sum((p.extraction_status = 'failed' AND p.availability NOT IN ('unavailable', 'restricted'))
        OR p.media_status = 'failed' OR p.reel_status = 'failed' OR p.frames_status = 'failed'
        OR p.transcript_status = 'failed' OR p.comments_status = 'failed'), 0) AS failed
      FROM owned o JOIN posts p ON p.id = o.post_id GROUP BY o.competitor_id
    )
    SELECT c.username, c.last_scraped_at AS lastScrapedAt,
      coalesce(counts.discovered, 0) AS discovered,
      coalesce(counts.metadata, 0) AS metadata,
      coalesce(counts.media, 0) AS media,
      coalesce(counts.failed, 0) AS failed,
      j.status AS jobStatus, j.error AS jobError, coalesce(j.finished_at, j.started_at) AS jobAt
    FROM competitors c
    LEFT JOIN counts ON counts.competitor_id = c.id
    LEFT JOIN scrape_jobs j ON j.id = (SELECT max(id) FROM scrape_jobs WHERE competitor_id = c.id AND job_type = 'pipeline')
    WHERE c.archived_at IS NULL
    ORDER BY c.username`).all() as StatusRow[];
}

export function lastScrapeLabel(r: StatusRow): string {
  if (r.jobStatus === 'running') return 'In progress';
  const date = (r.jobAt ?? r.lastScrapedAt)?.slice(0, 10);
  if (!date) return 'never';
  if (!r.jobStatus || r.jobStatus === 'complete') return date;
  return `${date} (${r.jobError === 'interrupted' ? 'interrupted' : r.jobStatus === 'blocked' ? 'blocked' : 'incomplete'})`;
}

export function formatStatus(rows: StatusRow[]): string {
  return formatTable([
    ['Competitor', 'Discovered', 'Metadata', 'Media', 'Failed', 'Last scrape'],
    ...rows.map((r) => [r.username, String(r.discovered), String(r.metadata), String(r.media), String(r.failed), lastScrapeLabel(r)]),
  ]);
}

// ---- npm run retry:failed ------------------------------------------------------------------------

export const RETRY_STAGES = ['metadata', 'media', 'reels', 'frames', 'transcripts', 'comments'] as const;
export type RetryStage = typeof RETRY_STAGES[number];
/** Stages that load instagram.com pages (media also refreshes expired links when a browser is open). */
export const BROWSER_STAGES: ReadonlySet<RetryStage> = new Set(['metadata', 'comments']);

const lastError = (stage: string): string =>
  `(SELECT e.error_type || ': ' || e.error_message FROM scrape_errors e WHERE e.post_id = p.id AND e.stage = '${stage}' ORDER BY e.id DESC LIMIT 1)`;
const lastRetryable = (stage: string): string =>
  `coalesce((SELECT e.retryable FROM scrape_errors e WHERE e.post_id = p.id AND e.stage = '${stage}' ORDER BY e.id DESC LIMIT 1), 1)`;
const failedMedia = `FROM media m WHERE m.post_id = p.id AND m.download_status = 'failed'`;

/**
 * Per stage: which posts count as failed, the attempt counter and its cap (the bound that stops a post being
 * retried forever), and whether the failure is retryable. Permanent failures are ones retrying cannot fix:
 * the CDN refusing a file, no URL served, an unreadable video, an audio file too large for the API.
 */
const RULES: Record<RetryStage, { scope: string; failed: string; attempts: string; cap: number; reason: string; retryable: string }> = {
  metadata: {
    scope: '1', failed: `p.extraction_status = 'failed' AND p.availability NOT IN ('unavailable', 'restricted')`,
    attempts: 'p.extraction_attempts', cap: MAX_FAILED_RUNS, reason: lastError('extraction'), retryable: lastRetryable('extraction'),
  },
  media: {
    scope: `p.type != 'reel' AND p.extraction_status = 'complete'`, failed: `EXISTS (SELECT 1 ${failedMedia})`,
    attempts: `(SELECT min(m.download_attempts) ${failedMedia})`, cap: MAX_DOWNLOAD_ATTEMPTS, reason: `(SELECT m.last_error ${failedMedia} LIMIT 1)`,
    retryable: `NOT EXISTS (SELECT 1 ${failedMedia} AND (m.last_error LIKE 'not_retrievable%' OR m.last_error LIKE 'no_source_url%'))`,
  },
  reels: {
    scope: `p.type = 'reel'`, failed: `p.reel_status = 'failed'`,
    attempts: `coalesce((SELECT max(m.download_attempts) FROM media m WHERE m.post_id = p.id AND m.media_type = 'video'), 0)`,
    cap: MAX_DOWNLOAD_ATTEMPTS, reason: 'p.reel_status_reason', retryable: '1',
  },
  frames: {
    scope: `p.type = 'reel'`, failed: `p.frames_status = 'failed'`, attempts: 'p.frames_attempts', cap: MAX_FAILED_RUNS,
    reason: 'p.frames_status_reason', retryable: `coalesce(p.frames_status_reason NOT LIKE 'unsupported_video%', 1)`,
  },
  transcripts: {
    scope: `p.type = 'reel'`, failed: `p.transcript_status = 'failed'`, attempts: 'p.transcript_attempts', cap: MAX_FAILED_RUNS,
    reason: 'p.transcript_error',
    // ponytail: message-pattern classification; store a retryable flag on the transcript attempt if more cases appear.
    retryable: `coalesce(NOT (p.transcript_error LIKE '%25 MB%' OR p.transcript_error LIKE '%HTTP 400%' OR p.transcript_error LIKE '%HTTP 413%'), 1)`,
  },
  comments: {
    scope: `p.extraction_status = 'complete' AND p.availability = 'available'`, failed: `p.comments_status = 'failed'`,
    attempts: 'p.comments_attempts', cap: MAX_FAILED_RUNS, reason: lastError('comments'), retryable: lastRetryable('comments'),
  },
};

export interface RetryCandidate { id: number; shortcode: string; attempts: number; reason: string | null; retryable: number }

const owned = `(p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))`;

/** Failed posts for one stage. `eligible`: under the attempt cap; `exhausted`: at or over it (never retried here). */
export function retryCandidates(db: Database.Database, competitorId: number, stage: RetryStage): { eligible: RetryCandidate[]; exhausted: number } {
  const r = RULES[stage];
  const rows = db.prepare(`SELECT p.id, p.shortcode, ${r.attempts} AS attempts, ${r.reason} AS reason, ${r.retryable} AS retryable
    FROM posts p WHERE ${owned} AND ${r.scope} AND ${r.failed} ORDER BY p.id`).all({ cid: competitorId }) as RetryCandidate[];
  return { eligible: rows.filter((row) => row.attempts < r.cap), exhausted: rows.filter((row) => row.attempts >= r.cap).length };
}

export function stillFailed(db: Database.Database, stage: RetryStage, ids: number[]): number {
  if (!ids.length) return 0;
  return (db.prepare(`SELECT count(*) AS n FROM posts p WHERE p.id IN (${ids.map(Number).join(',')}) AND ${RULES[stage].failed}`).get() as { n: number }).n;
}

export interface RetryRow {
  username: string;
  stage: RetryStage;
  /** Retryable failures under the cap. */
  retryable: number;
  /** Failures classified permanent (left alone unless --include-permanent). */
  permanent: number;
  /** At the attempt cap: not retried by this command. */
  exhausted: number;
  retried: number;
  fixed: number;
  note: string | null;
}

export interface RetryOptions {
  config: AppConfig;
  log: Logger;
  signal?: AbortSignal;
  includePermanent: boolean;
  dryRun: boolean;
}

/**
 * Retries one competitor's failed posts, stage by stage, reusing each stage's own code on just those posts.
 * Returns the rows plus the reason browser stages were blocked (carried to the next competitor by the caller).
 */
export async function retryCompetitor(
  db: Database.Database,
  browser: BrowserAccess | null,
  competitor: { id: number; username: string },
  stages: readonly RetryStage[],
  options: RetryOptions,
  blockedBefore: string | null = null,
): Promise<{ rows: RetryRow[]; blocked: string | null }> {
  const { config, log, signal } = options;
  const base = { dataDir: config.dataDir, log, signal };
  const media: MediaOptions = { ...base, limit: null };
  const rows: RetryRow[] = [];
  let blocked = blockedBefore;
  for (const stage of stages) {
    if (signal?.aborted) break;
    const { eligible, exhausted } = retryCandidates(db, competitor.id, stage);
    const chosen = eligible.filter((c) => options.includePermanent || c.retryable);
    const row: RetryRow = {
      username: competitor.username, stage, retryable: eligible.filter((c) => c.retryable).length,
      permanent: eligible.filter((c) => !c.retryable).length, exhausted, retried: 0, fixed: 0, note: null,
    };
    rows.push(row);
    if (!chosen.length || options.dryRun) continue;
    const ids = chosen.map((c) => c.id);
    const needsBrowser = BROWSER_STAGES.has(stage);
    if (needsBrowser && !browser) { row.note = 'needs the browser'; continue; }
    if (needsBrowser && blocked) { row.note = `not run: ${blocked}`; continue; }
    log.info(`@${competitor.username}: retrying ${ids.length} failed ${stage} post(s).`);
    let stoppedBy: string | null = null;
    try {
      if (stage === 'metadata') {
        stoppedBy = (await scrapePosts(db, browser!.context, browser!.session, competitor, { ...base, force: true, limit: null, postIds: ids })).stoppedBy;
      } else if (stage === 'media') {
        const result = await mediaWithRefresh(db, blocked ? null : browser, competitor, media, ids);
        stoppedBy = result.stoppedBy;
        if (result.browserBlocked) blocked = stoppedBy;
      } else if (stage === 'reels') {
        stoppedBy = (await processCompetitorReels(db, competitor, media, ids)).stoppedBy;
      } else if (stage === 'frames') {
        checkFfmpeg();
        stoppedBy = (await processCompetitorFrames(db, competitor, { ...base, limit: null,
          interval: config.frameInterval ?? DEFAULT_FRAME_INTERVAL, maxFrames: null, force: false }, ids)).stoppedBy;
      } else if (stage === 'transcripts') {
        checkFfmpeg();
        await processCompetitorTranscripts(db, competitor, { ...base, force: false, provider: createTranscriptionProvider() }, ids);
      } else {
        stoppedBy = (await scrapeComments(db, browser!.context, browser!.session, competitor, { ...base,
          limit: config.commentLimit === undefined ? DEFAULT_COMMENT_LIMIT : config.commentLimit,
          force: false, limits: config.comments, postIds: ids })).stoppedBy;
      }
    } catch (error) {
      throwIfStorageError(error);
      // One stage failing is recorded on its row; the other stages and competitors still run.
      row.note = (error as Error).message.split('\n')[0] ?? 'failed';
      if (isBatchFatal(error)) blocked = row.note;
    }
    row.retried = ids.length;
    row.fixed = ids.length - stillFailed(db, stage, ids);
    if (stoppedBy && stoppedBy !== 'interrupted') {
      row.note = stoppedBy;
      // A CDN 429 (media/reels) does not block instagram.com page loads.
      if (stage !== 'media' && stage !== 'reels') blocked ??= stoppedBy;
    }
    if (signal?.aborted) row.note = 'interrupted';
  }
  return { rows, blocked };
}

export function formatRetry(rows: RetryRow[], dryRun: boolean): string {
  const shown = rows.filter((r) => r.retryable || r.permanent || r.exhausted);
  if (!shown.length) return 'Nothing to retry.';
  return formatTable([
    ['Competitor', 'Stage', 'Retryable', 'Permanent', 'Gave up', ...(dryRun ? [] : ['Retried', 'Fixed', 'Note'])],
    ...shown.map((r) => [r.username, r.stage, String(r.retryable), String(r.permanent), String(r.exhausted),
      ...(dryRun ? [] : [String(r.retried), String(r.fixed), r.note ?? ''])]),
  ]);
}
