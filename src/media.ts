import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { Logger } from './logger.js';
import { checkMediaFile, commitMediaFile, isExpired, itemStem, postDir, relativeToData, urlExpiry, type FileFormat } from './media-files.js';
import { delay } from './profile-scraper.js';

const ATTEMPTS_PER_RUN = 3;
const BACKOFF_MS = [2_000, 6_000];
/** Downloads a media item may fail across runs before it is left alone. A fresh URL resets the count. */
export const MAX_DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_BYTES = 1024 * 1024 * 1024;
// ponytail: fixed small pause between CDN downloads; make it configurable if needed.
const PACING_MS = [300, 900] as const;

export interface MediaOptions {
  dataDir: string;
  log: Logger;
  signal?: AbortSignal;
  limit: number | null;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: replaces global fetch. */
  fetch?: typeof fetch;
}

/** CDN answered 429: stop the run rather than push on. */
export class MediaRateLimitedError extends Error {}

class DownloadError extends Error {
  constructor(message: string, readonly type: string, readonly retryable: boolean) {
    super(message);
  }
}

interface PostRow {
  id: number;
  shortcode: string;
  url: string;
  owner: string;
  caption: string | null;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  raw_json: string | null;
  [column: string]: unknown;
}

interface MediaRow {
  id: number;
  position: number;
  media_type: string;
  source_url: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  alt_text: string | null;
  local_path: string | null;
  bytes: number | null;
  sha256: string | null;
  file_format: string | null;
  download_status: string;
  download_attempts: number;
  last_error: string | null;
}

type ItemResult = 'saved' | 'kept' | 'failed';

export interface PostMediaResult {
  shortcode: string;
  saved: number;
  kept: number;
  failed: number;
  expired: number;
  status: 'complete' | 'failed';
}

// ---- Selection -----------------------------------------------------------------------------------

/**
 * Extracted posts of a competitor, in discovery order. Media always lives under the post's primary competitor
 * (posts.competitor_id), so a collab post found on two profiles is stored once.
 */
export function selectMediaPosts(db: Database.Database, competitorId: number, limit: number | null, postIds?: number[]): PostRow[] {
  const byId = postIds ? `AND p.id IN (${postIds.map(Number).join(',') || 'NULL'})` : '';
  return db.prepare(`SELECT p.id, p.shortcode, p.url, p.caption, p.thumbnail_url, p.thumbnail_path, owner.username AS owner
    FROM posts p JOIN competitors owner ON owner.id = p.competitor_id
    WHERE p.extraction_status = 'complete'
      AND (p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))
      ${byId}
    ORDER BY (p.media_status = 'complete'), p.id LIMIT @limit`).all({ cid: competitorId, limit: limit ?? -1 }) as PostRow[];
}

// ---- Per post ------------------------------------------------------------------------------------

/**
 * Makes a post's folder complete: every media item downloaded and verified, a video thumbnail, caption.txt and
 * metadata.json. Valid files already on disk are kept, never re-downloaded or overwritten. Media problems are
 * recorded on `media`/`posts.media_status`/`scrape_errors`; `extraction_status` is never touched.
 */
