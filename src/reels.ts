// Reel processing layer. Sits on top of the two layers below it and never talks to instagram.com itself:
//
//   Instagram extraction layer (post-scraper.ts)   post pages -> metadata + signed media URLs
//            ↓
//   Media acquisition layer (media.ts)             signed URLs -> verified files on disk
//            ↓
//   Reel processing layer (this file)              per-Reel lifecycle, access decision, MP4 probe
//
// Metadata is the primary dataset: a Reel whose video can't be saved keeps all its extracted fields.

import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import { checkMediaFile, isExpired, probeMp4, type VideoProbe } from './media-files.js';
import { MAX_DOWNLOAD_ATTEMPTS, MediaRateLimitedError, processPostMedia, selectMediaPosts, type MediaOptions } from './media.js';

export type ReelStatus = 'pending' | 'downloaded' | 'processed' | 'unavailable' | 'failed';

interface ReelRow {
  id: number;
  shortcode: string;
  extraction_status: string;
  availability: string;
  reel_status: ReelStatus | null;
  duration_seconds: number | null;
  thumbnail_path?: string | null;
}

interface VideoRow {
  id: number;
  source_url: string | null;
  local_path: string | null;
  bytes: number | null;
  download_status: string;
  download_attempts: number;
  last_error: string | null;
}

// ---- Access decision (pure) ----------------------------------------------------------------------

export type Access =
  | { ok: true }
  | { ok: false; status: ReelStatus; reason: string; needs: 'metadata' | 'fresh_link' | null };

/**
 * Whether this session has legitimate access to the Reel's video, decided only from what Instagram already
 * served: the post page must be available to the session and must have exposed a video URL, and that signed
 * URL must still be valid. Nothing here requests anything.
 */
export function reelAccess(reel: ReelRow, video: VideoRow | undefined, now = new Date()): Access {
  if (reel.availability === 'unavailable') return { ok: false, status: 'unavailable', reason: 'Reel was deleted (Instagram says it is not available)', needs: null };
  if (reel.availability === 'restricted') return { ok: false, status: 'unavailable', reason: 'Reel is restricted for this session (private or gated account)', needs: null };
  if (reel.extraction_status !== 'complete') return { ok: false, status: 'pending', reason: 'metadata not collected yet (run scrape:posts, or reels --refresh)', needs: 'metadata' };
  if (!video) return { ok: false, status: 'unavailable', reason: 'Instagram served no video item for this Reel to this session', needs: null };
  if (video.download_status === 'complete') return { ok: true };
  if (!video.source_url) return { ok: false, status: 'unavailable', reason: 'Instagram served no video URL for this Reel to this session', needs: null };
  if (isExpired(video.source_url, now)) return { ok: false, status: 'pending', reason: 'signed video link expired (reels --refresh fetches a new one)', needs: 'fresh_link' };
  if (video.last_error?.startsWith('not_retrievable')) return { ok: false, status: 'unavailable', reason: `the CDN refuses this video to this session (${video.last_error})`, needs: null };
  if (video.download_attempts >= MAX_DOWNLOAD_ATTEMPTS) return { ok: false, status: 'failed', reason: `gave up after ${video.download_attempts} failed downloads (${video.last_error ?? 'unknown error'})`, needs: null };
  return { ok: true };
}

/** Probe vs Instagram metadata: small differences are normal (container vs manifest rounding). */
export function durationMismatch(probe: number, metadata: number | null): boolean {
  return metadata !== null && Math.abs(probe - metadata) > Math.max(1.5, metadata * 0.05);
}

// ---- Lifecycle ------------------------------------------------------------------------------------

export interface ReelOutcome {
  shortcode: string;
  status: ReelStatus;
  reason: string | null;
  needs: 'metadata' | 'fresh_link' | null;
  postId: number;
}

/**
 * Moves one Reel as far along the lifecycle as it can go without loading an instagram.com page, and records
 * where it stopped. Safe to rerun: a processed Reel whose file is intact is left exactly as it is.
 */
