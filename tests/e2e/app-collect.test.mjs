/* global process, Buffer, URL, fetch, setTimeout */
// Run by `npm run validate:e2e`, not the unit suite: it drives a real browser, so it needs the machine to itself.
// The dashboard's own collection run: pressing "Collect posts and media" drives the real collector against the
// fake Instagram from tests/e2e/, and "Stop current task" ends a run the way Ctrl-C does for the CLI.

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { render } from 'ink-testing-library';
import { chromium } from 'playwright';
import { App } from '../../dist/app/App.js';
import { migrate, openDatabase, registerCompetitors } from '../../dist/db.js';
import { createState, startFakeInstagram } from './fake-instagram.mjs';

const USER = 'e2e_dash';
// Smallest bytes that pass the collector's media verification: a JPEG header, padding and an end-of-image marker.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

/** Answers every instagram.com request from the fake server, like tests/e2e/cli-child.mjs does for the CLI. */
function routeChromium(server) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await newContext(contextOptions);
      await context.route(/^https:\/\/([a-z0-9-]+\.)*instagram\.com\//, async (route) => {
        const { pathname, search } = new URL(route.request().url());
        try {
          const response = await fetch(`${server}${pathname}${search}`, { method: route.request().method(), body: route.request().postData() ?? undefined, redirect: 'manual' });
          await route.fulfill({ status: response.status, headers: Object.fromEntries([...response.headers].filter(([n]) => !['content-encoding', 'transfer-encoding'].includes(n))), body: Buffer.from(await response.arrayBuffer()) });
        } catch {
          await route.abort().catch(() => undefined);
        }
      });
      return context;
    };
    return browser;
  };
  return () => { chromium.launch = launch; };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Ink styles markers and labels separately, so matching needs the frame without colour codes. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (frame) => (frame ?? '').replace(ANSI, '');
// Generous: the whole suite runs these files in parallel, so a real browser run here competes for the CPU.
async function until(check, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the dashboard');
    await wait(150);
  }
}

/** Walks the home menu to `label`, then opens it. */
async function choose(ui, label) {
  for (let i = 0; i < 12; i += 1) {
    if (ui.lastFrame()?.includes(`› ${label}`)) break;
    ui.stdin.write('\x1b[B');
    await wait(60);
  }
  assert.match(ui.lastFrame(), new RegExp(`› ${label}`), `menu never reached ${label}`);
  ui.stdin.write('\r');
}

test('the dashboard collects an account and stops a run on request', { timeout: 1_200_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'app-collect-'));
  const dataDir = join(work, 'data');
  const t0 = 1788000000;
  const state = createState(USER);
  state.posts = [
    { code: 'DashImg001', pk: '8100000001', kind: 'image', files: ['a.jpg'], caption: 'Dashboard post #one', likes: 12, takenAt: t0,
      comments: [{ id: '17900000001', user: 'fan_x', text: 'Nice one', at: t0 + 30, likes: 1 }] },
    { code: 'DashImg002', pk: '8100000002', kind: 'image', files: ['b.jpg'], caption: 'Dashboard post two', likes: 8, takenAt: t0 - 3600, comments: [] },
  ];
  const { server, url } = await startFakeInstagram(state, { 'a.jpg': jpeg, 'b.jpg': jpeg, 'avatar.jpg': jpeg, 'fallback.jpg': jpeg });
  const restoreChromium = routeChromium(url);
  // Shorten only the collector's jittered pacing (base + Math.random() * spread); Playwright's whole-number timeouts stay.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, typeof ms === 'number' && ms >= 1000 && !Number.isInteger(ms) ? ms / 20 : ms, ...rest);
  const env = { ...process.env };
  Object.assign(process.env, {
    BROWSER_HEADED: 'false', NAVIGATION_TIMEOUT_MS: '60000', DISCOVERY_SCROLL_DELAY_MS: '400', DISCOVERY_MAX_IDLE_SCROLLS: '2',
    COMMENTS_ROUND_DELAY_MS: '300', COMMENTS_MAX_SECONDS: '60', TRANSCRIPTION_PROVIDER: '', GROQ_API_KEY: '', TRANSCRIPTION_API_KEY: '',
  });

  mkdirSync(join(dataDir, 'raw'), { recursive: true });
  mkdirSync(join(dataDir, 'browser'), { recursive: true });
  writeFileSync(join(dataDir, 'browser', 'instagram-state.json'), JSON.stringify({
    cookies: [{ name: 'sessionid', value: 'dash-session', domain: '.instagram.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }], origins: [],
  }));
  const db = openDatabase(join(dataDir, 'raw', 'collector.sqlite'));
  migrate(db);
  registerCompetitors(db, [USER]);

  const ui = render(createElement(App, { db, dataDir, envPath: join(work, '.env'), firstRun: false }));
  try {
    await until(() => ui.lastFrame()?.includes(`@${USER}`));
    // Collecting is refused until the saved session has been checked, which the dashboard does on startup.
    await until(() => ui.lastFrame()?.includes('Instagram: connected'));
    await choose(ui, 'Collect posts and media');
    await until(() => ui.lastFrame()?.includes('Add an account, or choose what to collect'));
    for (let i = 0; i < 2; i += 1) { ui.stdin.write('\x1b[B'); await wait(80); } // past "Add a new account" and "All accounts"
    await until(() => plain(ui.lastFrame()).includes(`› @${USER}`));
    ui.stdin.write('\r');

    // The run reaches the collector: both posts, their media and the comment are saved to this dataset.
    const count = (sql) => db.prepare(sql).get().n;
    await until(() => count("SELECT count(*) AS n FROM posts WHERE extraction_status = 'complete'") === 2);
    await until(() => count("SELECT count(*) AS n FROM media WHERE download_status = 'complete'") === 2);
    await until(() => count('SELECT count(*) AS n FROM comments') === 1);
    assert.equal(db.prepare('SELECT followers_count AS n FROM competitors WHERE username = ?').get(USER).n, 1234, 'profile saved');
    await until(() => ui.lastFrame()?.includes('Scrape finished'));
    assert.equal(db.prepare("SELECT status FROM scrape_jobs WHERE job_type = 'pipeline' ORDER BY id DESC LIMIT 1").get().status, 'complete');

    // A second run is stopped from the menu: it ends promptly and says so, leaving the saved work alone.
    await until(() => ui.lastFrame()?.includes('What would you like to do?'));
    await choose(ui, 'Collect posts and media');
    await until(() => ui.lastFrame()?.includes('Add an account, or choose what to collect'));
    // The list now says the account is fully collected, and when.
    assert.match(plain(ui.lastFrame()), new RegExp(`@${USER} · 2 posts · all collected · (just now|\\d+ min ago)`));
    for (let i = 0; i < 2; i += 1) { ui.stdin.write('\x1b[B'); await wait(80); }
    await until(() => plain(ui.lastFrame()).includes(`› @${USER}`));
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Stop current task'));
    await choose(ui, 'Stop current task');
    await until(() => ui.lastFrame()?.includes('Stopping after the current item'));
    await until(() => !ui.lastFrame()?.includes('Stop current task'), 600_000);
    assert.equal(count("SELECT count(*) AS n FROM posts WHERE extraction_status = 'complete'"), 2, 'stopping kept the collected posts');
  } finally {
    ui.unmount();
    db.close();
    restoreChromium();
    globalThis.setTimeout = realSetTimeout;
    server.close();
    process.env = env;
    rmSync(work, { recursive: true, force: true });
  }
});
