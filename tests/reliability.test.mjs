import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import { acquireDatasetLock, migrate, openDatabase, recoverInterruptedJobs, throwIfStorageError } from '../dist/db.js';
import { normalizeUsername } from '../dist/competitors.js';
import { csvField } from '../dist/export.js';
import { parseCommentsPayload, saveComments } from '../dist/comments.js';
import { competitorStatus } from '../dist/batch.js';
import { InstagramSessionManager } from '../dist/instagram-session.js';
import { isBatchFatal, classify, openProfile } from '../dist/profile-scraper.js';
import { processCompetitorMedia } from '../dist/media.js';
import { loadConfig } from '../dist/config.js';
import { waitForResponses } from '../dist/browser.js';
import { redactLog } from '../dist/logger.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function dataset() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-reliability-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  migrate(db);
  db.exec("INSERT INTO competitors (id, username) VALUES (1, 'brand'), (2, 'collab')");
  const post = (code = 'TestPost01') => Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, extraction_status) VALUES (1, ?, 'u', 'complete')").run(code).lastInsertRowid);
  return { dir, db, post, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('dataset lock rejects a competing process and releases automatically on SIGKILL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-lock-'));
  const module = new URL('../dist/db.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireDatasetLock } from ${JSON.stringify(module)}; acquireDatasetLock(process.argv[1]); process.stdout.write('locked'); setInterval(() => {}, 1000);`, dir]);
  try {
    await once(child.stdout, 'data');
    assert.throws(() => acquireDatasetLock(dir), /Another collector command/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const lock = acquireDatasetLock(dir);
    lock.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite uses durable commits; stale jobs retain their progress and collab status counts agree', () => {
  const f = dataset();
  try {
    assert.equal(f.db.pragma('synchronous', { simple: true }), 2);
    assert.equal(f.db.pragma('busy_timeout', { simple: true }), 5000);
    const id = f.post();
    f.db.prepare('INSERT INTO competitor_posts (competitor_id, post_id) VALUES (2, ?)').run(id);
    f.db.exec(`INSERT INTO scrape_jobs (competitor_id, job_type, status, processed_items, stages_json)
      VALUES (1, 'pipeline', 'running', 3, '{"profile":{"status":"ok"}}')`);
    recoverInterruptedJobs(f.db);
    const job = f.db.prepare('SELECT status, error, processed_items, stages_json FROM scrape_jobs').get();
    assert.deepEqual(job, { status: 'failed', error: 'interrupted', processed_items: 3, stages_json: '{"profile":{"status":"ok"}}' });
    assert.deepEqual(competitorStatus(f.db).map((c) => [c.username, c.discovered, c.metadata]), [['brand', 1, 1], ['collab', 1, 1]]);
    assert.deepEqual(f.db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { f.close(); }
});

test('comments: exhausted replies do not end pagination; duplicates never consume a raised limit', () => {
  const root = { pk: '1', user: { username: 'a' }, text: 'one', comment_like_count: 1,
    replies: { edges: [], page_info: { has_next_page: false } } };
  assert.equal(parseCommentsPayload({ comments: [root], has_more_comments: true }).hasMore, true);
  assert.equal(parseCommentsPayload({ comments: [root] }).hasMore, null);
  assert.equal(parseCommentsPayload({ comments: [], has_more_comments: false }).hasMore, false);
  const f = dataset();
  try {
    const id = f.post();
    const c = (n) => ({ id: String(n), username: 'a', text: `comment ${n}`, parentId: null, likes: 0, publishedAt: '2026-01-01', raw: {} });
    assert.equal(saveComments(f.db, id, [c(1), c(2)], 2), 2);
    assert.equal(saveComments(f.db, id, [c(1), c(2), c(3), c(4)], 3), 1);
    assert.equal(saveComments(f.db, id, [{ ...c(1), id: null }]), 0, 'DOM fallback cannot duplicate a known JSON comment');
    assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n, 3);
  } finally { f.close(); }
});

test('path, CSV, timeout and browser-crash boundaries reject unsafe input', () => {
  for (const name of ['.', '..', '...']) assert.throws(() => normalizeUsername(name), /Invalid/);
  for (const value of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '  =1', '\t=1']) assert.ok(csvField(value).startsWith("'"));
  assert.equal(csvField(-12), '-12');
  const before = process.env.NAVIGATION_TIMEOUT_MS;
  try {
    process.env.NAVIGATION_TIMEOUT_MS = '9999999999999999999999';
    assert.throws(() => loadConfig('/tmp'), /NAVIGATION_TIMEOUT_MS/);
  } finally {
    if (before === undefined) delete process.env.NAVIGATION_TIMEOUT_MS; else process.env.NAVIGATION_TIMEOUT_MS = before;
  }
  const crash = new Error('browserContext.newPage: Target page, context or browser has been closed');
  assert.equal(isBatchFatal(crash), true);
  assert.equal(classify(crash, 1, '').type, 'browser_closed');
  for (const code of ['ENOSPC', 'SQLITE_FULL', 'SQLITE_BUSY', 'SQLITE_IOERR_WRITE']) {
    const error = Object.assign(new Error(code), { code });
    assert.throws(() => throwIfStorageError(error), (caught) => caught === error);
  }
});

test('session replacement repairs permissive temporary-file permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-session-'));
  try {
    const path = join(dir, 'browser', 'instagram-state.json');
    mkdirSync(join(dir, 'browser'));
    writeFileSync(`${path}.tmp`, 'old', { mode: 0o644 });
    const session = new InstagramSessionManager({}, path, 1000, silent);
    await session.saveState({ storageState: async () => ({ cookies: [], origins: [] }) });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'browser')).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media stops on disk failure without spending download attempts', async () => {
  const f = dataset();
  try {
    const id = f.post();
    f.db.prepare("INSERT INTO media (post_id, position, media_type, source_url) VALUES (?, 0, 'image', 'https://cdn.test/image.jpg')").run(id);
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let requests = 0;
    await assert.rejects(processCompetitorMedia(f.db, { id: 1, username: 'brand' }, {
      dataDir: f.dir, log: silent, limit: null, sleep: async () => {}, fetch: async () => { requests++; throw error; },
    }), (caught) => caught === error);
    assert.equal(requests, 1);
    assert.equal(f.db.prepare('SELECT download_attempts FROM media').get().download_attempts, 0);
  } finally { f.close(); }
});

