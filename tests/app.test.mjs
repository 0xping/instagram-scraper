import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../dist/app/App.js';
import { parseCompetitorInput } from '../dist/app/model.js';
import { competitorStatus } from '../dist/batch.js';
import { listCompetitors } from '../dist/competitors.js';
import { hideCompetitor, migrate, openDatabase, registerCompetitors } from '../dist/db.js';
import { saveSettings } from '../dist/env-file.js';
import { openDataPath, openInstagramUrl, resolveDataPath } from '../dist/open-path.js';
import { resolveCompetitors } from '../dist/runner.js';
import { createTranscriptionProvider } from '../dist/transcription-provider.js';

/** The frame without colour codes: Ink styles the marker and the label separately, so matching needs plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (frame) => (frame ?? '').replace(ANSI, '');

async function until(check, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await delay(50);
  }
  assert.fail('Dashboard did not reach the expected state');
}

test('dashboard competitor input accepts mixed forms and archive preserves data', () => {
  assert.deepEqual(parseCompetitorInput(' @Alpha, https://instagram.com/beta/\n gamma @alpha'), ['alpha', 'beta', 'gamma']);
  assert.throws(() => parseCompetitorInput('https://instagram.com/p/abc/'), /Not a profile/);
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

test('opening a missing folder or invalid URL rejects without throwing into Ink input handling', async () => {
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

test('dashboard menu adds an account with arrows and Enter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-ink-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    registerCompetitors(db, ['brand']);
    const ui = render(createElement(App, { db, dataDir: dir, envPath: join(dir, '.env'), firstRun: false }));
    try {
      await until(() => ui.lastFrame()?.includes('@brand'));
      assert.match(ui.lastFrame(), /@brand/);
      assert.match(ui.lastFrame(), /INSTAGRAM RESEARCH/);
      assert.match(ui.lastFrame(), /What would you like to do\?/);
      assert.ok(ui.lastFrame().split('\n').length <= 24, 'Home should fit a standard terminal height');
      ui.stdin.write('\x1b[B');
      await until(() => ui.lastFrame()?.includes('› Collect posts and media'));
      ui.stdin.write('\r');
      // Collecting and adding are one flow: the list opens on "Add a new account".
      await until(() => plain(ui.lastFrame()).includes('› Add a new account'));
      assert.match(plain(ui.lastFrame()), /@brand · never collected/, 'each account shows whether it is collected');
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('Add Instagram accounts'));
      ui.stdin.write('newbrand');
      await until(() => ui.lastFrame()?.includes('newbrand'));
      ui.stdin.write('\r');
      await until(() => db.prepare("SELECT count(*) n FROM competitors WHERE username = 'newbrand'").get().n === 1);
      // Saving returns to the list, ready to collect what was just added.
      await until(() => plain(ui.lastFrame()).includes('@newbrand'));
      assert.match(plain(ui.lastFrame()), /Add an account, or choose what to collect/);
    } finally { ui.unmount(); }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export menu lists only accounts holding posts and exports the chosen one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-export-menu-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    registerCompetitors(db, ['alpha', 'beta', 'untouched']);
    for (const name of ['alpha', 'beta']) {
      const id = db.prepare('SELECT id FROM competitors WHERE username = ?').get(name).id;
      db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (?, ?, ?)").run(id, `${name}Post01`, `https://www.instagram.com/p/${name}Post01/`);
    }
    const ui = render(createElement(App, { db, dataDir: dir, envPath: join(dir, '.env'), firstRun: false }));
    try {
      await until(() => ui.lastFrame()?.includes('Export data'));
      for (const label of ['Collect posts and media', 'Review saved posts', 'Fix failed items', 'Export data']) {
        ui.stdin.write('\x1b[B');
        await until(() => ui.lastFrame()?.includes(`› ${label}`));
      }
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('Export @beta'));
      assert.match(ui.lastFrame(), /Export all accounts/);
      assert.match(ui.lastFrame(), /Export @alpha/);
      assert.doesNotMatch(ui.lastFrame(), /@untouched/, 'an account with nothing saved is not offered');
      ui.stdin.write('\x1b[B');
      await until(() => ui.lastFrame()?.includes('› Export @alpha'));
      ui.stdin.write('\x1b[B');
      await until(() => ui.lastFrame()?.includes('› Export @beta'));
      ui.stdin.write('\r');
      await until(() => existsSync(join(dir, 'exports', 'beta', 'beta.json')));
      assert.equal(existsSync(join(dir, 'exports', 'alpha')), false);
    } finally { ui.unmount(); }
  } finally {
    db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post menu offers only the actions a post can perform', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-post-actions-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    registerCompetitors(db, ['brand']);
    const brand = db.prepare("SELECT id FROM competitors WHERE username = 'brand'").get().id;
    // A Reel with a downloaded video and saved frames, and a post with nothing on disk yet.
    const reel = db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, published_at) VALUES (?, 'ReelPost01', 'https://www.instagram.com/reel/ReelPost01/', 'reel', '2026-01-02T00:00:00Z')").run(brand).lastInsertRowid;
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, published_at) VALUES (?, 'Missing001', 'https://www.instagram.com/p/Missing001/', 'image', '2026-01-01T00:00:00Z')").run(brand);
    const videoDir = join(dir, 'competitors', 'brand', 'posts', 'ReelPost01', 'media');
    mkdirSync(videoDir, { recursive: true });
    writeFileSync(join(videoDir, '001.mp4'), 'video');
    db.prepare(`INSERT INTO media (post_id, position, media_type, download_status, local_path)
      VALUES (?, 0, 'video', 'complete', 'competitors/brand/posts/ReelPost01/media/001.mp4')`).run(reel);
    db.prepare("INSERT INTO reel_frames (post_id, timestamp_seconds, image_path) VALUES (?, 0, 'competitors/brand/posts/ReelPost01/frames/g/frame_00001.jpg')").run(reel);

    const ui = render(createElement(App, { db, dataDir: dir, envPath: join(dir, '.env'), firstRun: false }));
    try {
      await until(() => ui.lastFrame()?.includes('@brand'));
      for (const label of ['Collect posts and media', 'Review saved posts']) {
        ui.stdin.write('\x1b[B');
        await until(() => ui.lastFrame()?.includes(`› ${label}`));
      }
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('Which account would you like to review?'));
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('ReelPost01'));
      ui.stdin.write('\r');
      // The Reel can be played, its images opened, and its folder opened.
      await until(() => ui.lastFrame()?.includes('Play the video'));
      assert.match(ui.lastFrame(), /Open the 1 video images/);
      assert.match(ui.lastFrame(), /Open this post’s folder/);
      ui.stdin.write('\x1b');

      // The post with nothing downloaded offers none of those, so no entry can fail.
      await until(() => ui.lastFrame()?.includes('Missing001'));
      ui.stdin.write('\x1b[B');
      await until(() => ui.lastFrame()?.includes('› Missing001') || ui.lastFrame()?.includes('Missing001'));
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('Scroll the details'));
      const frame = ui.lastFrame();
      assert.doesNotMatch(frame, /Play the video|Open the \d+ photos|Open the photo\b|Open the \d+ video images|Open this post/);
      assert.match(frame, /Open on Instagram/);
      assert.match(frame, /Post details/);
    } finally { ui.unmount(); }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review and fix menus leave out accounts with nothing to do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-menu-filter-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    registerCompetitors(db, ['withposts', 'untouched']);
    const id = db.prepare("SELECT id FROM competitors WHERE username = 'withposts'").get().id;
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (?, 'HasPost001', 'https://www.instagram.com/p/HasPost001/')").run(id);
    const ui = render(createElement(App, { db, dataDir: dir, envPath: join(dir, '.env'), firstRun: false }));
    const menu = async (label) => {
      for (let i = 0; i < 10 && !ui.lastFrame()?.includes(`› ${label}`); i += 1) {
        ui.stdin.write('\x1b[B');
        await delay(40);
      }
      await until(() => ui.lastFrame()?.includes(`› ${label}`));
      ui.stdin.write('\r');
    };
    try {
      await until(() => ui.lastFrame()?.includes('@withposts'));
      // Reviewing offers only the account that has posts.
      await menu('Review saved posts');
      await until(() => ui.lastFrame()?.includes('Which account would you like to review?'));
      assert.match(ui.lastFrame(), /@withposts/);
      assert.doesNotMatch(ui.lastFrame(), /@untouched/);
      ui.stdin.write('\x1b');

      // Nothing has failed, so fixing says so instead of opening an empty list.
      await until(() => ui.lastFrame()?.includes('What would you like to do?'));
      await menu('Fix failed items');
      await until(() => ui.lastFrame()?.includes('Nothing needs fixing right now.'));

      // Once a post fails, that account (and only that one) is offered.
      db.prepare("UPDATE posts SET extraction_status = 'failed', availability = 'available' WHERE shortcode = 'HasPost001'").run();
      await until(() => ui.lastFrame()?.includes('need attention'), 30_000);
      await menu('Fix failed items');
      await until(() => ui.lastFrame()?.includes('Which account needs another try?'));
      assert.match(ui.lastFrame(), /@withposts/);
      assert.doesNotMatch(ui.lastFrame(), /@untouched/);
    } finally { ui.unmount(); }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings switch transcription to local Whisper in one step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-whisper-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DATA_DIR=./data\n# keep me\n');
  const keys = ['TRANSCRIPTION_PROVIDER', 'TRANSCRIPTION_BASE_URL', 'TRANSCRIPTION_MODEL', 'TRANSCRIPTION_API_KEY', 'GROQ_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // Start from a known service, so choosing Whisper is a real change (re-picking the current one saves nothing).
  for (const k of keys) delete process.env[k];
  process.env.TRANSCRIPTION_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-key';
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const ui = render(createElement(App, { db, dataDir: dir, envPath, firstRun: false }));
    try {
      await until(() => ui.lastFrame()?.includes('What would you like to do?'));
      for (let i = 0; i < 10 && !ui.lastFrame()?.includes('› Settings'); i += 1) {
        ui.stdin.write('\x1b[B');
        await delay(40);
      }
      ui.stdin.write('\r');
      await until(() => ui.lastFrame()?.includes('Video speech transcription: Groq'), 1200);
      ui.stdin.write('\r'); // open the service picker, which starts on the first option
      await until(() => plain(ui.lastFrame()).includes('❯ Off (no transcripts)'), 1200);
      for (let i = 0; i < 2; i += 1) { ui.stdin.write('\x1b[B'); await delay(60); }
      await until(() => plain(ui.lastFrame()).includes('❯ Whisper on this computer (free)'), 1200);
      ui.stdin.write('\r');
      // Everything the service needs is written at once, so transcription is ready without editing .env.
      await until(() => readFileSync(envPath, 'utf8').includes('TRANSCRIPTION_PROVIDER'), 1200);
      const env = readFileSync(envPath, 'utf8');
      assert.match(env, /TRANSCRIPTION_PROVIDER="custom"/);
      assert.match(env, /TRANSCRIPTION_BASE_URL="http:\/\/127\.0\.0\.1:8080\/v1"/);
      assert.match(env, /TRANSCRIPTION_MODEL="large-v3-turbo"/);
      assert.match(env, /# keep me/, 'other entries and comments survive');
      const provider = createTranscriptionProvider();
      assert.deepEqual([provider.name, provider.model], ['custom', 'large-v3-turbo']);
      await until(() => ui.lastFrame()?.includes('Whisper server address'));
    } finally { ui.unmount(); }
  } finally {
    db.close();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
