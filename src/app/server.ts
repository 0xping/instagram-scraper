import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { BrowserManager } from '../browser.js';
import { competitorStatus, type StatusRow } from '../batch.js';
import { loadConfig, type AppConfig } from '../config.js';
import { acquireDatasetLock, hideCompetitor, registerCompetitors } from '../db.js';
import { saveSettings } from '../env-file.js';
import { checkFfmpeg } from '../frames.js';
import { connectWithCookies } from '../instagram-cookies.js';
import { InstagramSessionManager, ManualInterventionError, SessionExpiredError } from '../instagram-session.js';
import { createLogger, redactLog, type Logger } from '../logger.js';
import { postDir } from '../media-files.js';
import { openDataPath, resolveDataPath } from '../open-path.js';
import { dataPaths } from '../paths.js';
import { formatPipelineSummary, pipelineTotals } from '../pipeline.js';
import { deletePosts, exportCompetitors, openCollector, resolveCompetitors, retryFailed, retryNeedsBrowser, scrapeCompetitors } from '../runner.js';
import { createChat } from './chat.js';
import { parseAccountList } from './model.js';

const PAGE = new URL('../../src/app/page.html', import.meta.url);
const LOCAL_WHISPER = 'http://127.0.0.1:8080/v1';
const WHISPER_MODEL = 'large-v3-turbo';
const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};
/** Plain names for the collector's stages. */
const STAGES: Record<string, string> = {
  session: 'Checking Instagram', profile: 'Account details', discovery: 'Finding posts', metadata: 'Post details',
  media: 'Photos and videos', reels: 'Videos', frames: 'Video images', transcripts: 'Video speech', comments: 'Comments',
};

type Session = 'missing' | 'checking' | 'connected' | 'expired';
interface Task {
  kind: 'connect' | 'check' | 'collect' | 'retry';
  label: string;
  usernames: string[];
  startedAt: string;
  finishedAt: string | null;
  stopping: boolean;
  /** Collect only: how each account ended, as the collector reported it. */
  results: Record<string, string>;
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * The dataset lock the CLI takes too. The dashboard holds it only while it works, so a CLI command (an AI agent
 * collecting, say) can run while the page stays open for browsing. Release it with close().
 */
function lockDataset(dataDir: string): Database.Database {
  try {
    return acquireDatasetLock(dataDir);
  } catch (error) {
    if (!/Another collector command/.test((error as Error).message)) throw error;
    throw new HttpError(409, 'A command-line collection is using this data folder right now. Its posts show here as it saves them; start this when it finishes.');
  }
}

/**
 * One task at a time, like the CLI: a busy flag, an AbortController, and the browser closed on Stop. The task
 * lives here, not in the page, so closing the tab never stops a collection and reopening it shows the progress.
 */
function createCollector(db: Database.Database, dataDir: string) {
  const logs: Array<{ at: string; level: string; text: string }> = [];
  const terminal = createLogger(loadConfig().logLevel);
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
    // The page shows every message; the terminal keeps only what may need a look after the tab is closed.
    if (level === 'warn' || level === 'error') terminal[level](message);
    if (level === 'debug') return;
    for (const text of message.split(/\r?\n/)) logs.push({ at: new Date().toISOString(), level, text: redactLog(text) });
    logs.splice(0, Math.max(0, logs.length - 300));
  };
  const log: Logger = { debug: (s) => write('debug', s), info: (s) => write('info', s), warn: (s) => write('warn', s), error: (s) => write('error', s) };
  let session: Session = existsSync(dataPaths(dataDir).instagramState) ? 'checking' : 'missing';
  let task: Task | null = null;
  let abort: AbortController | null = null;
  let browser: BrowserManager | null = null;
  let idle: Promise<void> = Promise.resolve();

  // Settings are re-read for every task so a change applies at once, but the dataset stays the one opened here.
  const config = (): AppConfig => ({ ...loadConfig(), dataDir });

