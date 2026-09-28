/* global AbortController, Buffer, URL, fetch, TextDecoder, setTimeout */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

// No network in tests: the update check stays off.
process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK = '1';
import { parseAccountList } from '../dist/app/model.js';
import { startDashboard } from '../dist/app/server.js';
import { competitorStatus } from '../dist/batch.js';
import { listCompetitors } from '../dist/competitors.js';
import { acquireDatasetLock, hideCompetitor, migrate, openDatabase, registerCompetitors } from '../dist/db.js';
import { saveSettings } from '../dist/env-file.js';
import { openDataPath, openInstagramUrl, resolveDataPath } from '../dist/open-path.js';
import { resolveCompetitors } from '../dist/runner.js';
import { saveDiscovered } from '../dist/discovery.js';
import { findClaude } from '../dist/app/terminal.js';
import { execFileSync } from 'node:child_process';

test('pasted text and imported files give usernames, and archiving preserves data', () => {
  assert.deepEqual(parseAccountList(' @Alpha, https://instagram.com/beta/\n gamma @alpha'), { usernames: ['alpha', 'beta', 'gamma'], skipped: [] });
  assert.deepEqual(parseAccountList('https://instagram.com/p/abc/ @ok not!valid').skipped, ['https://instagram.com/p/abc/', 'not!valid']);
  // A .txt list with comments and Windows line endings.
  assert.deepEqual(parseAccountList('\uFEFF# my list\r\nnorthwind.studio\r\n@atelier.sable\r\n\r\n').usernames, ['northwind.studio', 'atelier.sable']);
  // A spreadsheet export: only the named column is read, so follower counts are not taken for usernames.
  const csv = 'Name,Instagram,Followers\n"North Wind",https://www.instagram.com/northwind.studio/,12000\nSable,@atelier.sable,800\nNo handle,,5\n';
  assert.deepEqual(parseAccountList(csv), { usernames: ['northwind.studio', 'atelier.sable'], skipped: [] });
  assert.deepEqual(parseAccountList('username;notes\nrue.ceramics;good\n').usernames, ['rue.ceramics']);
  const dir = mkdtempSync(join(tmpdir(), 'app-model-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    registerCompetitors(db, ['alpha', 'beta']);
    const alpha = resolveCompetitors(db, ['alpha'])[0];
    assert.ok(alpha);
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (?, 'PostA', 'u')").run(alpha.id);
    hideCompetitor(db, alpha.id);
    assert.deepEqual(resolveCompetitors(db, ['--all']).map((c) => c.username), ['beta']);
    assert.deepEqual(competitorStatus(db).map((c) => c.username), ['beta']);
    assert.deepEqual(listCompetitors(db).map((c) => c.username), ['beta']);
    assert.equal(db.prepare('SELECT count(*) n FROM posts').get().n, 1);
    registerCompetitors(db, ['alpha']);
    assert.deepEqual(resolveCompetitors(db, ['--all']).map((c) => c.username).sort(), ['alpha', 'beta']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings preserve other entries and comments, keep secrets private, and validate before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-settings-'));
  const file = join(dir, '.env');
  const keys = ['GROQ_API_KEY', 'TRANSCRIPTION_PROVIDER', 'COMMENT_LIMIT', 'FRAME_INTERVAL', 'BROWSER_HEADED'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    writeFileSync(file, '# keep me\nUNKNOWN=value\nFRAME_INTERVAL=2\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    saveSettings(file, { GROQ_API_KEY: 'test-secret', TRANSCRIPTION_PROVIDER: 'groq', COMMENT_LIMIT: '200', FRAME_INTERVAL: '1.5' });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /# keep me\nUNKNOWN=value/);
    assert.match(text, /FRAME_INTERVAL="1.5"/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(process.env.GROQ_API_KEY, 'test-secret');
    assert.throws(() => saveSettings(file, { FRAME_INTERVAL: '0' }), /positive/);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(process.env.FRAME_INTERVAL, '1.5');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer paths cannot escape through traversal or symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-path-'));
  const outside = mkdtempSync(join(tmpdir(), 'app-outside-'));
  try {
    writeFileSync(join(dir, 'image.jpg'), 'x');
    assert.equal(resolveDataPath(dir, 'image.jpg'), join(dir, 'image.jpg'));
    assert.throws(() => resolveDataPath(dir, join(outside, 'outside.jpg')), /ENOENT|outside/);
    writeFileSync(join(outside, 'outside.jpg'), 'x');
    assert.throws(() => resolveDataPath(dir, '../' + outside.split('/').at(-1) + '/outside.jpg'), /outside/);
    symlinkSync(outside, join(dir, 'linked'));
    assert.throws(() => resolveDataPath(dir, 'linked/outside.jpg'), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('opening a missing folder or invalid URL rejects instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-open-'));
  try {
    const missing = openDataPath(dir, 'competitors/missing');
    assert.ok(missing instanceof Promise);
    await assert.rejects(missing, /ENOENT/);
    const invalidUrl = openInstagramUrl('https://example.com/post');
    assert.ok(invalidUrl instanceof Promise);
    await assert.rejects(invalidUrl, /Only Instagram HTTPS links/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A dataset with one collected account (a photo post with a comment and a saved file) and one never collected. */
async function dashboard(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-server-'));
  const envKeys = ['DATA_DIR', 'TRANSCRIPTION_PROVIDER', 'TRANSCRIPTION_BASE_URL', 'TRANSCRIPTION_MODEL', 'COMMENT_LIMIT', 'FRAME_INTERVAL', 'BROWSER_SHOW', 'BROWSER_HEADED', 'DAILY_PAGE_LIMIT', 'GROQ_API_KEY'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = dir;
  const db = openDatabase(join(dir, 'collector.sqlite'));
  migrate(db);
  registerCompetitors(db, ['alpha', 'beta']);
  const alpha = db.prepare("SELECT id FROM competitors WHERE username = 'alpha'").get().id;
  const post = Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, caption, published_at, likes_count, comments_count, extraction_status)
    VALUES (?, 'AlphaPost1', 'https://www.instagram.com/p/AlphaPost1/', 'image', 'Hello', '2026-09-01T10:00:00Z', 12, 1, 'complete')`).run(alpha).lastInsertRowid);
  const folder = join(dir, 'competitors', 'alpha', 'posts', 'AlphaPost1', 'media');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '001.jpg'), Buffer.alloc(1000, 7));
  db.prepare(`INSERT INTO media (post_id, position, local_path, download_status) VALUES (?, 0, 'competitors/alpha/posts/AlphaPost1/media/001.jpg', 'complete')`).run(post);
  db.prepare("INSERT INTO comments (post_id, username, text, likes_count) VALUES (?, 'fan', 'Nice', 3)").run(post);
  const opened = [];
  const app = await startDashboard({ db, dataDir: dir, envPath: join(dir, '.env'), open: async (_, path) => { opened.push(path); }, ...extra });
  t.after(async () => {
    await app.close();
    db.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  const call = async (path, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'x-token': app.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, db, dir, post, opened, origin, call };
}

/** fetch() will not send another Host header, so the rebinding check needs a raw request. */
function withHost(origin, path, host) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    request({ hostname, port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
}

test('the dashboard answers only with the launch token, on its own address, and serves only media from the dataset', async (t) => {
  const { app, dir, origin } = await dashboard(t);
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]{20,}$/);
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer', 'the token must not leak to instagram.com through a link');
  assert.equal((await fetch(`${origin}/`)).status, 403);
  assert.equal((await fetch(`${origin}/?t=wrong`)).status, 403);
  assert.equal((await fetch(`${origin}/api/state`)).status, 403);
  assert.equal((await fetch(`${origin}/api/stop`, { method: 'POST', headers: { 'x-token': 'wrong' } })).status, 403);
  assert.equal(await withHost(origin, `/?t=${app.token}`, `evil.example:${new URL(origin).port}`), 421);

  const photo = `${origin}/media?t=${app.token}&p=competitors/alpha/posts/AlphaPost1/media/001.jpg`;
  const full = await fetch(photo);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const part = await fetch(photo, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${photo}`.replace(app.token, 'wrong'))).status, 403);
  assert.equal((await fetch(`${origin}/media?t=${app.token}&p=collector.sqlite`)).status, 404, 'the database is not media');
  const outside = mkdtempSync(join(tmpdir(), 'app-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.jpg'), 'x');
  assert.equal((await fetch(`${origin}/media?t=${app.token}&p=${encodeURIComponent(join(outside, 'secret.jpg'))}`)).status, 404);
  assert.equal((await fetch(`${origin}/media?t=${app.token}&p=../${outside.split('/').at(-1)}/secret.jpg`)).status, 404);
  symlinkSync(outside, join(dir, 'linked'));
  assert.equal((await fetch(`${origin}/media?t=${app.token}&p=linked/secret.jpg`)).status, 404);
});

test('the dashboard lists accounts, their posts, and one post in full', async (t) => {
  const { call, post } = await dashboard(t);
  const { body: state } = await call('/api/state');
  assert.deepEqual(state.accounts.map((a) => [a.username, a.saved, a.text]), [['alpha', 1, 'All collected'], ['beta', 0, 'Never collected']]);
  assert.equal(state.task, null, 'no task runs until asked: there is no saved login to check');
  assert.equal(state.session, 'missing');
  assert.deepEqual(state.instagram, { pagesToday: 0, limit: 300, pause: null }, 'the page shows today\'s Instagram activity');
  assert.equal(state.update, false);

  const { body: grid } = await call('/api/posts?account=alpha');
  assert.equal(grid.account.username, 'alpha');
  assert.deepEqual(grid.posts.map((p) => [p.shortcode, p.type, p.likes, p.thumb]), [['AlphaPost1', 'image', 12, 'competitors/alpha/posts/AlphaPost1/media/001.jpg']]);
  assert.equal(grid.more, false);
  assert.equal((await call('/api/posts?account=nobody')).status, 404);

  const { body: detail } = await call(`/api/post?id=${post}`);
  assert.equal(detail.caption, 'Hello');
  assert.equal(detail.comments, 1, 'the comment count stays a number');
  assert.deepEqual(detail.topComments.map((c) => [c.username, c.text]), [['fan', 'Nice']]);
  assert.deepEqual(detail.media, [{ path: 'competitors/alpha/posts/AlphaPost1/media/001.jpg', video: false }]);
  assert.equal(detail.url, 'https://www.instagram.com/p/AlphaPost1/');
  assert.equal(detail.folder, true);
  assert.equal((await call('/api/post?id=999')).status, 404);
});

test('the dashboard adds, hides, exports and opens folders it works out itself', async (t) => {
  const { call, db, dir, post, opened } = await dashboard(t);
  const added = (await call('/api/accounts', { text: '@Gamma, https://instagram.com/delta/ alpha no!pe' })).body;
  assert.deepEqual([added.usernames, added.added, added.skipped], [['gamma', 'delta', 'alpha'], 2, ['no!pe']], 'alpha was already there');
  assert.match((await call('/api/accounts', { text: 'https://instagram.com/p/abc/' })).body.error, /No Instagram usernames found/);
  assert.equal((await call('/api/hide', { account: 'gamma' })).status, 200);
  assert.deepEqual((await call('/api/state')).body.accounts.map((a) => a.username), ['alpha', 'beta', 'delta']);
  assert.equal(db.prepare("SELECT count(*) n FROM competitors WHERE username = 'gamma'").get().n, 1, 'hiding keeps the data');

  // Collecting needs Instagram, and one account at a time is checked before anything starts.
  assert.match((await call('/api/collect', { accounts: ['alpha'], maxPosts: null })).body.error, /Connect Instagram first/);
  assert.match((await call('/api/collect', { accounts: ['alpha'], maxPosts: 0 })).body.error, /whole number/);

  const exported = await call('/api/export', { account: 'alpha' });
  assert.equal(exported.status, 200);
  assert.ok(existsSync(join(dir, 'exports', 'alpha', 'alpha.json')));
  assert.match(readFileSync(join(dir, 'exports', 'alpha', 'posts.csv'), 'utf8'), /AlphaPost1/);
  assert.equal(existsSync(join(dir, 'exports', 'beta')), false);
  assert.equal(opened.at(-1), 'exports', 'the export folder opens afterwards');

  await call('/api/open', { what: 'data' });
  await call('/api/open', { what: 'account', account: 'alpha' });
  await call('/api/open', { what: 'post', id: post });
  assert.deepEqual(opened.slice(-3), ['.', join('competitors', 'alpha'), join(dir, 'competitors', 'alpha', 'posts', 'AlphaPost1')]);
  assert.equal((await call('/api/open', { what: 'account', account: '../../etc' })).status, 400);
  assert.equal((await call('/api/open', { what: 'elsewhere', path: '/etc' })).status, 400, 'the page cannot name a path');
});

test('settings save everything a transcription choice needs in one step', async (t) => {
  const { call, dir } = await dashboard(t);
  const form = { service: 'local', comments: 'all', fps: 2, show: true, dailyLimit: '150' };
  const saved = await call('/api/settings', form);
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.service, saved.body.comments, saved.body.fps, saved.body.show], ['local', 'all', 2, true]);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  for (const line of ['TRANSCRIPTION_PROVIDER="custom"', 'TRANSCRIPTION_BASE_URL="http://127.0.0.1:8080/v1"', 'TRANSCRIPTION_MODEL="large-v3-turbo"',
    'COMMENT_LIMIT="all"', 'FRAME_INTERVAL="0.5"', 'BROWSER_SHOW="true"', 'BROWSER_HEADED="true"', 'DAILY_PAGE_LIMIT="150"']) assert.ok(env.includes(line), line);
  delete process.env.GROQ_API_KEY;
  assert.match((await call('/api/settings', { ...form, service: 'groq' })).body.error, /Groq API key/);
  assert.match((await call('/api/settings', { ...form, comments: 'lots' })).body.error, /whole number/);
  assert.match((await call('/api/settings', { ...form, fps: 0 })).body.error, /more than 0/);
  assert.match((await call('/api/settings', { ...form, dailyLimit: 'lots' })).body.error, /pages per day/);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), env, 'a refused form changes nothing');
});

test('posts filter by type and caption, sort by a metric, and a deleted post stays deleted', async (t) => {
  const { call, db, dir, post } = await dashboard(t);
  const alpha = db.prepare("SELECT id FROM competitors WHERE username = 'alpha'").get().id;
  db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, caption, published_at, likes_count, extraction_status)
    VALUES (?, 'AlphaReel1', 'https://www.instagram.com/reel/AlphaReel1/', 'reel', 'Summer sale 100%', '2026-08-01T10:00:00Z', 50, 'complete')`).run(alpha);
  const codes = async (query) => (await call(`/api/posts?account=alpha&${query}`)).body.posts.map((p) => p.shortcode);
  assert.deepEqual(await codes(''), ['AlphaPost1', 'AlphaReel1'], 'newest first by default');
  assert.deepEqual(await codes('sort=likes'), ['AlphaReel1', 'AlphaPost1']);
  assert.deepEqual(await codes('type=reel'), ['AlphaReel1']);
  assert.deepEqual(await codes('q=SALE'), ['AlphaReel1'], 'caption search ignores case');
  assert.deepEqual(await codes('q=100%25'), ['AlphaReel1']);
  assert.deepEqual(await codes('q=1_0'), [], '_ is a literal, not a wildcard');
  assert.equal((await call('/api/posts?account=alpha&type=reel')).body.total, 1);
  assert.match((await call('/api/posts?account=alpha&sort=best')).body.error, /sort must be one of/);
  assert.match((await call('/api/posts?account=alpha&type=story')).body.error, /type must be one of/);

  assert.match((await call('/api/delete-posts', { ids: [] })).body.error, /ids/);
  // The page stays open for browsing while the CLI works: it holds the dataset lock only while it changes something.
  const cliLock = acquireDatasetLock(dir);
  const refused = await call('/api/delete-posts', { ids: [post] });
  assert.deepEqual([refused.status, /command-line collection/.test(refused.body.error)], [409, true]);
  assert.equal((await call('/api/posts?account=alpha')).status, 200, 'browsing works during a CLI collection');
  cliLock.close();
  assert.deepEqual((await call('/api/delete-posts', { ids: [post, post, 999] })).body, { deleted: 1 });
  assert.deepEqual(await codes(''), ['AlphaReel1']);
  assert.equal((await call(`/api/post?id=${post}`)).status, 404);
  assert.equal(existsSync(join(dir, 'competitors', 'alpha', 'posts', 'AlphaPost1')), false, 'its files are gone');
  assert.equal(db.prepare('SELECT count(*) n FROM media WHERE post_id = ?').get(post).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM comments WHERE post_id = ?').get(post).n, 0);
  assert.equal((await call('/api/state')).body.accounts[0].saved, 1);
  assert.doesNotMatch(readFileSync(join(dir, 'competitors', 'alpha', 'posts.jsonl'), 'utf8'), /AlphaPost1/, 'the agent files are refreshed');
  // Found again on the profile: known, not new, and never linked back.
  assert.deepEqual(saveDiscovered(db, alpha, [{ shortcode: 'AlphaPost1', url: 'https://www.instagram.com/p/AlphaPost1/', type: 'image' }]).map((f) => f.isNew), [false]);
  assert.deepEqual(await codes(''), ['AlphaReel1']);
  assert.deepEqual((await call('/api/delete-posts', { ids: [post] })).body, { deleted: 0 }, 'deleting twice is harmless');
});

test('the CLI deletes posts by shortcode or link and prints status as JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-delete-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'raw'));
  const db = openDatabase(join(dir, 'raw', 'collector.sqlite'));
  migrate(db);
  registerCompetitors(db, ['alpha']);
  const alpha = db.prepare("SELECT id FROM competitors WHERE username = 'alpha'").get().id;
  for (const code of ['CodeOne1', 'CodeTwo2']) db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (?, ?, 'u')").run(alpha, code);
  db.close();
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error' }, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => cli('delete-post', 'CodeOne1', 'Typo9999'), (error) => /No saved post with shortcode: Typo9999\. Nothing was deleted/.test(error.stderr));
  assert.equal(JSON.parse(cli('status', '--json'))[0].discovered, 2, 'a typo deletes nothing');
  assert.match(cli('delete-post', 'CodeOne1', 'https://www.instagram.com/alpha/reel/CodeTwo2/?igsh=x'), /Deleted 2 post/);
  assert.deepEqual(JSON.parse(cli('status', '--json')).map((r) => [r.username, r.discovered]), [['alpha', 0]]);
});

test('Claude Code runs in a real terminal on the page: output streams live, keys go in, Stop ends it', async (t) => {
  // Stands in for Claude Code: answers each line it is sent.
  const echo = "process.stdout.write('ready\\n'); process.stdin.on('data', (d) => process.stdout.write('got:' + d));";
  const { app, origin, call } = await dashboard(t, { terminalCommand: () => ({ file: process.execPath, args: ['-e', echo] }) });
  const page = await fetch(app.url);
  assert.match(page.headers.get('content-security-policy'), /script-src 'unsafe-inline' 'self'/, 'the page may load the terminal library');
  const lib = await fetch(`${origin}/vendor/xterm.js`);
  assert.deepEqual([lib.status, lib.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  assert.equal((await fetch(`${origin}/api/term/stream`)).status, 403, 'the stream needs the launch key');
  assert.equal((await call('/api/term/start', { cols: 0, rows: 24 })).status, 400);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${origin}/api/term/stream?t=${app.token}`, { signal: controller.signal });
  const reader = stream.body.getReader();
  let text = '';
  const until = async (pattern) => {
    const decoder = new TextDecoder();
    while (!pattern.test(text)) {
      const { value, done } = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${pattern}: ${text}`)), 10_000))]);
      if (done) throw new Error('stream ended');
      text += decoder.decode(value);
    }
  };
  await until(/event: reset/);
  assert.equal((await call('/api/term/start', { cols: 100, rows: 30 })).status, 200);
  assert.equal((await call('/api/state')).body.terminal.running, true);
  await until(/ready/);
  await call('/api/term/input', { data: 'hello\r' });
  await until(/got:hello/);
  assert.equal((await call('/api/term/resize', { cols: 120, rows: 40 })).status, 200);
  await call('/api/term/stop', {});
  await until(/event: exit/);
  assert.equal((await call('/api/state')).body.terminal.running, false);
});

test('Claude Code is found where its installer puts it, or where CLAUDE_BIN says', () => {
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = '/opt/claude/bin/claude';
  try { assert.equal(findClaude(), '/opt/claude/bin/claude'); } finally { if (previous === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = previous; }
});
