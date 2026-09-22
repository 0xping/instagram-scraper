import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { errors, type BrowserContext, type Page, type Response } from 'playwright';
import { waitForResponses } from './browser.js';
import type Database from 'better-sqlite3';
import { throwIfStorageError } from './db.js';
import type { Logger } from './logger.js';
import { ManualInterventionError, SessionExpiredError, type InstagramSessionManager } from './instagram-session.js';
import { ExtractionError, extractProfile, RATE_LIMIT_TEXT, type PageSnapshot, type ProfileExtraction } from './profile-extract.js';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [5_000, 15_000];
const SETTLE_MS = 1_500;
const READY_TIMEOUT_MS = 10_000;
// ponytail: fixed jittered pacing between profiles; make it configurable if a larger list needs tuning.
export const PACING_MS = [6_000, 12_000] as const;

/** Instagram is throttling this session. Continuing would make it worse, so the whole batch stops. */
export class RateLimitedError extends Error {}

/** Errors that make every later profile fail too; the batch stops on these. */
export function isBatchFatal(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof ManualInterventionError || error instanceof RateLimitedError || isBrowserCrash(error);
}

function isBrowserCrash(error: unknown): boolean {
  return error instanceof Error && /Target (?:page, context or )?browser has been closed|Browser closed|browser.*disconnected|(?:Target|Page) crashed/i.test(error.message);
}

export interface ScrapeOptions {
  dataDir: string;
  log: Logger;
  signal?: AbortSignal;
  /** Test hook; production waits between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ProfileResult extends ProfileExtraction {
  username: string;
  profileUrl: string;
  profileImagePath: string | null;
  collectedAt: string;
  finalUrl: string;
  httpStatus: number | null;
  attempts: number;
}

export interface ScrapeFailure {
  type: string;
  message: string;
  retryable: boolean;
  attempts: number;
  url: string;
  debugFiles: string[];
}

export const profileUrl = (username: string): string => `https://www.instagram.com/${username}/`;

/** Loads one profile, with retries for transient failures. Throws ProfileScrapeError after writing debug files. */
export async function scrapeProfile(
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  username: string,
  options: ScrapeOptions,
): Promise<ProfileResult> {
  const { page, result } = await openProfile(context, session, username, options);
  await page.close().catch(() => undefined);
  return result;
}

/**
 * Like scrapeProfile, but leaves the loaded profile page open for the caller (post discovery scrolls it).
 * The caller must close the page.
 */
export async function openProfile(
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  username: string,
  options: ScrapeOptions,
): Promise<{ page: Page; result: ProfileResult }> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
  const url = profileUrl(username);
  for (let attempt = 1; ; attempt += 1) {
    const page = await context.newPage();
    try {
      const loaded = await loadProfile(page, session, username);
      const extraction = extractProfile(loaded.snapshot, username);
      const profileImagePath = extraction.fields.profileImageUrl
        ? await downloadProfileImage(context, extraction.fields.profileImageUrl, username, options)
        : null;
      const result: ProfileResult = {
        ...extraction,
        username,
        profileUrl: url,
        profileImagePath,
        collectedAt: new Date().toISOString(),
        finalUrl: page.url(),
        httpStatus: loaded.snapshot.httpStatus,
        attempts: attempt,
      };
      return { page, result };
    } catch (error) {
      throwIfStorageError(error);
      const failure = classify(error, attempt, url);
      const willRetry = failure.retryable && attempt < MAX_ATTEMPTS && !isBatchFatal(error) && !options.signal?.aborted;
      if (willRetry) {
        const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 15_000;
        options.log.warn(`@${username}: ${failure.type} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${wait / 1000}s (${failure.message})`);
        await page.close().catch(() => undefined);
        await sleep(wait);
        continue;
      }
      if (!options.signal?.aborted) failure.debugFiles = await writeDebugFiles(page, username, failure, options);
      await page.close().catch(() => undefined);
      throw new ProfileScrapeError(failure, error);
    }
  }
}

export class ProfileScrapeError extends Error {
  constructor(readonly failure: ScrapeFailure, readonly original: unknown) {
    super(failure.message);
  }
}