  function work(kind: Task['kind'], label: string, usernames: string[], action: (signal: AbortSignal) => Promise<void>): void {
    if (abort) throw new HttpError(409, `${task?.label ?? 'Another task'} is still running. Wait for it, or press Stop.`);
    const controller = new AbortController();
    // Taken before anything changes, so a refusal leaves the previous task on show.
    const lock = lockDataset(dataDir);
    abort = controller;
    task = { kind, label, usernames, startedAt: new Date().toISOString(), finishedAt: null, stopping: false, results: {} };
    const current = task;
    idle = (async () => {
      try {
        await action(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) log.warn(`${label}: stopped.`);
        else log.error(`${label}: ${(error as Error).message}`);
        if (kind === 'check' || error instanceof SessionExpiredError || error instanceof ManualInterventionError) session = 'expired';
      } finally {
        browser = null;
        abort = null;
        current.finishedAt = new Date().toISOString();
        lock.close();
      }
    })();
  }

  function stop(): void {
    if (!abort || abort.signal.aborted) return;
    log.warn('Stopping after the current item…');
    if (task) task.stopping = true;
    abort.abort();
    void browser?.close();
  }

  function collect(targets: string[] | 'all', maxPosts: number | null): void {
    if (session !== 'connected') throw new HttpError(409, 'Connect Instagram first.');
    const competitors = resolveCompetitors(db, targets === 'all' ? ['--all'] : targets);
    if (!competitors.length) throw new HttpError(400, 'Add an account first.');
    const label = competitors.length === 1 ? `Collecting @${competitors[0]!.username}` : `Collecting ${competitors.length} accounts`;
    work('collect', label, competitors.map((c) => c.username), async (signal) => {
      const settings = config();
      settings.discovery.maxPosts = maxPosts;
      browser = new BrowserManager({ ...settings.browser }, log);
      const handle = await openCollector({ log, signal, config: settings, targets: competitors.map((c) => c.username), browser });
      browser = handle.browser;
      session = 'connected';
      try {
        const results = await scrapeCompetitors(handle, handle.competitors, {
          force: false, skipMedia: false, skipFrames: false, skipTranscripts: false, skipComments: false, commentLimit: settings.commentLimit,
        }, {
          // "All accounts" skips the ones finished in the last day; accounts named on purpose always run.
          batch: targets === 'all', recentHours: 24,
          onSummary: (result) => {
            if (task) task.results[result.username] = result.status;
            const id = handle.competitors.find((c) => c.username === result.username)!.id;
            log.info(result.run ? formatPipelineSummary(result.username, result.run, pipelineTotals(handle.db, id)) : `@${result.username}: ${result.status}`);
          },
        });
        const failed = results.filter((r) => r.status !== 'complete' && !r.status.startsWith('skipped')).length;
        log.info(`Collect finished: ${results.length - failed} done, ${failed} need attention.`);
      } finally {
        await handle.close();
      }
    });
  }

  function retry(username: string): void {
    const competitors = resolveCompetitors(db, [username]);
    work('retry', `Retrying @${username}`, [username], async (signal) => {
      const settings = config();
      const stages = ['metadata', 'media', 'reels', 'frames', 'transcripts', 'comments'] as const;
      if (retryNeedsBrowser(db, competitors, stages, false) && session !== 'connected') throw new Error('Connect Instagram first.');
      browser = retryNeedsBrowser(db, competitors, stages, false) ? new BrowserManager({ ...settings.browser }, log) : null;
      const handle = browser ? await openCollector({ log, signal, config: settings, targets: [username], browser }) : null;
      try {
        const result = await retryFailed(handle?.db ?? db, handle ? { context: handle.context, session: handle.session } : null,
          competitors, stages, { config: settings, log, signal, includePermanent: false, dryRun: false });
        log.info(`Retry: ${result.rows.reduce((n, r) => n + r.fixed, 0)} fixed; ${result.failed ? 'some still fail' : 'done'}.`);
      } finally {
        await handle?.close();
      }
    });
  }