export async function processPostMedia(db: Database.Database, post: PostRow, competitorId: number, options: MediaOptions): Promise<PostMediaResult> {
  const dir = postDir(options.dataDir, post.owner, post.shortcode);
  const mediaDir = join(dir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  guardAgainstCollision(dir, post.shortcode);
  db.prepare("UPDATE posts SET media_status = 'in_progress' WHERE id = ?").run(post.id);
  for (const name of readdirSync(mediaDir)) if (name.endsWith('.part')) unlinkSync(join(mediaDir, name)); // leftovers from a crash

  const items = db.prepare('SELECT * FROM media WHERE post_id = ? ORDER BY position').all(post.id) as MediaRow[];
  const result: PostMediaResult = { shortcode: post.shortcode, saved: 0, kept: 0, failed: 0, expired: 0, status: 'complete' };
  if (items.length === 0) {
    recordError(db, competitorId, post, null, 'no_media_items', 'Extraction found no media items for this post (it was extracted from page fallbacks only).', false, 1);
    result.failed += 1;
  }
  for (const item of items) {
    if (options.signal?.aborted) break;
    const outcome = await ensureItem(db, competitorId, post, item, mediaDir, options);
    result[outcome] += 1;
    if (outcome === 'failed' && (db.prepare('SELECT last_error FROM media WHERE id = ?').get(item.id) as { last_error: string | null }).last_error?.startsWith('url_expired')) result.expired += 1;
  }
  const hasVideo = items.some((item) => item.media_type === 'video');
  if (hasVideo && post.thumbnail_url && !options.signal?.aborted) await ensureThumbnail(db, post, mediaDir, options);

  if (options.signal?.aborted) return { ...result, status: 'failed' };
  result.status = result.failed === 0 && items.length > 0 ? 'complete' : 'failed';
  db.prepare('UPDATE posts SET media_status = ? WHERE id = ?').run(result.status, post.id);
  if (result.status === 'complete') {
    db.prepare(`UPDATE scrape_errors SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id = ? AND stage = 'media' AND resolved_at IS NULL`).run(post.id);
  }
  writeIfChanged(join(dir, 'caption.txt'), post.caption ?? '');
  writeIfChanged(join(dir, 'metadata.json'), `${JSON.stringify(metadataSnapshot(db, post, options.dataDir, dir), null, 2)}\n`);
  return result;
}

/** On a case-insensitive filesystem, shortcodes differing only in case would share a folder. Refuse to mix them. */
function guardAgainstCollision(dir: string, shortcode: string): void {
  const path = join(dir, 'metadata.json');
  if (!existsSync(path)) return;
  try {
    const existing = (JSON.parse(readFileSync(path, 'utf8')) as { shortcode?: unknown }).shortcode;
    if (typeof existing === 'string' && existing !== shortcode) {
      throw new Error(`Folder ${dir} already belongs to post ${existing}; this filesystem is case-insensitive. Use a case-sensitive DATA_DIR.`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return; // damaged metadata.json is simply rewritten
    throw error;
  }
}

async function ensureItem(db: Database.Database, competitorId: number, post: PostRow, item: MediaRow, mediaDir: string, options: MediaOptions): Promise<ItemResult> {
  const stem = itemStem(item.position);
  const label = `${post.shortcode} #${stem}`;

  // 1. Already recorded and still intact: nothing to do (size check only; no network, no hashing).
  if (item.download_status === 'complete' && item.local_path && item.bytes !== null) {
    const path = join(options.dataDir, item.local_path);
    if (existsSync(path) && statSync(path).size === item.bytes && checkMediaFile(path).ok) return 'kept';
    options.log.warn(`  ${label}: recorded file is missing or changed size; checking again`);
    db.prepare("UPDATE media SET download_status = 'pending', local_path = NULL, bytes = NULL, sha256 = NULL WHERE id = ?").run(item.id);
  }
  // 2. A valid file for this position is on disk but not recorded (e.g. the DB was restored): adopt it.
  //    An invalid one is moved aside, never silently overwritten.
  for (const name of readdirSync(mediaDir).filter((n) => n.startsWith(`${stem}.`) && !n.includes('.corrupt-'))) {
    const path = join(mediaDir, name);
    const check = checkMediaFile(path);
    if (check.ok && check.format && (expectedFormats(item.media_type)?.includes(check.format) ?? true)) {
      markComplete(db, item.id, relativeToData(options.dataDir, path), check.bytes, await hashFile(path), check.format);
      return 'kept';
    }
    const aside = `${path}.corrupt-${Date.now()}`;
    renameSync(path, aside);
    options.log.warn(`  ${label}: existing ${name} is invalid (${check.reason}); moved to ${aside.split('/').at(-1)}`);
  }

  // 3. Download, unless there is nothing legitimate to download.
  const fail = (type: string, message: string, retryable: boolean, attempts: number, countAttempt = true): ItemResult => {
    db.prepare(`UPDATE media SET download_status = 'failed', last_error = ?, download_attempts = download_attempts + ? WHERE id = ?`)
      .run(`${type}: ${message}`, countAttempt ? 1 : 0, item.id);
    recordError(db, competitorId, post, item, type, `item ${stem}: ${message}`, retryable, attempts);
    options.log.warn(`  ${label}: ${type}: ${message}`);
    return 'failed';
  };
  if (!item.source_url) return fail('no_source_url', 'Instagram exposed no URL for this item', false, 1);
  if (isExpired(item.source_url)) {
    return fail('url_expired', `signed URL expired at ${urlExpiry(item.source_url)?.toISOString()}; refresh it with --refresh-expired`, true, 1, false);
  }
  if (item.download_attempts >= MAX_DOWNLOAD_ATTEMPTS) return 'failed'; // given up until extraction supplies a new URL

  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  for (let attempt = 1; ; attempt += 1) {
    await sleep(PACING_MS[0] + Math.random() * (PACING_MS[1] - PACING_MS[0]));
    if (options.signal?.aborted) return 'failed';
    const tmp = join(mediaDir, `.${stem}.${process.pid}.part`);
    try {
      const { bytes, sha256 } = await download(item.source_url, tmp, options);
      const check = checkMediaFile(tmp);
      if (!check.ok || !check.format) throw new DownloadError(`downloaded file failed verification: ${check.reason}`, 'corrupt_download', true);
      if (check.bytes !== bytes) throw new DownloadError(`size changed while saving (${bytes} vs ${check.bytes})`, 'corrupt_download', true);
      const expected = expectedFormats(item.media_type);
      if (expected && !expected.includes(check.format)) {
        throw new DownloadError(`expected ${item.media_type}, got a ${check.format} file`, 'wrong_media_type', false);
      }
      const final = join(mediaDir, `${stem}.${check.format}`);
      commitMediaFile(tmp, final);
      markComplete(db, item.id, relativeToData(options.dataDir, final), bytes, sha256, check.format);
      return 'saved';
    } catch (error) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throwIfStorageError(error);
      if (error instanceof MediaRateLimitedError) throw error;
      if (options.signal?.aborted) return 'failed';
      const e = error instanceof DownloadError ? error : new DownloadError((error as Error).message, /abort|timeout/i.test((error as Error).name) ? 'timeout' : 'network', true);
      // An expired signature will not heal by retrying; it needs a fresh URL (not counted against the item).
      if (e.type === 'url_expired') return fail(e.type, e.message, true, attempt, false);
      if (e.retryable && attempt < ATTEMPTS_PER_RUN) {
        const wait = BACKOFF_MS[attempt - 1] ?? 6_000;
        options.log.warn(`  ${label}: ${e.type} (attempt ${attempt}/${ATTEMPTS_PER_RUN}); retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      return fail(e.type, e.message, e.retryable, attempt);
    }
  }
}

function expectedFormats(mediaType: string): FileFormat[] | null {
  if (mediaType === 'image') return ['jpg', 'png', 'webp', 'gif', 'heic', 'avif'];
  if (mediaType === 'video') return ['mp4', 'mov'];
  return null;
}

/** Streams the response into `tmp`, hashing as it goes. Checks status, content type and declared length. */
async function download(url: string, tmp: string, options: MediaOptions): Promise<{ bytes: number; sha256: string }> {
  const signals = [AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
  const signal = AbortSignal.any(signals);
  const response = await (options.fetch ?? fetch)(url, { signal, redirect: 'error' });
  try {
    if (!response.ok) {
      const reader = response.body?.getReader();
      const first = await reader?.read();
      const body = first?.value ? Buffer.from(first.value).toString('utf8').slice(0, 200) : '';
      reader?.releaseLock();
      if (response.status === 429) throw new MediaRateLimitedError('The media CDN returned HTTP 429 (too many requests). Stopping; try again later.');
      if ((response.status === 403 || response.status === 410) && /expire/i.test(body)) {
        throw new DownloadError('CDN says the signed URL has expired; refresh it with --refresh-expired', 'url_expired', true);
      }
      if (response.status >= 500) throw new DownloadError(`HTTP ${response.status}`, 'http_error', true);
      // 403/404 without an expiry: the CDN will not serve it to us. Not retried within the run; no workaround is attempted.
      throw new DownloadError(`HTTP ${response.status} ${body.replace(/\s+/g, ' ').trim()}`.trim(), 'not_retrievable', false);
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/^(image|video)\//.test(type) && type !== 'application/octet-stream' && type !== '') {
      throw new DownloadError(`server sent ${type}, not media`, 'not_media', true);
    }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > MAX_BYTES) throw new DownloadError(`file is larger than ${MAX_BYTES} bytes`, 'too_large', false);
    if (!response.body) throw new DownloadError('empty response body', 'corrupt_download', true);

    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return callback(new DownloadError(`file is larger than ${MAX_BYTES} bytes`, 'too_large', false));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), tap, createWriteStream(tmp, { flags: 'wx' }), { signal });
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd); // the bytes are on disk before the rename makes the file visible
    } finally {
      closeSync(fd);
    }
    if (Number.isFinite(declared) && declared !== bytes) {
      throw new DownloadError(`incomplete download: ${bytes} of ${declared} bytes`, 'partial_download', true);
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function ensureThumbnail(db: Database.Database, post: PostRow, mediaDir: string, options: MediaOptions): Promise<void> {
  const existing = readdirSync(mediaDir).find((n) => /^thumbnail\.[a-z0-9]+$/.test(n));
  if (existing && checkMediaFile(join(mediaDir, existing)).ok) {
    const rel = relativeToData(options.dataDir, join(mediaDir, existing));
    if (post.thumbnail_path !== rel) db.prepare('UPDATE posts SET thumbnail_path = ? WHERE id = ?').run(rel, post.id);
    return;
  }
  if (!post.thumbnail_url || isExpired(post.thumbnail_url)) return;
  const tmp = join(mediaDir, `.thumbnail.${process.pid}.part`);
  try {
    await download(post.thumbnail_url, tmp, options);
    const check = checkMediaFile(tmp);
    if (!check.ok || !check.format || !expectedFormats('image')!.includes(check.format)) throw new Error(check.reason ?? 'not an image');
    const final = join(mediaDir, `thumbnail.${check.format}`);
    commitMediaFile(tmp, final);
    db.prepare('UPDATE posts SET thumbnail_path = ? WHERE id = ?').run(relativeToData(options.dataDir, final), post.id);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throwIfStorageError(error);
    if (error instanceof MediaRateLimitedError) throw error;
    options.log.warn(`  ${post.shortcode} thumbnail not saved (${(error as Error).message}); the video itself is unaffected`);
  }
}

function markComplete(db: Database.Database, mediaId: number, localPath: string, bytes: number, sha256: string, format: string): void {
  db.prepare(`UPDATE media SET local_path = ?, bytes = ?, sha256 = ?, file_format = ?, download_status = 'complete',
    downloaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL WHERE id = ?`).run(localPath, bytes, sha256, format, mediaId);
}

function recordError(db: Database.Database, competitorId: number, post: PostRow, item: MediaRow | null, type: string, message: string, retryable: boolean, attempt: number): void {
  db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, url, stage, error_type, error_message, retryable, attempt)
    VALUES (?, ?, ?, 'media', ?, ?, ?, ?)`).run(competitorId, post.id, item?.source_url ?? post.url, type, message, Number(retryable), attempt);
}

function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  return pipeline(createReadStream(path), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) hash.update(chunk);
  }).then(() => hash.digest('hex'));
}

/** Atomic small-file write that leaves the file (and its mtime) alone when the content is unchanged. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** metadata.json: the post's normalized fields, its media files, and Instagram's untouched media object. */
function metadataSnapshot(db: Database.Database, post: PostRow, dataDir: string, dir: string) {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id) as Record<string, unknown>;
  const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
  const items = db.prepare('SELECT * FROM media WHERE post_id = ? ORDER BY position').all(post.id) as MediaRow[];
  const local = (p: string | null): string | null => (p ? join(dataDir, p).slice(dir.length + 1) : null);
  return {
    version: 1,
    shortcode: post.shortcode,
    url: post.url,
    competitor: post.owner,
    post: {
      instagram_post_id: row.instagram_post_id, type: row.type, product_type: row.product_type, owner_username: row.owner_username,
      caption: row.caption, hashtags: parse(row.hashtags_json), mentions: parse(row.mentions_json),
      tagged_users: parse(row.tagged_users_json), coauthors: parse(row.coauthors_json), location: row.location,
      published_at: row.published_at, accessibility_caption: row.accessibility_caption,
      likes_count: row.likes_count, likes_hidden: row.likes_hidden === null ? null : row.likes_hidden === 1,
      comments_count: row.comments_count, comments_disabled: row.comments_disabled === null ? null : row.comments_disabled === 1,
      views_count: row.views_count, plays_count: row.plays_count, duration_seconds: row.duration_seconds,
      audio_title: row.audio_title, audio_artist: row.audio_artist, audio_type: row.audio_type,
      width: row.width, height: row.height, carousel_count: row.carousel_count,
      first_scraped_at: row.first_scraped_at, last_scraped_at: row.last_scraped_at, media_status: row.media_status,
    },
    thumbnail: { file: local(row.thumbnail_path as string | null), source_url: row.thumbnail_url },
    media: items.map((m) => ({
      position: m.position + 1, file: local(m.local_path), media_type: m.media_type, file_format: m.file_format,
      bytes: m.bytes, sha256: m.sha256, width: m.width, height: m.height, duration_seconds: m.duration_seconds,
      alt_text: m.alt_text, source_url: m.source_url, download_status: m.download_status, last_error: m.last_error,
    })),
    raw: parse(row.raw_json),
  };
}

// ---- Per competitor / batch ----------------------------------------------------------------------

export interface MediaRunSummary {
  username: string;
  posts: number;
  complete: number;
  saved: number;
  kept: number;
  failed: number;
  expiredPostIds: number[];
  expiredPostFailures: number;
  browserBlocked?: boolean;
  stoppedBy: string | null;
}

export async function processCompetitorMedia(db: Database.Database, competitor: { id: number; username: string }, options: MediaOptions, postIds?: number[]): Promise<MediaRunSummary> {
  const posts = selectMediaPosts(db, competitor.id, options.limit, postIds);
  const summary: MediaRunSummary = { username: competitor.username, posts: posts.length, complete: 0, saved: 0, kept: 0, failed: 0, expiredPostIds: [], expiredPostFailures: 0, stoppedBy: null };
  if (!postIds) options.log.info(`@${competitor.username}: ${posts.length} extracted post(s) to check.`);
  for (const [index, post] of posts.entries()) {
    if (options.signal?.aborted) { summary.stoppedBy = 'interrupted'; break; }
    try {
      const r = await processPostMedia(db, post, competitor.id, options);
      summary.saved += r.saved;
      summary.kept += r.kept;
      summary.failed += r.failed;
      if (r.status === 'complete') summary.complete += 1;
      if (r.expired) {
        summary.expiredPostIds.push(post.id);
        summary.expiredPostFailures += r.failed;
      }
      const line = `[${index + 1}/${posts.length}] ${post.shortcode}: ${r.saved} saved, ${r.kept} already there, ${r.failed} failed`;
      if (r.failed) options.log.warn(line); else options.log.info(line);
    } catch (error) {
      throwIfStorageError(error);
      if (error instanceof MediaRateLimitedError) { summary.stoppedBy = 'rate_limited'; options.log.error(error.message); break; }
      summary.failed += 1;
      db.prepare("UPDATE posts SET media_status = 'failed' WHERE id = ?").run(post.id);
      options.log.error(`[${index + 1}/${posts.length}] ${post.shortcode}: ${(error as Error).message}`);
      db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, url, stage, error_type, error_message, retryable, attempt)
        VALUES (?, ?, ?, 'media', 'unexpected', ?, 0, 1)`).run(competitor.id, post.id, post.url, (error as Error).message);
    }
  }
  if (options.signal?.aborted) summary.stoppedBy = 'interrupted';
  return summary;
}

export function formatMediaRun(s: MediaRunSummary): string {
  return [
    `Competitor: ${s.username}`,
    '',
    `Posts checked: ${s.posts}`,
    `Posts with all media saved: ${s.complete}`,
    `Files downloaded: ${s.saved}`,
    `Files already present (kept): ${s.kept}`,
    `Items failed: ${s.failed}${s.expiredPostIds.length ? ` (${s.expiredPostIds.length} post(s) with expired links; use --refresh-expired)` : ''}`,
    ...(s.stoppedBy ? [`Stopped early: ${s.stoppedBy}`] : []),
  ].join('\n');
}