async function loadProfile(page: Page, session: Pick<InstagramSessionManager, 'inspect'>, username: string) {
  const networkJson: string[] = [];
  const pendingBodies: Array<Promise<void>> = [];
  const mentionsUser = new RegExp(`"username"\\s*:\\s*"${username.replace(/\./g, '\\.')}"`, 'i');
  const onResponse = (response: Response): void => {
    const type = response.headers()['content-type'] ?? '';
    if (!/instagram\.com\//.test(response.url()) || !/json|javascript/.test(type)) return;
    pendingBodies.push(response.text().then((text) => {
      if (text.length < 5_000_000 && mentionsUser.test(text)) networkJson.push(text);
    }, () => undefined));
  };
  page.on('response', onResponse);

  try {
    const response = await page.goto(profileUrl(username), { waitUntil: 'domcontentloaded' });
    const httpStatus = response?.status() ?? null;
    if (httpStatus === 429) throw new RateLimitedError('Instagram returned HTTP 429 (too many requests). Stopping; try again later.');
    if (httpStatus !== null && httpStatus >= 500) throw new ExtractionError(`Instagram returned HTTP ${httpStatus}`, 'http_error', true);

    // Server-rendered meta/JSON is present at DOMContentLoaded; this waits for client rendering or an error page.
    await page.waitForFunction(() =>
      document.querySelector('meta[property="og:type"][content="profile"], main header, h2, input[name="password"]') !== null,
    undefined, { timeout: READY_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);

    const state = await session.inspect(page);
    if (state === 'challenge') {
      throw new ManualInterventionError('Instagram is showing a security challenge. Manual intervention is required: run `npm run instagram:login` and complete it in the browser window. This tool does not bypass it.');
    }
    if (state === 'logged_out') throw new SessionExpiredError('Instagram session expired during scraping. Run: npm run instagram:login');

    await waitForResponses(pendingBodies);
    const snapshot = await captureSnapshot(page, username, httpStatus, networkJson);
    try {
      extractProfile(snapshot, username); // cheap dry run to spot throttling pages before the real extraction
    } catch (error) {
      if (error instanceof ExtractionError && RATE_LIMIT_TEXT.test(snapshot.dom.bodyText)) {
        throw new RateLimitedError('Instagram asked to wait before trying again (rate limited). Stopping; try again later.');
      }
    }
    return { snapshot };
  } finally {
    // Discovery keeps this page open for thousands of scrolls; stop retaining profile response bodies now.
    page.off('response', onResponse);
  }
}

async function captureSnapshot(page: Page, username: string, httpStatus: number | null, networkJson: string[]): Promise<PageSnapshot> {
  const inPage = await page.evaluate((user) => {
    const mentionsUser = new RegExp(`"username"\\s*:\\s*"${user.replace(/\./g, '\\.')}"`, 'i');
    const meta: Record<string, string> = {};
    for (const tag of document.querySelectorAll('meta[property^="og:"], meta[name="description"]')) {
      const key = tag.getAttribute('property') ?? tag.getAttribute('name');
      const content = tag.getAttribute('content');
      if (key && content) meta[key] = content;
    }
    const jsonTexts = [...document.querySelectorAll('script[type="application/json"]')]
      .map((script) => script.textContent ?? '')
      .filter((text) => mentionsUser.test(text));

    // Counts: the followers/following links are addressed by href (e.g. /user/followers/ or /user/followers/mutualOnly);
    // the exact number is in a title attribute when present.
    const countLink = (kind: string): string | null => {
      const link = [...document.querySelectorAll('a[href]')].find((a) =>
        (a.getAttribute('href')?.toLowerCase() ?? '').startsWith(`/${user}/${kind}/`));
      if (!link) return null;
      return link.querySelector('[title]')?.getAttribute('title') ?? link.textContent;
    };
    const header = document.querySelector('main header') ?? document.querySelector('header');
    const external = header?.querySelector('a[href*="l.instagram.com/"]') ??
      [...(header?.querySelectorAll('a[href^="http"]') ?? [])].find((a) => !/instagram\.com/.test(a.getAttribute('href') ?? ''));
    const avatar = header?.querySelector(`img[alt*="${user}" i], img[alt*="profile picture" i]`) ?? header?.querySelector('img');
    return {
      title: document.title,
      meta,
      jsonTexts,
      dom: {
        followers: countLink('followers'),
        following: countLink('following'),
        headerText: header?.textContent ?? null,
        verified: Boolean(header?.querySelector('svg[aria-label="Verified" i], [title="Verified" i]')),
        externalHref: external?.getAttribute('href') ?? null,
        avatarSrc: avatar?.getAttribute('src') ?? null,
        headings: [...document.querySelectorAll('h1, h2')].map((h) => h.textContent?.trim() ?? '').filter(Boolean).slice(0, 10),
        bodyText: (document.body?.innerText ?? '').slice(0, 4000),
      },
    };
  }, username.toLowerCase());
  return { url: page.url(), httpStatus, ...inPage, jsonTexts: [...inPage.jsonTexts, ...networkJson] };
}

/** Saves the avatar under raw/media/profiles/<user>/<sha256>.<ext>; identical images are stored once. Optional. */
async function downloadProfileImage(context: BrowserContext, url: string, username: string, options: ScrapeOptions): Promise<string | null> {
  let response: Awaited<ReturnType<typeof context.request.get>> | undefined;
  try {
    response = await context.request.get(url, { timeout: 20_000 });
    const type = response.headers()['content-type'] ?? '';
    if (!response.ok() || !type.startsWith('image/')) throw new Error(`HTTP ${response.status()} ${type}`);
    const body = await response.body();
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const dir = join(options.dataDir, 'raw', 'media', 'profiles', username);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.${ext}`);
    writeFileSync(file, body, { flush: true });
    return relative(options.dataDir, file);
  } catch (error) {
    throwIfStorageError(error);
    options.log.warn(`@${username}: profile image not saved (${(error as Error).message}); continuing without it`);
    return null;
  } finally {
    await response?.dispose(); // Playwright otherwise retains every avatar body for the life of the context
  }
}

export function classify(error: unknown, attempt: number, url: string): ScrapeFailure {
  const base = { attempts: attempt, url, debugFiles: [] };
  const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
  if (error instanceof ExtractionError) return { ...base, type: error.type, message, retryable: error.retryable };
  if (error instanceof SessionExpiredError) return { ...base, type: 'session_expired', message, retryable: false };
  if (error instanceof ManualInterventionError) return { ...base, type: 'security_challenge', message, retryable: false };
  if (error instanceof RateLimitedError) return { ...base, type: 'rate_limited', message, retryable: true };
  if (isBrowserCrash(error)) return { ...base, type: 'browser_closed', message, retryable: true };
  if (error instanceof errors.TimeoutError) return { ...base, type: 'timeout', message, retryable: true };
  if (/net::ERR_|Navigation failed|ECONNRESET|socket hang up/i.test(message)) return { ...base, type: 'network', message, retryable: true };
  return { ...base, type: 'unexpected', message, retryable: false };
}

/** Screenshot, HTML and a JSON summary under data/debug/profile/. These may contain session tokens: data/ is gitignored. */
export async function writeDebugFiles(page: Page, username: string, failure: ScrapeFailure, options: ScrapeOptions, kind = 'profile'): Promise<string[]> {
  const dir = join(options.dataDir, 'debug', kind);
  const stem = join(dir, `${username}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const written: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    const summary = { username, failure, pageUrl: page.url(), title: await page.title().catch(() => null), at: new Date().toISOString() };
    writeFileSync(`${stem}.json`, JSON.stringify(summary, null, 2));
    written.push(`${stem}.json`);
    await page.screenshot({ path: `${stem}.png`, fullPage: true, timeout: 10_000 });
    written.push(`${stem}.png`);
    writeFileSync(`${stem}.html`, await page.content());
    written.push(`${stem}.html`);
  } catch (error) {
    options.log.warn(`@${username}: could not write all debug files (${(error as Error).message})`);
  }
  return written.map((file) => relative(options.dataDir, file));
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ---- Persistence ----------------------------------------------------------------------------------

export function startJob(db: Database.Database, competitorId: number, jobType = 'profile'): number {
  return Number(db.prepare(`INSERT INTO scrape_jobs (competitor_id, job_type, status, started_at, current_stage)
    VALUES (?, ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`).run(competitorId, jobType, jobType).lastInsertRowid);
}

/**
 * One transaction: append the raw snapshot, update the competitor's latest fields, close the job, and resolve
 * earlier profile errors. Unavailable profiles keep their last known fields; only the status changes.
 */
export function saveProfile(db: Database.Database, competitorId: number, jobId: number, result: ProfileResult): void {
  const { fields } = result;
  const set = (column: string, param: string): string => `${column} = CASE WHEN @fallback = 1 THEN coalesce(${column}, @${param}) ELSE @${param} END`;
  db.transaction(() => {
    db.prepare('INSERT INTO raw_profile_snapshots (competitor_id, raw_json, captured_at) VALUES (?, ?, ?)').run(competitorId, JSON.stringify({
      version: 1,
      username: result.username,
      collected_at: result.collectedAt,
      url: result.profileUrl,
      final_url: result.finalUrl,
      http_status: result.httpStatus,
      account_status: result.status,
      fields,
      sources: result.sources,
      profile_image_path: result.profileImagePath,
      user: result.rawUser,
    }), result.collectedAt);

    if (result.status === 'unavailable') {
      db.prepare(`UPDATE competitors SET account_status = 'unavailable', last_scraped_at = @at,
        first_scraped_at = coalesce(first_scraped_at, @at), updated_at = @at WHERE id = @id`).run({ id: competitorId, at: result.collectedAt });
    } else {
      db.prepare(`UPDATE competitors SET profile_url = @profileUrl,
        ${[['display_name', 'displayName'], ['bio', 'bio'], ['external_url', 'externalUrl'],
    ['followers_count', 'followersCount'], ['following_count', 'followingCount'], ['posts_count', 'postsCount'],
    ['verified', 'verified'], ['category', 'category']].map(([column, param]) => set(column!, param!)).join(', ')},
        profile_image_path = coalesce(@profileImagePath, profile_image_path), account_status = @status,
        first_scraped_at = coalesce(first_scraped_at, @at), last_scraped_at = @at, updated_at = @at
        WHERE id = @id`).run({
        id: competitorId,
        fallback: Number(result.rawUser === null),
        at: result.collectedAt,
        status: result.status,
        profileUrl: result.profileUrl,
        profileImagePath: result.profileImagePath,
        displayName: fields.displayName,
        bio: fields.bio,
        externalUrl: fields.externalUrl,
        followersCount: fields.followersCount,
        followingCount: fields.followingCount,
        postsCount: fields.postsCount,
        verified: fields.verified === null ? null : Number(fields.verified),
        category: fields.category,
      });
    }
    finishJob(db, jobId, 'complete', null);
    db.prepare('UPDATE scrape_jobs SET processed_items = 1, total_items = 1 WHERE id = ?').run(jobId);
    db.prepare(`UPDATE scrape_errors SET resolved_at = ? WHERE competitor_id = ? AND stage = 'profile' AND resolved_at IS NULL`)
      .run(result.collectedAt, competitorId);
  })();
}

/** Records the failure and closes the job. The competitor's saved fields and status are left untouched. */
export function saveFailure(db: Database.Database, competitorId: number, jobId: number, failure: ScrapeFailure, blocked: boolean, stage = 'profile'): void {
  const message = failure.debugFiles.length ? `${failure.message} [debug: ${failure.debugFiles.join(', ')}]` : failure.message;
  db.transaction(() => {
    db.prepare(`INSERT INTO scrape_errors (competitor_id, url, stage, error_type, error_message, retryable, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(competitorId, failure.url, stage, failure.type, message, Number(failure.retryable), failure.attempts);
    finishJob(db, jobId, blocked ? 'blocked' : 'failed', `${failure.type}: ${failure.message}`);
  })();
}

export function finishJob(db: Database.Database, jobId: number, status: 'complete' | 'failed' | 'blocked', error: string | null): void {
  db.prepare(`UPDATE scrape_jobs SET status = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?`).run(status, error, jobId);
}

// ---- Batch ----------------------------------------------------------------------------------------

export interface BatchSummary {
  succeeded: string[];
  failed: string[];
  skipped: string[];
  stoppedBy: string | null;
}

/**
 * Scrapes each competitor in turn. A failure on one profile is recorded and the batch moves on; session expiry,
 * security challenges, rate limiting and Ctrl-C stop the batch, leaving later competitors untouched.
 */
export async function collectProfiles(
  db: Database.Database,
  context: BrowserContext,
  session: Pick<InstagramSessionManager, 'inspect'>,
  competitors: Array<{ id: number; username: string }>,
  options: ScrapeOptions,
): Promise<BatchSummary> {
  const summary: BatchSummary = { succeeded: [], failed: [], skipped: [], stoppedBy: null };
  for (const [index, competitor] of competitors.entries()) {
    if (summary.stoppedBy || options.signal?.aborted) {
      summary.stoppedBy ??= 'interrupted';
      summary.skipped.push(competitor.username);
      continue;
    }
    if (index > 0) await (options.sleep ?? delay)(PACING_MS[0] + Math.random() * (PACING_MS[1] - PACING_MS[0]));
    const { log } = options;
    log.info(`[${index + 1}/${competitors.length}] @${competitor.username}`);
    const jobId = startJob(db, competitor.id);
    try {
      const result = await scrapeProfile(context, session, competitor.username, options);
      saveProfile(db, competitor.id, jobId, result);
      summary.succeeded.push(competitor.username);
      const f = result.fields;
      log.info(`@${competitor.username}: ${result.status}` + (result.status === 'unavailable' ? '' :
        `; ${f.followersCount ?? '?'} followers, ${f.followingCount ?? '?'} following, ${f.postsCount ?? '?'} posts` +
        (result.sources.followersCount === 'meta' ? ' (follower count from page meta, may be rounded; run headed for exact counts)' : '') +
        `; missing: ${Object.entries(f).filter(([, v]) => v === null).map(([k]) => k).join(', ') || 'none'}`));
    } catch (error) {
      throwIfStorageError(error);
      const failure = error instanceof ProfileScrapeError ? error.failure
        : { type: 'unexpected', message: String(error), retryable: false, attempts: 1, url: profileUrl(competitor.username), debugFiles: [] };
      const original = error instanceof ProfileScrapeError ? error.original : error;
      if (options.signal?.aborted) {
        saveFailure(db, competitor.id, jobId, { ...failure, type: 'interrupted', message: 'Stopped by user', retryable: true }, false);
        summary.stoppedBy = 'interrupted';
        summary.skipped.push(competitor.username);
        continue;
      }
      const fatal = isBatchFatal(original);
      saveFailure(db, competitor.id, jobId, failure, fatal);
      summary.failed.push(competitor.username);
      log.error(`@${competitor.username}: ${failure.type}: ${failure.message}${failure.debugFiles.length ? ` (debug files: ${failure.debugFiles.join(', ')})` : ''}`);
      if (fatal) summary.stoppedBy = failure.type;
    }
  }
  return summary;
}

/** Throws the batch-stopping error if the page shows a logout, a security challenge or a rate-limit notice. */
export async function assertStillAllowed(page: Page, session: Pick<InstagramSessionManager, 'inspect'>): Promise<void> {
  const state = await session.inspect(page);
  if (state === 'challenge') {
    throw new ManualInterventionError('Instagram is showing a security challenge. Manual intervention is required: run `npm run instagram:login` and complete it in the browser window. This tool does not bypass it.');
  }
  if (state === 'logged_out') throw new SessionExpiredError('Instagram session expired during scraping. Run: npm run instagram:login');
  const text = await page.evaluate(() => document.body?.innerText.slice(0, 4000) ?? '');
  if (RATE_LIMIT_TEXT.test(text)) throw new RateLimitedError('Instagram asked to wait before trying again (rate limited). Stopping; try again later.');
}