  // Chrome's own cookies first: Instagram's security check never sees an automated login that way. Only when
  // there is no logged-in Chrome to read (Windows, WSL, another browser) does a login window open instead.
  function connect(): void {
    work('connect', 'Connecting Instagram', [], async (signal) => {
      const settings = config();
      const statePath = dataPaths(dataDir).instagramState;
      const attempt = async (headed: boolean, show: boolean, run: (s: InstagramSessionManager) => Promise<void>): Promise<void> => {
        browser = new BrowserManager({ ...settings.browser, headed, show }, log);
        try { await run(new InstagramSessionManager(browser, statePath, settings.browser.loginTimeoutMs, log)); }
        finally { await browser.close(); }
      };
      try {
        await attempt(settings.browser.headed, settings.browser.show, (s) => connectWithCookies(s, statePath, log));
      } catch (error) {
        if (signal.aborted) throw error;
        log.warn(`Chrome login: ${(error as Error).message}`);
        log.info('A login window opened. Log in there as you normally would; this page updates by itself.');
        if (task) task.label = 'Waiting for you to log in, in the window that opened';
        await attempt(true, true, (s) => s.login());
      }
      session = 'connected';
      log.info('Instagram connected.');
    });
  }

  function check(): void {
    work('check', 'Checking the Instagram login', [], async (signal) => {
      const settings = config();
      browser = new BrowserManager({ ...settings.browser }, log);
      const handle = await openCollector({ log, signal, config: settings, targets: ['--all'], browser });
      session = 'connected';
      await handle.close();
    });
  }

  return {
    log, logs, config, stop, collect, retry, connect, check,
    get session() { return session; },
    get task() { return task; },
    get running() { return abort !== null; },
    /** Resolves once no task is running. */
    async settle(): Promise<void> { while (abort) await idle; },
  };
}
type Collector = ReturnType<typeof createCollector>;

/** An account's state in a few plain words, and whether it needs a look. */
function describe(r: StatusRow, running: boolean): { text: string; tone: 'busy' | 'ok' | 'warn' | 'muted' } {
  if (running) return { text: 'Collecting now', tone: 'busy' };
  if (!r.discovered && !r.lastScrapedAt) return { text: 'Never collected', tone: 'muted' };
  if (r.failed) return { text: `${r.failed} failed`, tone: 'warn' };
  if (r.jobStatus === 'complete' && r.metadata >= r.discovered) return { text: 'All collected', tone: 'ok' };
  // Collected before full runs existed (one step at a time): judge by what is saved.
  if (!r.jobStatus) return r.discovered && r.metadata >= r.discovered ? { text: 'All collected', tone: 'ok' }
    : { text: r.discovered ? 'Partly collected' : 'Not collected yet', tone: 'muted' };
  if (r.jobError === 'interrupted') return { text: 'Stopped early', tone: 'warn' };
  return { text: r.jobStatus === 'blocked' ? 'Blocked by Instagram' : 'Unfinished', tone: 'warn' };
}

interface JobRow { status: string; current_stage: string | null; processed_items: number; total_items: number | null; stages_json: string | null; finished_at: string | null }

