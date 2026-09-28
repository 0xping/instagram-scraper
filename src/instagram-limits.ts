import type Database from 'better-sqlite3';
import type { BrowserContext } from 'playwright';
import { CHALLENGE_PATH } from './instagram-session.js';

/** How long collecting waits after Instagram pushes back (too many requests, or a security check). */
export const PAUSE_HOURS = 24;

/** The local date: the daily limit resets at the user's midnight, not UTC's. */
const today = (now = new Date()): string => now.toLocaleDateString('sv');
const isInstagram = (url: string): boolean => {
  try { const host = new URL(url).hostname; return host === 'instagram.com' || host.endsWith('.instagram.com'); } catch { return false; }
};

export function pagesToday(db: Database.Database, now = new Date()): number {
  return (db.prepare('SELECT opened FROM instagram_pages WHERE day = ?').get(today(now)) as { opened: number } | undefined)?.opened ?? 0;
}

/** The latest pushback within the pause window, and when collecting may start again; null when it may now. */
export function instagramPause(db: Database.Database, now = new Date()): { at: string; until: string; reason: string } | null {
  const since = new Date(now.getTime() - PAUSE_HOURS * 3_600_000).toISOString();
  const row = db.prepare(`SELECT at, reason FROM (
      SELECT created_at AS at, error_type || ': ' || error_message AS reason FROM scrape_errors WHERE error_type IN ('rate_limited', 'security_challenge')
      UNION ALL SELECT at, reason FROM instagram_pushback)
    WHERE at > ? ORDER BY at DESC LIMIT 1`).get(since) as { at: string; reason: string } | undefined;
  return row ? { ...row, until: new Date(Date.parse(row.at) + PAUSE_HOURS * 3_600_000).toISOString() } : null;
}

/** Throws, in words that say what to do, when collecting now would risk the Instagram account. */
export function assertMayCollect(db: Database.Database, limit: number | null, now = new Date()): void {
  const pause = instagramPause(db, now);
  if (pause) {
    throw new Error(`Instagram pushed back at ${new Date(pause.at).toLocaleString()} (${pause.reason.split('\n')[0]}). `
      + `Collecting is paused until ${new Date(pause.until).toLocaleString()} to protect the account. `
      + 'To collect anyway, press Collect anyway in the dashboard or add --ignore-limits to scrape.');
  }
  const opened = pagesToday(db, now);
  if (limit !== null && opened >= limit) {
    throw new Error(`Today's limit is used up: ${opened} Instagram pages opened (limit ${limit}). It resets at midnight; `
      + 'change it in the dashboard Settings (DAILY_PAGE_LIMIT), or add --ignore-limits to scrape.');
  }
}

/**
 * Counts every instagram.com page this browser opens against the day's limit, and records Instagram pushing back
 * (HTTP 429, or a jump to a security-check page). At the limit it calls `stop` once: the run ends as if Stop had
 * been pressed, which keeps every post's progress for tomorrow.
 */
export function watchInstagram(db: Database.Database, context: BrowserContext, limit: number | null, stop: (reason: string) => void): void {
  const count = db.prepare(`INSERT INTO instagram_pages (day, opened) VALUES (?, 1)
    ON CONFLICT (day) DO UPDATE SET opened = opened + 1 RETURNING opened`);
  const pushback = db.prepare('INSERT INTO instagram_pushback (reason) VALUES (?)');
  let stopped = false;
  context.on('request', (request) => {
    // Pages only: the images, videos and data requests inside a page are not counted.
    if (!request.isNavigationRequest() || request.frame().parentFrame() || !isInstagram(request.url())) return;
    const { opened } = count.get(today()) as { opened: number };
    if (CHALLENGE_PATH.test(new URL(request.url()).pathname)) pushback.run('security_challenge: Instagram opened a security check');
    if (limit !== null && opened >= limit && !stopped) {
      stopped = true;
      stop(`Daily limit reached: ${opened} Instagram pages opened today (limit ${limit}). Stopping; the rest continues tomorrow.`);
    }
  });
  context.on('response', (response) => {
    if (response.status() === 429 && isInstagram(response.url())) pushback.run(`rate_limited: HTTP 429 from ${new URL(response.url()).pathname}`);
  });
}
