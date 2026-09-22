// npm run export: SQLite stays the source of truth; this writes read-only copies for analysis.
//
//   data/exports/<username>/<username>.json   one normalized document (competitor + posts with everything nested)
//   data/exports/<username>/posts.csv         one row per post
//   data/exports/<username>/comments.csv      one row per comment
//   data/exports/<username>/metrics.csv       one row per metrics observation (engagement over time)
//
// Files are referenced by path (relative to DATA_DIR, given in export.data_dir), never embedded.

import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeUsername } from './competitors.js';

export const EXPORT_SCHEMA_VERSION = 1;
export type ExportFormat = 'json' | 'csv';

type Row = Record<string, unknown>;

const owned = `(p.competitor_id = @cid OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @cid))`;
const bool = (value: unknown): boolean | null => (value === null || value === undefined ? null : value === 1 || value === true);
const list = (json: unknown): string[] => {
  if (typeof json !== 'string') return [];
  try { const v: unknown = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};
const parsed = (json: unknown): unknown => {
  if (typeof json !== 'string') return null;
  try { return JSON.parse(json); } catch { return null; }
};

/** Groups child rows by post_id in one query per table instead of one per post. */
function byPost(db: Database.Database, sql: string, params: { cid: number; pid: number | null }): Map<number, Row[]> {
  const map = new Map<number, Row[]>();
  for (const row of db.prepare(sql).iterate(params) as Iterable<Row>) {
    const id = row.post_id as number;
    const rows = map.get(id) ?? [];
    rows.push(row);
    map.set(id, rows);
  }
  return map;
}

export interface ExportOptions {
  dataDir: string;
  /** Include Instagram's original payload per post (`raw`); large, and not needed for most analysis. */
  raw: boolean;
}

/** In-memory document for callers that need one; the CLI below writes one post at a time. */
export function buildCompetitorExport(db: Database.Database, competitorId: number, options: ExportOptions, postId?: number): Row {
  const c = db.prepare('SELECT * FROM competitors WHERE id = ?').get(competitorId) as Row | undefined;
  if (!c) throw new Error(`No competitor with id ${competitorId}`);
  const params = { cid: competitorId, pid: postId ?? null };
  const scope = postId === undefined ? owned : `p.id = @pid AND ${owned}`;
  const posts = db.prepare(`SELECT p.* FROM posts p WHERE ${scope} ORDER BY p.published_at IS NULL, p.published_at DESC, p.id`).all(params) as Row[];
  const history = byPost(db, `SELECT h.* FROM post_metrics_history h JOIN posts p ON p.id = h.post_id WHERE ${scope} ORDER BY h.observed_at, h.id`, params);
  const media = byPost(db, `SELECT m.* FROM media m JOIN posts p ON p.id = m.post_id WHERE ${scope} ORDER BY m.position`, params);
  const comments = byPost(db, `SELECT k.* FROM comments k JOIN posts p ON p.id = k.post_id WHERE ${scope} ORDER BY k.published_at IS NULL, k.published_at, k.id`, params);
  const frames = byPost(db, `SELECT f.* FROM reel_frames f JOIN posts p ON p.id = f.post_id WHERE ${scope} ORDER BY f.timestamp_seconds`, params);
  // Transcripts are append-only attempts; the latest one is current.
  const transcripts = byPost(db, `SELECT t.* FROM transcripts t JOIN posts p ON p.id = t.post_id WHERE ${scope}
    AND t.id = (SELECT max(t2.id) FROM transcripts t2 WHERE t2.post_id = t.post_id)`, params);

  return {
    export: { schema_version: EXPORT_SCHEMA_VERSION, exported_at: new Date().toISOString(), data_dir: options.dataDir, paths: 'relative to data_dir' },
    competitor: {
      username: c.username, display_name: c.display_name, bio: c.bio, profile_url: c.profile_url, external_url: c.external_url,
      followers_count: c.followers_count, following_count: c.following_count, posts_count: c.posts_count, verified: bool(c.verified),
      category: c.category, profile_image_path: c.profile_image_path, account_status: c.account_status,
      first_scraped_at: c.first_scraped_at, last_scraped_at: c.last_scraped_at,
    },
    posts: posts.map((p) => {
      const t = transcripts.get(p.id as number)?.[0];
      return {
        shortcode: p.shortcode, instagram_id: p.instagram_post_id, url: p.url, type: p.type, product_type: p.product_type,
        owner_username: p.owner_username, published_at: p.published_at,
        caption: p.caption, accessibility_caption: p.accessibility_caption, location: p.location,
        hashtags: list(p.hashtags_json), mentions: list(p.mentions_json), tagged_users: list(p.tagged_users_json), coauthors: list(p.coauthors_json),
        metrics: {
          likes: p.likes_count, likes_hidden: bool(p.likes_hidden), comments: p.comments_count, comments_disabled: bool(p.comments_disabled),
          views: p.views_count, plays: p.plays_count,
          history: (history.get(p.id as number) ?? []).map((h) => ({ observed_at: h.observed_at, likes: h.likes_count, comments: h.comments_count, views: h.views_count, plays: h.plays_count })),
        },
        reel: p.type === 'reel' ? {
          duration_seconds: p.duration_seconds,
          file: { duration_seconds: p.video_probe_duration, width: p.video_width, height: p.video_height, has_audio: bool(p.video_has_audio) },
          audio: { title: p.audio_title, artist: p.audio_artist, type: p.audio_type },
          status: p.reel_status, status_reason: p.reel_status_reason,
        } : null,
        thumbnail_path: p.thumbnail_path,
        media: (media.get(p.id as number) ?? []).map((m) => ({
          position: m.position, type: m.media_type, local_path: m.local_path, file_format: m.file_format, bytes: m.bytes, sha256: m.sha256,
          width: m.width, height: m.height, duration_seconds: m.duration_seconds, alt_text: m.alt_text, download_status: m.download_status,
        })),
        comments: (comments.get(p.id as number) ?? []).map((k) => ({
          id: k.instagram_comment_id, parent_id: k.parent_comment_id, username: k.username, text: k.text, likes: k.likes_count, published_at: k.published_at,
        })),
        transcript: t ? {
          text: t.transcript, language: t.language, has_speech: bool(t.has_speech), provider: t.provider, model: t.model,
          segments: parsed(t.segments_json), created_at: t.created_at,
        } : null,
        frames: (frames.get(p.id as number) ?? []).map((f) => ({ timestamp_seconds: f.timestamp_seconds, path: f.image_path })),
        status: {
          availability: p.availability, extraction: p.extraction_status, media: p.media_status, reel: p.reel_status, frames: p.frames_status,
          transcript: p.transcript_status, comments: p.comments_status, comments_completion: p.comments_completion,
        },
        first_scraped_at: p.first_scraped_at, last_scraped_at: p.last_scraped_at,
        ...(options.raw ? { raw: parsed(p.raw_json) } : {}),
      };
    }),
  };
}

// ---- CSV -----------------------------------------------------------------------------------------

/** RFC 4180: quote a field holding a comma, quote, CR or LF (or edge spaces), doubling inner quotes. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'boolean' ? (value ? 'true' : 'false') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Keep source text verbatim in JSON; prevent spreadsheet formulas from executing on CSV import.
  if (typeof value === 'string' && (/^[\t\r\n]/.test(text) || /^\s*[=+@-]/.test(text))) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

type ExportDoc = ReturnType<typeof buildCompetitorExport>;
type ExportPost = { shortcode: string; metrics: { history: Row[] } & Row; comments: Row[]; media: Row[]; frames: Row[]; transcript: Row | null; reel: Row | null } & Row;

/** The three CSV tables, derived from the JSON document so both formats always agree. */
export function csvTables(doc: ExportDoc): Record<'posts' | 'comments' | 'metrics', string> {
  const posts = doc.posts as ExportPost[];
  const username = (doc.competitor as Row).username;
  return {
    posts: toCsv(
      ['competitor', 'shortcode', 'url', 'type', 'product_type', 'owner_username', 'published_at', 'caption', 'hashtags', 'mentions', 'tagged_users',
        'coauthors', 'location', 'likes', 'likes_hidden', 'comments', 'comments_disabled', 'views', 'plays', 'duration_seconds', 'audio_title',
        'audio_artist', 'media_count', 'media_paths', 'thumbnail_path', 'comments_collected', 'frames_count', 'transcript', 'availability'],
      posts.map((p) => [username, p.shortcode, p.url, p.type, p.product_type, p.owner_username, p.published_at, p.caption,
        (p.hashtags as string[]).join(' '), (p.mentions as string[]).join(' '), (p.tagged_users as string[]).join(' '), (p.coauthors as string[]).join(' '),
        p.location, p.metrics.likes, p.metrics.likes_hidden, p.metrics.comments, p.metrics.comments_disabled, p.metrics.views, p.metrics.plays,
        p.reel?.duration_seconds ?? null, (p.reel?.audio as Row | undefined)?.title ?? null, (p.reel?.audio as Row | undefined)?.artist ?? null,
        p.media.length, p.media.map((m) => m.local_path).filter(Boolean).join(' '), p.thumbnail_path, p.comments.length, p.frames.length,
        p.transcript?.text ?? null, (p.status as Row).availability]),
    ),
    comments: toCsv(
      ['competitor', 'post_shortcode', 'comment_id', 'parent_comment_id', 'username', 'text', 'likes', 'published_at'],
      posts.flatMap((p) => p.comments.map((k) => [username, p.shortcode, k.id, k.parent_id, k.username, k.text, k.likes, k.published_at])),
    ),
    metrics: toCsv(
      ['competitor', 'post_shortcode', 'observed_at', 'likes', 'comments', 'views', 'plays'],
      posts.flatMap((p) => p.metrics.history.map((h) => [username, p.shortcode, h.observed_at, h.likes, h.comments, h.views, h.plays])),
    ),
  };
}

// ---- Files ---------------------------------------------------------------------------------------

/** Writes the requested formats into `<outDir>/<username>/` and returns the file paths. */
export function exportCompetitor(db: Database.Database, competitor: { id: number; username: string }, formats: ExportFormat[], outDir: string, options: ExportOptions): string[] {
  if (normalizeUsername(competitor.username) !== competitor.username) throw new Error('Invalid export username');
  const doc = buildCompetitorExport(db, competitor.id, options, -1);
  const dir = join(outDir, competitor.username);
  mkdirSync(dir, { recursive: true });
  const files = new Map<string, { path: string; tmp: string; fd: number }>();
  const open = (name: string): void => {
    const path = join(dir, name);
    const tmp = `${path}.${process.pid}.tmp`;
    files.set(name, { path, tmp, fd: openSync(tmp, 'w', 0o600) });
  };
  const write = (name: string, content: string): void => {
    const file = files.get(name);
    if (!file) return;
    const bytes = Buffer.from(content);
    for (let at = 0; at < bytes.length;) at += writeSync(file.fd, bytes, at, bytes.length - at);
  };
  const jsonName = `${competitor.username}.json`;
  try {
    if (formats.includes('json')) {
      open(jsonName);
      write(jsonName, `{\n  "export": ${JSON.stringify(doc.export)},\n  "competitor": ${JSON.stringify(doc.competitor)},\n  "posts": [\n`);
    }
    if (formats.includes('csv')) {
      for (const [name, header] of Object.entries(csvTables(doc))) { open(`${name}.csv`); write(`${name}.csv`, header); }
    }
    const ids = db.prepare(`SELECT p.id FROM posts p WHERE ${owned} ORDER BY p.published_at IS NULL, p.published_at DESC, p.id`);
    let first = true;
    // Bound memory by one post, even when the competitor has years of raw payloads and comments.
    for (const row of ids.iterate({ cid: competitor.id }) as Iterable<{ id: number }>) {
      const part = buildCompetitorExport(db, competitor.id, options, row.id);
      write(jsonName, `${first ? '' : ',\n'}${JSON.stringify((part.posts as Row[])[0], null, 2)}`);
      first = false;
      if (formats.includes('csv')) {
        for (const [name, table] of Object.entries(csvTables(part))) write(`${name}.csv`, table.slice(table.indexOf('\r\n') + 2));
      }
    }
    write(jsonName, '\n  ]\n}\n');
    for (const file of files.values()) { closeSync(file.fd); file.fd = -1; }
    for (const file of files.values()) renameSync(file.tmp, file.path);
    return [...files.values()].map((file) => file.path);
  } finally {
    for (const file of files.values()) {
      if (file.fd !== -1) closeSync(file.fd);
      rmSync(file.tmp, { force: true });
    }
  }
}
