// Frame extraction for downloaded Reels: runs ffmpeg (as an argument list, never through a shell) and records
// every frame's timestamp and path in reel_frames. Local only; never talks to instagram.com.

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { Logger } from './logger.js';
import { probeMp4, relativeToData } from './media-files.js';
import { MAX_FAILED_RUNS } from './post-scraper.js';

export const DEFAULT_FRAME_INTERVAL = 1;
const FFMPEG_TIMEOUT_MS = 10 * 60_000;
const FRAME_FILE = /^frame_\d{5}\.jpg$/;

// ffmpeg-static is CommonJS; its path (null on unsupported platforms) is the module's export.
const bundledFfmpeg = createRequire(import.meta.url)('ffmpeg-static') as string | null;

/** FFMPEG_PATH overrides the binary; otherwise the copy npm install downloads (ffmpeg-static), else `ffmpeg` from PATH. */
export const ffmpegBin = (): string => process.env.FFMPEG_PATH?.trim() || bundledFfmpeg || 'ffmpeg';

/** Throws with an install hint when ffmpeg cannot be run. */
export function checkFfmpeg(): string {
  try {
    return execFileSync(ffmpegBin(), ['-version'], { encoding: 'utf8', timeout: 10_000 }).split('\n')[0] ?? 'ffmpeg';
  } catch {
    throw new Error(`FFmpeg not found (tried "${ffmpegBin()}"). Run npm install (it downloads FFmpeg), install it system-wide, or set FFMPEG_PATH.`);
  }
}

/** Seconds between frames: the requested interval, widened so a long video never exceeds maxFrames. */
export function effectiveInterval(duration: number, interval: number, maxFrames: number | null): number {
  if (!maxFrames) return interval;
  return Math.max(interval, Math.ceil((duration / maxFrames) * 1000) / 1000);
}

/** Frame N (0-based) is taken at N * interval; ffmpeg's fps filter emits the first frame at t=0. */
export const frameTimestamp = (index: number, interval: number): number => Math.round(index * interval * 1000) / 1000;

function runFfmpeg(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    execFile(ffmpegBin(), args, { cwd, timeout: FFMPEG_TIMEOUT_MS, signal, maxBuffer: 1024 * 1024 }, (error, _out, stderr) => {
      if (!error) return done();
      const detail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
      fail(new Error(`ffmpeg failed${detail ? `: ${detail}` : `: ${error.message}`}`));
    });
  });
}

/**
 * Each run gets a new directory. The old files stay in place until SQLite points at the new ones.
 */
async function extractFrames(videoPath: string, framesDir: string, interval: number, maxFrames: number | null, signal?: AbortSignal): Promise<{ files: string[]; outputDir: string }> {
  const outputDir = resolve(framesDir, randomUUID());
  const partial = `${outputDir}.partial`;
  mkdirSync(partial, { recursive: true });
  try {
    // cwd is the output directory and the output pattern is relative, so no user-derived path is ever
    // interpreted as a printf pattern or an option (videoPath is absolute).
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-an', '-sn',
      '-vf', `fps=1/${interval}:round=up`, ...(maxFrames ? ['-frames:v', String(maxFrames)] : []), '-q:v', '2', 'frame_%05d.jpg'];
    await runFfmpeg(args, partial, signal);
    const files = readdirSync(partial).filter((name) => FRAME_FILE.test(name)).sort();
    if (!files.length) throw new Error('ffmpeg produced no frames (unsupported or corrupt video)');
    if (files.some((name) => statSync(resolve(partial, name)).size === 0)) throw new Error('ffmpeg wrote an empty frame');
    mkdirSync(framesDir, { recursive: true });
    renameSync(partial, outputDir);
    return { files, outputDir };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    if (existsSync(framesDir) && readdirSync(framesDir).length === 0) rmdirSync(framesDir);
    throw error;
  }
}

// ---- Per-Reel processing -------------------------------------------------------------------------