/** Where one account of a collect run stands: its stage, the items done in it, and what went wrong. */
function accountProgress(db: Database.Database, username: string, task: Task, running: boolean) {
  const id = (db.prepare('SELECT id FROM competitors WHERE username = ?').get(username) as { id: number } | undefined)?.id;
  const job = id === undefined ? undefined : db.prepare(`SELECT status, current_stage, processed_items, total_items, stages_json, finished_at
    FROM scrape_jobs WHERE competitor_id = ? AND job_type = 'pipeline' ORDER BY id DESC LIMIT 1`).get(id) as JobRow | undefined;
  // A resumed job keeps its first start time, so "part of this run" means running now or finished since it began.
  const current = job && (job.status === 'running' || (job.finished_at ?? '') >= task.startedAt) ? job : undefined;
  let stages: Record<string, { status: string; detail: string | null }> = {};
  try { stages = JSON.parse(current?.stages_json ?? '{}') as typeof stages; } catch { /* a legacy job may hold bad JSON */ }
  const problems = Object.entries(stages).filter(([, s]) => ['failed', 'blocked', 'partial'].includes(s.status))
    .map(([name, s]) => `${STAGES[name] ?? name}: ${s.status === 'blocked' ? 'blocked by Instagram' : s.status === 'partial' ? 'some items failed' : 'failed'}${s.detail ? ` (${redactLog(s.detail)})` : ''}`);
  const items = current?.status === 'running' && id !== undefined ? db.prepare(`SELECT processed_items AS done, total_items AS total FROM scrape_jobs
    WHERE competitor_id = ? AND job_type IN ('discovery', 'posts', 'comments') AND status = 'running' ORDER BY id DESC LIMIT 1`).get(id) as { done: number; total: number | null } | undefined : undefined;
  const result = task.results[username];
  const status = current?.status === 'running' ? 'running'
    : result?.startsWith('skipped') ? 'skipped'
      : result === 'complete' ? 'done'
        : result ? (result === 'interrupted' ? 'stopped' : 'attention')
          : running ? 'waiting' : 'not started';
  return {
    username, status,
    stage: current?.status === 'running' ? STAGES[current.current_stage ?? ''] ?? 'Starting' : null,
    stagesDone: current?.processed_items ?? 0, stagesTotal: current?.total_items ?? Object.keys(STAGES).length,
    items: items ?? null, problems,
  };
}

function state(db: Database.Database, collector: Collector, setup: string[]) {
  const task = collector.task;
  const running = collector.running;
  const rows = competitorStatus(db);
  const avatars = new Map((db.prepare('SELECT username, profile_image_path AS path FROM competitors WHERE profile_image_path IS NOT NULL')
    .all() as Array<{ username: string; path: string }>).map((r) => [r.username, r.path]));
  return {
    session: collector.session,
    setup,
    task: task && {
      kind: task.kind, label: task.label, running, stopping: task.stopping, startedAt: task.startedAt, finishedAt: task.finishedAt,
      accounts: task.kind === 'collect' ? task.usernames.map((u) => accountProgress(db, u, task, running)) : [],
    },
    accounts: rows.map((r) => ({
      username: r.username, saved: r.discovered, postsCount: r.postsCount, failed: r.failed, lastAt: r.jobAt ?? r.lastScrapedAt,
      avatar: avatars.get(r.username) ?? null,
      // A running job the dashboard does not own is the CLI's: interrupted ones are marked failed at the next start.
      ...describe(r, r.jobStatus === 'running'),
    })),
    logs: collector.logs.slice(-150),
  };
}

function competitorId(db: Database.Database, username: unknown): { id: number; username: string } {
  if (typeof username !== 'string') throw new HttpError(400, 'Choose an account.');
  const [competitor] = resolveCompetitors(db, [username]);
  return competitor!;
}

const OWNED = `(p.competitor_id = @id OR EXISTS (SELECT 1 FROM competitor_posts cp WHERE cp.post_id = p.id AND cp.competitor_id = @id))`;

/** How the grid can be ordered; the key is what the page and agents send as `sort`. */
const SORTS: Record<string, string> = {
  newest: 'p.published_at IS NULL, p.published_at DESC', oldest: 'p.published_at IS NULL, p.published_at',
  likes: 'p.likes_count IS NULL, p.likes_count DESC', comments: 'p.comments_count IS NULL, p.comments_count DESC',
  views: 'coalesce(p.views_count, p.plays_count) IS NULL, coalesce(p.views_count, p.plays_count) DESC',
};
const TYPES = new Set(['reel', 'carousel', 'image']);

interface PostFilter { type?: string | null; q?: string | null; sort?: string | null }

