import type Database from 'better-sqlite3';

const USERNAME = /^[a-z0-9._]{1,30}$/;
const INSTAGRAM_URL = /^(https?:\/\/)?(www\.|m\.)?instagram\.com(\/|\?|#|$)/i;
// First path segments that are Instagram pages, not profiles.
const NOT_PROFILES = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct']);

/** Returns the normalized username, null for a blank or `#` comment line, and throws for anything else. */
export function normalizeUsername(raw: string): string | null {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;

  let name = line;
  if (INSTAGRAM_URL.test(line)) {
    // URL parsing drops the query string and fragment; the first path segment is the profile.
    name = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`).pathname.split('/')[1] ?? '';
    if (NOT_PROFILES.has(name.toLowerCase())) throw new Error(`Not a profile URL: ${line}`);
  }

  name = name.replace(/^@/, '').toLowerCase();
  if (!USERNAME.test(name) || /^\.+$/.test(name)) throw new Error(`Invalid Instagram username: ${line}`);
  return name;
}

/** Parses the whole file. Reports every bad line at once so nothing is half-imported. */
export function parseCompetitorList(text: string): string[] {
  const usernames = new Set<string>();
  const errors: string[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // Windows editors may prepend a BOM
  body.split(/\r?\n/).forEach((line, index) => {
    try {
      const name = normalizeUsername(line);
      if (name) usernames.add(name);
    } catch (error) {
      errors.push(`line ${index + 1}: ${(error as Error).message}`);
    }
  });
  if (errors.length > 0) throw new Error(`competitors.txt has invalid entries:\n  ${errors.join('\n  ')}`);
  return [...usernames];
}

export interface CompetitorRow {
  username: string;
  status: string;
  discovered: number;
  processed: number;
  lastScrapedAt: string | null;
}

/** Posts count for a competitor if it owns them or discovery found them on its profile (collabs).
 * "Processed" means the post's extraction finished (`extraction_status = 'complete'`). */
export function listCompetitors(db: Database.Database): CompetitorRow[] {
  return db.prepare(`
    WITH owned AS (
      SELECT competitor_id, id AS post_id FROM posts
      UNION SELECT competitor_id, post_id FROM competitor_posts
    ), counts AS (
      SELECT o.competitor_id, count(p.id) AS discovered,
        coalesce(sum(p.extraction_status = 'complete'), 0) AS processed
      FROM owned o JOIN posts p ON p.id = o.post_id GROUP BY o.competitor_id
    )
    SELECT c.username, c.account_status AS status, c.last_scraped_at AS lastScrapedAt,
      coalesce(counts.discovered, 0) AS discovered, coalesce(counts.processed, 0) AS processed
    FROM competitors c LEFT JOIN counts ON counts.competitor_id = c.id
    WHERE c.archived_at IS NULL
    ORDER BY c.username
  `).all() as CompetitorRow[];
}

export function formatCompetitors(rows: CompetitorRow[]): string {
  const table = [
    ['USERNAME', 'STATUS', 'DISCOVERED', 'PROCESSED', 'LAST SCRAPE'],
    ...rows.map((r) => [r.username, r.status, String(r.discovered), String(r.processed), r.lastScrapedAt ?? 'never']),
  ];
  return formatTable(table);
}

/** Left-aligned columns, two spaces apart; the first row is the header. */
export function formatTable(table: string[][]): string {
  const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => [...(row[col] ?? '')].length)));
  return table.map((row) => row.map((cell, col) => cell.padEnd(widths[col]! + cell.length - [...cell].length)).join('  ').trimEnd()).join('\n');
}