test('unfinished response bodies time out and logs strip credentials and control characters', async () => {
  const started = Date.now();
  await waitForResponses([new Promise(() => {})], 20);
  assert.ok(Date.now() - started < 1000);
  const previous = process.env.TRANSCRIPTION_API_KEY;
  try {
    process.env.TRANSCRIPTION_API_KEY = 'test-secret-token';
    const text = redactLog('error test-secret-token https://user:pass@example.test/file?token=secret#part\u001b[31m\n');
    assert.ok(!/test-secret-token|pass|token=|\p{Cc}/u.test(text));
  } finally {
    if (previous === undefined) delete process.env.TRANSCRIPTION_API_KEY; else process.env.TRANSCRIPTION_API_KEY = previous;
  }
});

test('profile capture releases its response listener before discovery keeps scrolling the page', async () => {
  const page = Object.assign(new EventEmitter(), {
    goto: async () => ({ status: () => 200 }),
    waitForFunction: async () => {}, waitForTimeout: async () => {}, close: async () => {},
    url: () => 'https://www.instagram.com/brand/',
    evaluate: async () => ({ title: 'Brand', meta: { 'og:type': 'profile' }, jsonTexts: [],
      dom: { followers: null, following: null, headerText: '', verified: false, externalHref: null, avatarSrc: null, headings: [], bodyText: '' } }),
  });
  const result = await openProfile({ newPage: async () => page }, { inspect: async () => 'authenticated' }, 'brand', { dataDir: '/tmp', log: silent });
  assert.equal(result.page, page);
  assert.equal(page.listenerCount('response'), 0);
});