export async function processReel(db: Database.Database, reelId: number, competitorId: number, options: MediaOptions): Promise<ReelOutcome> {
  const reel = db.prepare('SELECT id, shortcode, extraction_status, availability, reel_status, duration_seconds, thumbnail_path FROM posts WHERE id = ?').get(reelId) as ReelRow;
  const video = (): VideoRow | undefined => db.prepare(`SELECT id, source_url, local_path, bytes, download_status, download_attempts, last_error
    FROM media WHERE post_id = ? AND media_type = 'video' ORDER BY position LIMIT 1`).get(reelId) as VideoRow | undefined;
  const set = (status: ReelStatus, reason: string | null, needs: ReelOutcome['needs'] = null): ReelOutcome => {
    db.prepare(`UPDATE posts SET reel_status = ?, reel_status_reason = ?, reel_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(status, reason, reelId);
    return { shortcode: reel.shortcode, status, reason, needs, postId: reelId };
  };

  // Already processed and the file is still exactly what we verified: nothing to do.
  const existing = video();
  if (reel.reel_status === 'processed' && reel.thumbnail_path && existing?.local_path && existing.bytes !== null) {
    const path = join(options.dataDir, existing.local_path);
    if (existsSync(path) && statSync(path).size === existing.bytes && checkMediaFile(path).ok && existsSync(join(options.dataDir, reel.thumbnail_path))) {
      return { shortcode: reel.shortcode, status: 'processed', reason: null, needs: null, postId: reelId };
    }
  }

  // A saved, verified video outlives the Reel being deleted later; metadata and file are both kept.
  const access = reelAccess(reel, existing);
  if (!access.ok && !(existing?.download_status === 'complete')) return set(access.status, access.reason, access.needs);

  // Acquisition: the media layer downloads/verifies the video and thumbnail and writes the post folder.
  const post = selectMediaPosts(db, competitorId, null, [reelId])[0];
  if (post) await processPostMedia(db, post, competitorId, options);
  if (options.signal?.aborted) return set('pending', 'interrupted; rerun to continue');

  const after = video();
  if (!after || after.download_status !== 'complete' || !after.local_path) {
    const retry = reelAccess(reel, after);
    if (!retry.ok) return set(retry.status, retry.reason, retry.needs);
    return set('failed', `download failed: ${after?.last_error ?? 'unknown error'} (retried on the next run)`);
  }
  set('downloaded', null);

  // Processing: read the MP4's own structure.
  let probe: VideoProbe;
  try {
    probe = probeMp4(join(options.dataDir, after.local_path));
  } catch (error) {
    throwIfStorageError(error);
    // The file passed the download checks but is not a playable MP4. Move it aside (kept for inspection, never
    // deleted) so acquisition doesn't adopt it again, and let the next run download a fresh copy.
    const path = join(options.dataDir, after.local_path);
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
    db.prepare(`UPDATE media SET download_status = 'failed', local_path = NULL, bytes = NULL, sha256 = NULL,
      last_error = ?, download_attempts = download_attempts + 1 WHERE id = ?`).run(`corrupt_video: ${(error as Error).message}`, after.id);
    db.prepare("UPDATE posts SET media_status = 'failed' WHERE id = ?").run(reelId);
    return set('failed', `video could not be probed (${(error as Error).message}); it will be re-downloaded`);
  }
  db.prepare('UPDATE posts SET video_probe_duration = ?, video_width = ?, video_height = ?, video_has_audio = ? WHERE id = ?')
    .run(probe.durationSeconds, probe.width, probe.height, Number(probe.hasAudio), reelId);
  const notes = [
    reel.availability === 'unavailable' ? 'Reel has since been deleted on Instagram; local copy kept' : null,
    durationMismatch(probe.durationSeconds, reel.duration_seconds) ? `file is ${probe.durationSeconds}s but Instagram says ${reel.duration_seconds}s` : null,
    probe.hasAudio ? null : 'video has no audio track',
  ].filter(Boolean);
  return set('processed', notes.length ? notes.join('; ') : null);
}

export function selectReels(db: Database.Database, competitorId: number, limit: number | null): number[] {
  return (db.prepare(`SELECT p.id FROM posts p WHERE p.type = 'reel'
    AND (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
    ORDER BY (p.reel_status = 'processed'), p.id LIMIT @limit`).all({ cid: competitorId, limit: limit ?? -1 }) as Array<{ id: number }>).map((r) => r.id);
}

export interface ReelRunSummary {
  username: string;
  counts: Record<ReelStatus, number>;
  needMetadata: number[];
  needFreshLink: number[];
  stoppedBy: string | null;
  browserBlocked?: boolean;
}

export async function processCompetitorReels(db: Database.Database, competitor: { id: number; username: string }, options: MediaOptions, only?: number[]): Promise<ReelRunSummary> {
  const ids = only ?? selectReels(db, competitor.id, options.limit);
  const summary: ReelRunSummary = {
    username: competitor.username,
    counts: { pending: 0, downloaded: 0, processed: 0, unavailable: 0, failed: 0 },
    needMetadata: [], needFreshLink: [], stoppedBy: null,
  };
  if (!only) options.log.info(`@${competitor.username}: ${ids.length} Reel(s).`);
  for (const [index, id] of ids.entries()) {
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }
    try {
      const outcome = await processReel(db, id, competitor.id, options);
      summary.counts[outcome.status] += 1;
      if (outcome.needs === 'metadata') summary.needMetadata.push(id);
      if (outcome.needs === 'fresh_link') summary.needFreshLink.push(id);
      const line = `[${index + 1}/${ids.length}] ${outcome.shortcode}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`;
      if (outcome.status === 'failed') options.log.warn(line); else if (outcome.status === 'pending' && outcome.needs) options.log.debug(line); else options.log.info(line);
    } catch (error) {
      throwIfStorageError(error);
      if (error instanceof MediaRateLimitedError) {
        summary.stoppedBy = 'rate_limited';
        options.log.error((error as Error).message);
        break;
      }
      summary.counts.failed += 1;
      db.prepare(`UPDATE posts SET reel_status = 'failed', reel_status_reason = ?, reel_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(`unexpected: ${(error as Error).message}`, id);
      options.log.error(`[${index + 1}/${ids.length}] Reel ${id}: ${(error as Error).message}`);
    }
  }
  if (options.signal?.aborted) summary.stoppedBy = 'interrupted';
  return summary;
}

export function formatReelRun(s: ReelRunSummary): string {
  const { counts } = s;
  const waiting = [
    s.needMetadata.length ? `${s.needMetadata.length} need metadata` : null,
    s.needFreshLink.length ? `${s.needFreshLink.length} need a fresh link` : null,
  ].filter(Boolean).join(', ');
  return [
    `Competitor: ${s.username}`,
    '',
    `Processed: ${counts.processed}`,
    `Downloaded (not yet probed): ${counts.downloaded}`,
    `Pending: ${counts.pending}${waiting ? ` (${waiting}; use --refresh)` : ''}`,
    `Unavailable: ${counts.unavailable}`,
    `Failed: ${counts.failed}`,
    ...(s.stoppedBy ? [`Stopped early: ${s.stoppedBy}`] : []),
  ].join('\n');
}