export interface FrameOptions {
  dataDir: string;
  log: Logger;
  signal?: AbortSignal;
  limit: number | null;
  interval: number;
  maxFrames: number | null;
  force: boolean;
}

interface FrameReel {
  id: number;
  shortcode: string;
  frames_status: 'complete' | 'failed' | null;
  frames_count: number | null;
  frames_attempts: number;
  video_path: string | null;
}

export interface FrameOutcome {
  shortcode: string;
  status: 'complete' | 'skipped' | 'failed' | 'no_video' | 'interrupted';
  detail: string | null;
}

export function selectFrameReels(db: Database.Database, competitorId: number, limit: number | null, postIds?: number[]): FrameReel[] {
  const only = postIds ? `AND p.id IN (${postIds.map(Number).join(',') || 'NULL'})` : '';
  return db.prepare(`SELECT p.id, p.shortcode, p.frames_status, p.frames_count, p.frames_attempts,
      (SELECT m.local_path FROM media m WHERE m.post_id = p.id AND m.media_type = 'video' AND m.download_status = 'complete'
        ORDER BY m.position LIMIT 1) AS video_path
    FROM posts p WHERE p.type = 'reel'
    AND (p.reel_status IS NOT 'unavailable' OR EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id AND m.media_type = 'video' AND m.download_status = 'complete'))
    AND (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
    ${only} ORDER BY (p.frames_status IS 'complete' OR p.frames_attempts >= ${MAX_FAILED_RUNS}), p.id LIMIT @limit`).all({ cid: competitorId, limit: limit ?? -1 }) as FrameReel[];
}

const framesIntact = (db: Database.Database, dataDir: string, reel: FrameReel): boolean => {
  const rows = db.prepare('SELECT image_path FROM reel_frames WHERE post_id = ?').all(reel.id) as Array<{ image_path: string }>;
  return rows.length > 0 && rows.length === reel.frames_count && rows.every((r) => existsSync(resolve(dataDir, r.image_path)));
};