function posts(db: Database.Database, username: unknown, offset: number, limit: number, filter: PostFilter = {}) {
  const { id } = competitorId(db, username);
  if (filter.type && !TYPES.has(filter.type)) throw new HttpError(400, `type must be one of: ${[...TYPES].join(', ')}.`);
  if (filter.sort && !SORTS[filter.sort]) throw new HttpError(400, `sort must be one of: ${Object.keys(SORTS).join(', ')}.`);
  const q = filter.q?.trim() ?? '';
  const where = `${OWNED}${filter.type ? ' AND p.type = @type' : ''}${q ? " AND p.caption LIKE @q ESCAPE '\\'" : ''}`;
  const params = { id, type: filter.type ?? null, q: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
  const rows = db.prepare(`SELECT p.id, p.shortcode, p.type, p.published_at AS publishedAt, p.likes_count AS likes, p.comments_count AS comments,
      coalesce(p.views_count, p.plays_count) AS views,
      coalesce(p.thumbnail_path,
        (SELECT m.local_path FROM media m WHERE m.post_id = p.id AND m.download_status = 'complete' AND m.local_path IS NOT NULL
          AND lower(m.local_path) NOT GLOB '*.mp4' AND lower(m.local_path) NOT GLOB '*.mov' ORDER BY m.position LIMIT 1),
        (SELECT f.image_path FROM reel_frames f WHERE f.post_id = p.id ORDER BY f.timestamp_seconds LIMIT 1)) AS thumb
    FROM posts p WHERE ${where}
    ORDER BY ${SORTS[filter.sort ?? 'newest']}, p.id LIMIT @limit OFFSET @offset`).all({ ...params, limit: limit + 1, offset }) as Array<Record<string, unknown>>;
  const total = (db.prepare(`SELECT count(*) AS n FROM posts p WHERE ${where}`).get(params) as { n: number }).n;
  const account = db.prepare(`SELECT username, display_name AS name, followers_count AS followers, posts_count AS postsCount, bio,
    profile_image_path AS avatar, last_scraped_at AS lastAt FROM competitors WHERE id = ?`).get(id);
  return { account, total, posts: rows.slice(0, limit), more: rows.length > limit };
}

function post(db: Database.Database, dataDir: string, id: number) {
  const p = db.prepare(`SELECT p.id, p.shortcode, p.url, p.type, p.caption, p.location, p.published_at AS publishedAt, p.likes_count AS likes,
      p.comments_count AS comments, coalesce(p.views_count, p.plays_count) AS views, p.thumbnail_path AS thumb, owner.username AS owner
    FROM posts p JOIN competitors owner ON owner.id = p.competitor_id WHERE p.id = ?`).get(id) as Record<string, unknown> & { shortcode: string; owner: string; url: string } | undefined;
  if (!p) throw new HttpError(404, 'That post is not saved.');
  const media = (db.prepare(`SELECT local_path AS path FROM media WHERE post_id = ? AND download_status = 'complete' AND local_path IS NOT NULL
    ORDER BY position`).all(id) as Array<{ path: string }>).map((m) => ({ path: m.path, video: /\.(mp4|mov|m4v)$/i.test(m.path) }));
  const transcript = (db.prepare('SELECT transcript FROM transcripts WHERE post_id = ? ORDER BY id DESC LIMIT 1').get(id) as { transcript: string } | undefined)?.transcript ?? null;
  const topComments = db.prepare(`SELECT username, text, likes_count AS likes, published_at AS publishedAt FROM comments WHERE post_id = ?
    ORDER BY likes_count IS NULL, likes_count DESC, id LIMIT 10`).all(id);
  const frames = db.prepare('SELECT image_path AS path FROM reel_frames WHERE post_id = ? ORDER BY timestamp_seconds').all(id) as Array<{ path: string }>;
  let url: string | null = null;
  try { const u = new URL(p.url); if (u.protocol === 'https:' && /(^|\.)instagram\.com$/.test(u.hostname)) url = u.href; } catch { /* not a link */ }
  let folder = false;
  try { folder = existsSync(postDir(dataDir, p.owner, p.shortcode)); } catch { /* an unsafe name has no folder */ }
  return { ...p, url, media, transcript, topComments, frames: frames.map((f) => f.path), folder };
}

function serviceName(): string {
  const provider = process.env.TRANSCRIPTION_PROVIDER?.trim() ?? '';
  if (!provider) return 'off';
  if (provider !== 'custom') return provider;
  return (process.env.TRANSCRIPTION_BASE_URL ?? '').includes('127.0.0.1') ? 'local' : 'custom';
}

function settings(config: AppConfig) {
  return {
    service: serviceName(),
    keys: { groq: Boolean(process.env.GROQ_API_KEY?.trim()), openai: Boolean(process.env.OPENAI_API_KEY?.trim()) },
    server: process.env.TRANSCRIPTION_BASE_URL?.trim() || '',
    model: process.env.TRANSCRIPTION_MODEL?.trim() || '',
    comments: config.commentLimit === null ? 'all' : String(config.commentLimit),
    fps: Number((1 / config.frameInterval).toFixed(2)),
    show: config.browser.show,
  };
}

/** Everything a choice needs is written in one save, so a half-configured service is never left behind. */
function saveFromForm(envPath: string, body: Record<string, unknown>): void {
  const text = (key: string): string => typeof body[key] === 'string' ? (body[key] as string).trim() : '';
  const changes: Record<string, string> = {};
  const service = text('service');
  if (service === 'off') changes.TRANSCRIPTION_PROVIDER = '';
  else if (service === 'groq' || service === 'openai') {
    const name = service === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    if (text('key')) changes[name] = text('key');
    else if (!process.env[name]?.trim()) throw new HttpError(400, `Paste the ${service === 'groq' ? 'Groq' : 'OpenAI'} API key.`);
    changes.TRANSCRIPTION_PROVIDER = service;
  } else if (service === 'local' || service === 'custom') {
    if (service === 'custom' && !text('server')) throw new HttpError(400, 'Enter the Whisper server address.');
    changes.TRANSCRIPTION_PROVIDER = 'custom';
    changes.TRANSCRIPTION_BASE_URL = service === 'local' ? LOCAL_WHISPER : text('server');
    changes.TRANSCRIPTION_MODEL = text('model') || WHISPER_MODEL;
  } else throw new HttpError(400, 'Choose a transcription service.');
  const comments = text('comments').toLowerCase();
  if (comments !== 'all' && !/^[1-9]\d*$/.test(comments)) throw new HttpError(400, 'Comments per post must be a whole number, or all.');
  changes.COMMENT_LIMIT = comments;
  const fps = Number(body.fps);
  if (!Number.isFinite(fps) || fps <= 0) throw new HttpError(400, 'Images per video second must be more than 0.');
  changes.FRAME_INTERVAL = String(Number((1 / fps).toFixed(4)));
  changes.BROWSER_SHOW = body.show === true ? 'true' : 'false';
  // Hidden means off screen, never headless (Instagram degrades headless pages); this also repairs older setups.
  changes.BROWSER_HEADED = 'true';
  saveSettings(envPath, changes);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4_000_000) throw new HttpError(413, 'That file is too large.');
  }
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { throw new HttpError(400, 'Bad request.'); }
}

