import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import { ffmpegBin } from './frames.js';
import { probeMp4 } from './media-files.js';
import { MAX_FAILED_RUNS } from './post-scraper.js';
import type { Logger } from './logger.js';
import { TranscriptionServiceError, type TranscriptionProvider } from './transcription-provider.js';

const runFile = promisify(execFile);

interface Reel {
  id: number;
  shortcode: string;
  transcript_status: string;
  transcript_attempts: number;
  video_path: string | null;
  has_transcript: number;
}

export interface TranscriptOptions {
  dataDir: string;
  log: Logger;
  signal?: AbortSignal;
  force: boolean;
  provider: TranscriptionProvider;
}

export interface TranscriptSummary {
  username: string;
  counts: Record<'complete' | 'no_speech' | 'skipped' | 'no_video' | 'failed', number>;
}

function selectReels(db: Database.Database, competitorId: number, postIds?: number[]): Reel[] {
  const only = postIds ? `AND p.id IN (${postIds.map(Number).join(',') || 'NULL'})` : '';
  return db.prepare(`SELECT p.id, p.shortcode, p.transcript_status, p.transcript_attempts,
    EXISTS (SELECT 1 FROM transcripts t WHERE t.post_id = p.id) AS has_transcript,
    (SELECT m.local_path FROM media m WHERE m.post_id = p.id AND m.media_type = 'video'
      AND m.download_status = 'complete' ORDER BY m.position LIMIT 1) AS video_path
    FROM posts p WHERE p.type = 'reel'
    AND (p.reel_status IS NOT 'unavailable' OR EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id AND m.media_type = 'video' AND m.download_status = 'complete'))
    AND (p.competitor_id = ? OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = ?))
    ${only} ORDER BY p.id`).all(competitorId, competitorId) as Reel[];
}

async function extractAudio(videoPath: string, signal?: AbortSignal): Promise<{ path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'reel-audio-'));
  const path = join(dir, 'audio.mp3');
  try {
    await runFile(ffmpegBin(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', path,
    ], { timeout: 120_000, signal, maxBuffer: 1024 * 1024 });
    if (!existsSync(path) || statSync(path).size === 0) throw new Error('FFmpeg produced no audio');
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function processReelTranscript(db: Database.Database, reel: Reel, options: TranscriptOptions): Promise<keyof TranscriptSummary['counts'] | 'interrupted'> {
  if (!options.force && reel.transcript_status === 'complete' && reel.has_transcript) return 'skipped';
  if (!options.force && reel.transcript_status === 'failed' && reel.transcript_attempts >= MAX_FAILED_RUNS) return 'skipped';
  if (!reel.video_path) return 'no_video';
  try {
    const root = resolve(options.dataDir);
    const videoPath = resolve(root, reel.video_path);
    if (!videoPath.startsWith(root + sep)) throw new Error(`Video path escapes the data directory: ${reel.video_path}`);
    if (!existsSync(videoPath)) throw new Error('Downloaded video is missing');
    const hasAudio = probeMp4(videoPath).hasAudio;
    let result: Awaited<ReturnType<TranscriptionProvider['transcribe']>>;
    let provider = options.provider.name;
    let model: string | null = options.provider.model;
    if (!hasAudio) {
      provider = 'none';
      model = null;
      result = { transcript: '', language: null, segments: null, raw: { reason: 'no_audio_track' } };
    } else {
      const audio = await extractAudio(videoPath, options.signal);
      try { result = await options.provider.transcribe(audio.path, options.signal); }
      finally { audio.cleanup(); }
    }
    if (options.signal?.aborted) return 'interrupted';
    const transcript = result.transcript.trim();
    db.transaction(() => {
      db.prepare(`INSERT INTO transcripts (post_id, provider, model, language, transcript, segments_json, transcript_json, has_speech)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(reel.id, provider, model, result.language, transcript,
        result.segments === null ? null : JSON.stringify(result.segments), JSON.stringify(result.raw), Number(transcript.length > 0));
      db.prepare(`UPDATE posts SET transcript_status = 'complete', transcript_error = NULL, transcript_attempts = 0,
        transcript_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(reel.id);
    })();
    return transcript ? 'complete' : 'no_speech';
  } catch (error) {
    throwIfStorageError(error);
    if (options.signal?.aborted) return 'interrupted';
    if (error instanceof TranscriptionServiceError && error.stopsBatch) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A failed forced retry keeps the last successful transcript and its complete status.
    db.prepare(`UPDATE posts SET transcript_status = CASE WHEN transcript_status = 'complete' THEN 'complete' ELSE 'failed' END,
      transcript_attempts = transcript_attempts + (transcript_status != 'complete'),
      transcript_error = ?, transcript_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(message, reel.id);
    options.log.warn(`${reel.shortcode}: transcription failed (${message})`);
    return 'failed';
  }
}

export async function processCompetitorTranscripts(db: Database.Database, competitor: { id: number; username: string }, options: TranscriptOptions, postIds?: number[]): Promise<TranscriptSummary> {
  const reels = selectReels(db, competitor.id, postIds);
  const summary: TranscriptSummary = { username: competitor.username, counts: { complete: 0, no_speech: 0, skipped: 0, no_video: 0, failed: 0 } };
  for (const reel of reels) {
    if (options.signal?.aborted) break;
    const outcome = await processReelTranscript(db, reel, options);
    if (outcome === 'interrupted') break;
    summary.counts[outcome] += 1;
    options.log.info(`${reel.shortcode}: ${outcome}`);
  }
  return summary;
}

export function formatTranscriptRun(summary: TranscriptSummary): string {
  const { counts, username } = summary;
  return `@${username}: ${counts.complete} transcribed, ${counts.no_speech} no speech, ${counts.skipped} skipped, ${counts.no_video} without video, ${counts.failed} failed`;
}