export async function processReelFrames(db: Database.Database, reel: FrameReel, options: FrameOptions): Promise<FrameOutcome> {
  const { dataDir } = options;
  const done = (status: FrameOutcome['status'], detail: string | null = null): FrameOutcome => ({ shortcode: reel.shortcode, status, detail });
  if (!reel.video_path) return done('no_video', 'video not downloaded (run: npm run reels)');
  if (!options.force && reel.frames_status === 'complete' && framesIntact(db, dataDir, reel)) return done('skipped', `${reel.frames_count} frames already extracted`);
  if (!options.force && reel.frames_status === 'failed' && reel.frames_attempts >= MAX_FAILED_RUNS) return done('skipped', `gave up after ${reel.frames_attempts} failed attempts (--force retries)`);

  const root = resolve(dataDir);
  const videoPath = resolve(root, reel.video_path);
  if (!videoPath.startsWith(root + sep)) throw new Error(`Video path escapes the data directory: ${reel.video_path}`);
  const setFailed = (reason: string): FrameOutcome => {
    db.prepare(`UPDATE posts SET frames_status = CASE WHEN frames_status = 'complete' THEN 'complete' ELSE 'failed' END,
      frames_status_reason = ?, frames_attempts = frames_attempts + CASE WHEN frames_status = 'complete' THEN 0 ELSE 1 END,
      frames_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(reason, reel.id);
    return done('failed', reason);
  };

  let duration: number;
  try {
    if (!existsSync(videoPath)) throw new Error('file is missing');
    duration = probeMp4(videoPath).durationSeconds;
    if (duration <= 0) throw new Error('zero duration');
  } catch (error) {
    throwIfStorageError(error);
    return setFailed(`unsupported_video: ${(error as Error).message}`);
  }

  const interval = effectiveInterval(duration, options.interval, options.maxFrames);
  const framesDir = resolve(dirname(dirname(videoPath)), 'frames'); // <post dir>/frames next to media/
  let extracted: { files: string[]; outputDir: string };
  try {
    extracted = await extractFrames(videoPath, framesDir, interval, options.maxFrames, options.signal);
  } catch (error) {
    throwIfStorageError(error);
    if (options.signal?.aborted) return done('interrupted');
    return setFailed((error as Error).message);
  }
  if (options.signal?.aborted) {
    rmSync(extracted.outputDir, { recursive: true, force: true });
    return done('interrupted');
  }

  const insert = db.prepare('INSERT INTO reel_frames (post_id, timestamp_seconds, image_path) VALUES (?, ?, ?)');
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM reel_frames WHERE post_id = ?').run(reel.id); // --force / changed interval: replace, never duplicate
      extracted.files.forEach((name, i) => insert.run(reel.id, frameTimestamp(i, interval), relativeToData(dataDir, resolve(extracted.outputDir, name))));
      db.prepare(`UPDATE posts SET frames_status = 'complete', frames_status_reason = ?, frames_interval_seconds = ?, frames_count = ?, frames_attempts = 0,
        frames_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(interval > options.interval ? `interval widened to ${interval}s by --max-frames ${options.maxFrames}` : null, interval, extracted.files.length, reel.id);
    })();
  } catch (error) {
    rmSync(extracted.outputDir, { recursive: true, force: true });
    throw error;
  }
  // A crash during cleanup leaves only extra files; SQLite already points at the complete generation.
  try {
    for (const name of readdirSync(framesDir)) {
      if (resolve(framesDir, name) !== extracted.outputDir) rmSync(resolve(framesDir, name), { recursive: true, force: true });
    }
  } catch (error) {
    options.log.warn(`${reel.shortcode}: old frame cleanup failed (${(error as Error).message})`);
  }
  return done('complete', `${extracted.files.length} frames every ${interval}s`);
}

// ---- Per-competitor run --------------------------------------------------------------------------

export interface FrameRunSummary {
  username: string;
  counts: Record<'complete' | 'skipped' | 'failed' | 'no_video', number>;
  stoppedBy: string | null;
}

/** Sequential on purpose: ffmpeg already uses every core for one video. */
export async function processCompetitorFrames(db: Database.Database, competitor: { id: number; username: string }, options: FrameOptions, postIds?: number[]): Promise<FrameRunSummary> {
  const reels = selectFrameReels(db, competitor.id, options.limit, postIds);
  const summary: FrameRunSummary = { username: competitor.username, counts: { complete: 0, skipped: 0, failed: 0, no_video: 0 }, stoppedBy: null };
  options.log.info(`@${competitor.username}: ${reels.length} Reel(s).`);
  for (const [index, reel] of reels.entries()) {
    if (options.signal?.aborted) break;
    let outcome: FrameOutcome;
    try {
      outcome = await processReelFrames(db, reel, options);
    } catch (error) {
      throwIfStorageError(error);
      outcome = { shortcode: reel.shortcode, status: 'failed', detail: (error as Error).message };
    }
    if (outcome.status === 'interrupted') break;
    summary.counts[outcome.status] += 1;
    const line = `[${index + 1}/${reels.length}] ${reel.shortcode}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ''}`;
    if (outcome.status === 'failed') options.log.warn(line); else options.log.info(line);
  }
  if (options.signal?.aborted) summary.stoppedBy = 'interrupted';
  return summary;
}

export function formatFrameRun(s: FrameRunSummary): string {
  return [
    `Competitor: ${s.username}`,
    '',
    `Extracted: ${s.counts.complete}`,
    `Already done (use --force to redo): ${s.counts.skipped}`,
    `No downloaded video: ${s.counts.no_video}`,
    `Failed: ${s.counts.failed}`,
    ...(s.stoppedBy ? [`Stopped early: ${s.stoppedBy}`] : []),
  ].join('\n');
}