function sendMedia(req: IncomingMessage, res: ServerResponse, dataDir: string, path: string): void {
  const type = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!type) throw new HttpError(404, 'Not a photo or video.');
  let file: string;
  try { file = resolveDataPath(dataDir, path); } catch { throw new HttpError(404, 'File not found.'); }
  const size = statSync(file).size;
  // Videos seek with Range requests; without them the browser can only play from the start.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
  createReadStream(file).pipe(res);
}

/** What is missing from the install, in words that say how to fix it. */
function setupProblems(): string[] {
  const problems: string[] = [];
  if (!existsSync(chromium.executablePath())) problems.push('The browser used for collecting is not installed. Run Install again.');
  try { checkFfmpeg(); } catch { problems.push('FFmpeg is missing, so video images cannot be saved. Run Install again.'); }
  return problems;
}

function friendly(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  const message = (error as Error).message ?? String(error);
  if ((error as { code?: string }).code === 'ENOENT') return { status: 404, message: 'Nothing is saved there yet.' };
  if (/^Not registered:/.test(message)) return { status: 404, message: 'That account is not in your list.' };
  return { status: 400, message: redactLog(message) };
}

/**
 * The dashboard: one page and a small JSON API on 127.0.0.1. Every request must carry the per-launch token
 * (a header for the API, the URL for the page and media), and a Host of 127.0.0.1, so no other page, local or
 * remote, can drive the collector or read the data.
 */
export async function startDashboard(options: {
  db: Database.Database; dataDir: string; envPath: string; port?: number; checkSession?: boolean;
  /** Opens a folder in the file manager; tests replace it so nothing pops up. */
  open?: (dataDir: string, path: string) => Promise<void>;
}) {
  const { db, dataDir, envPath } = options;
  const open = options.open ?? openDataPath;
  const token = randomBytes(24).toString('base64url');
  const collector = createCollector(db, dataDir);
  const chat = createChat({ appDir: fileURLToPath(new URL('../../', import.meta.url)), dataDir });
  const setup = setupProblems();
  const page = readFileSync(PAGE);
  let host = '';

  const valid = (given: string | null | undefined): boolean => {
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => unknown> = {
    'GET /api/state': () => { checkSession(); return { ...state(db, collector, setup), chat: chat.state() }; },
    'POST /api/chat': (body) => {
      const text = typeof body.message === 'string' ? body.message.trim() : '';
      if (!text) throw new HttpError(400, 'Write a message.');
      chat.send(text);
    },
    'POST /api/chat/stop': () => chat.stop(),
    'POST /api/chat/new': () => chat.reset(),
    'GET /api/posts': (_, url) => posts(db, url.searchParams.get('account'), Math.max(0, Number(url.searchParams.get('offset')) || 0),
      Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30)),
      { type: url.searchParams.get('type'), q: url.searchParams.get('q'), sort: url.searchParams.get('sort') }),
    'GET /api/post': (_, url) => post(db, dataDir, Number(url.searchParams.get('id'))),
    'GET /api/settings': () => settings(collector.config()),
    'POST /api/settings': (body) => { saveFromForm(envPath, body); collector.log.info('Settings saved.'); return settings(collector.config()); },
    'POST /api/connect': () => collector.connect(),
    'POST /api/stop': () => collector.stop(),
    // Pasted text and imported files alike: what is not a username is reported back, not fatal.
    'POST /api/accounts': (body) => {
      const { usernames, skipped } = parseAccountList(typeof body.text === 'string' ? body.text : '');
      if (!usernames.length) throw new HttpError(400, skipped.length ? `No Instagram usernames found (for example: ${skipped.slice(0, 3).join(', ')}).` : 'Paste a username or a profile link.');
      const added = registerCompetitors(db, usernames);
      if (added) collector.log.info(`Added ${added} account${added === 1 ? '' : 's'}.`);
      return { usernames, added, skipped: skipped.slice(0, 20), skippedCount: skipped.length };
    },
    'POST /api/collect': (body) => {
      const max = body.maxPosts;
      if (max !== null && !(Number.isSafeInteger(max) && (max as number) > 0)) throw new HttpError(400, 'Enter a whole number of posts, or choose All.');
      const targets = body.accounts === 'all' ? 'all' : Array.isArray(body.accounts) ? body.accounts.filter((a): a is string => typeof a === 'string') : [];
      if (targets !== 'all' && !targets.length) throw new HttpError(400, 'Paste a username, or tick an account.');
      collector.collect(targets, max as number | null);
    },
    // For good: files and collected data go, and later collects skip these posts.
    'POST /api/delete-posts': (body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => Number.isSafeInteger(id)) : [];
      if (!ids.length) throw new HttpError(400, 'Send ids: the numbers of the posts to delete.');
      // A running collect may be writing into those folders.
      if (collector.running) throw new HttpError(409, `${collector.task?.label ?? 'A task'} is still running. Wait for it, or press Stop.`);
      const lock = lockDataset(dataDir);
      try { return { deleted: deletePosts(db, dataDir, ids, collector.log) }; } finally { lock.close(); }
    },
    'POST /api/retry': (body) => collector.retry(competitorId(db, body.account).username),
    'POST /api/hide': (body) => {
      const competitor = competitorId(db, body.account);
      hideCompetitor(db, competitor.id);
      collector.log.info(`@${competitor.username} hidden. Collect the same name again to bring it back.`);
    },
    'POST /api/export': async (body) => {
      const competitors = body.account ? [competitorId(db, body.account)] : resolveCompetitors(db, ['--all']);
      const result = exportCompetitors(db, competitors, ['json', 'csv'], collector.config(), collector.log);
      if (!result.files.length) throw new HttpError(400, 'Nothing was exported. See the messages for why.');
      await open(dataDir, 'exports').catch((error: unknown) => collector.log.warn(`Could not open the folder: ${(error as Error).message}`));
      return { files: result.files.length, failed: result.failed, folder: join(dataDir, 'exports') };
    },
    // The page names what to open; the path is always worked out here, never taken from the request.
    'POST /api/open': async (body) => {
      if (body.what === 'data') return open(dataDir, '.');
      if (body.what === 'account') return open(dataDir, join('competitors', competitorId(db, body.account).username));
      if (body.what === 'post') {
        const p = db.prepare('SELECT p.shortcode, c.username FROM posts p JOIN competitors c ON c.id = p.competitor_id WHERE p.id = ?')
          .get(Number(body.id)) as { shortcode: string; username: string } | undefined;
        if (!p) throw new HttpError(404, 'That post is not saved.');
        return open(dataDir, postDir(dataDir, p.username, p.shortcode));
      }
      throw new HttpError(400, 'Unknown folder.');
    },
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // A DNS-rebinding page reaches this port under its own host name; refuse anything but the address we gave.
      if (req.headers.host !== host) return void res.writeHead(421).end('Wrong host');
      const common = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      if (req.method === 'GET' && url.pathname === '/') {
        if (!valid(url.searchParams.get('t'))) {
          return void res.writeHead(403, { ...common, 'content-type': 'text/plain; charset=utf-8' })
            .end('Open the dashboard with the link printed in the terminal (it changes every launch).');
        }
        return void res.writeHead(200, {
          ...common, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        }).end(page);
      }
      if (req.method === 'GET' && url.pathname === '/media') {
        if (!valid(url.searchParams.get('t'))) return void res.writeHead(403).end();
        return sendMedia(req, res, dataDir, url.searchParams.get('p') ?? '');
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return void res.writeHead(404, common).end();
      if (!valid(req.headers['x-token'] as string | undefined)) return void res.writeHead(403, common).end();
      const result = await route(req.method === 'POST' ? await readBody(req) : {}, url);
      res.writeHead(200, { ...common, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result ?? { ok: true }));
    })().catch((error: unknown) => {
      const { status, message } = friendly(error);
      if (status >= 500 || !(error instanceof HttpError)) collector.log.debug(`${req.method} ${req.url?.split('?')[0]}: ${message}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  // The CLI may be collecting at launch; the state poll tries the check again once it is done.
  const checkSession = (): void => {
    if (options.checkSession === false || collector.session !== 'checking' || collector.running) return;
    try { collector.check(); } catch (error) { if (!(error instanceof HttpError)) throw error; }
  };
  checkSession();

  return {
    url: `http://${host}/?t=${token}`,
    token,
    collector,
    /** Stops any task, waits for its browser to close, then stops serving. */
    async close(): Promise<void> {
      chat.stop();
      collector.stop();
      await collector.settle();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
