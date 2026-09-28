/* global process, Buffer, URL, fetch, setTimeout, window, DataTransfer, File, DragEvent */
// Run by `npm run validate:e2e`, not the unit suite: it drives two real browsers, so it needs the machine to itself.
// The dashboard end to end: a headless browser clicks through the real page while the collector it starts runs
// against the fake Instagram from tests/e2e/. Set E2E_SHOTS=<folder> to keep screenshots of each step.
//
// The collector must use chromium.launch (patched below), not a kept profile: BROWSER_KEEP_PROFILE=true opens
// the browser with launchPersistentContext, which this routing never sees, and the run then talks to the real
// instagram.com and never connects. That is why the old dashboard test hung at "Instagram: connected".

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startDashboard } from '../../dist/app/server.js';
import { migrate, openDatabase } from '../../dist/db.js';
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
async function until(check, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${check}`);
    await wait(150);
  }
}

test('the dashboard connects, collects an account, shows its posts, and stops a run', { timeout: 900_000 }, async () => {
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
    DATA_DIR: dataDir, BROWSER_HEADED: 'false', BROWSER_KEEP_PROFILE: 'false', BROWSER_CHANNEL: '', NAVIGATION_TIMEOUT_MS: '60000',
    DISCOVERY_SCROLL_DELAY_MS: '400', DISCOVERY_MAX_IDLE_SCROLLS: '2', COMMENTS_ROUND_DELAY_MS: '300', COMMENTS_MAX_SECONDS: '60',
    TRANSCRIPTION_PROVIDER: '', GROQ_API_KEY: '', TRANSCRIPTION_API_KEY: '',
  });

  mkdirSync(join(dataDir, 'raw'), { recursive: true });
  mkdirSync(join(dataDir, 'browser'), { recursive: true });
  writeFileSync(join(dataDir, 'browser', 'instagram-state.json'), JSON.stringify({
    cookies: [{ name: 'sessionid', value: 'dash-session', domain: '.instagram.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }], origins: [],
  }));
  const db = openDatabase(join(dataDir, 'raw', 'collector.sqlite'));
  migrate(db);
  const opened = [];
  const dashboard = await startDashboard({ db, dataDir, envPath: join(work, '.env'), open: async (_, path) => { opened.push(path); } });
  const viewer = await chromium.launch();
  const page = await viewer.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shot = async (name) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) }); };
  const count = (sql) => db.prepare(sql).get().n;
  try {
    await page.goto(dashboard.url);
    // A saved login is checked on launch; collecting waits for it.
    await until(async () => (await page.textContent('#status')) === 'Connected');
    assert.equal(await page.locator('#connect').isHidden(), true);

    // Import a spreadsheet export: only its Instagram column is read. The message offers to collect what was added.
    await page.setInputFiles('#file', { name: 'brands.csv', mimeType: 'text/csv', buffer: Buffer.from(`Name,Instagram,Followers\nDash,https://www.instagram.com/${USER}/,1234\n`) });
    await page.getByText('Added 1 account from brands.csv.').waitFor();
    await shot('1-imported');
    await page.getByRole('button', { name: 'Collect it' }).click();
    // Its post count is unknown before the first run, and "All" is the default.
    await page.locator('#how-many[open]').waitFor();
    assert.equal(await page.textContent('#hm-title'), `Collect @${USER}`);
    assert.equal(await page.locator('input[name=limit][value=all]').isChecked(), true);
    await shot('2-how-many');
    await page.click('#how-many-form button.primary');
    await page.getByRole('button', { name: 'Stop' }).waitFor();
    await until(async () => !/^(Starting|Checking)/.test(await page.textContent('#act-sub')));
    await shot('3-collecting');

    await until(() => count("SELECT count(*) AS n FROM posts WHERE extraction_status = 'complete'") === 2);
    await until(() => count("SELECT count(*) AS n FROM media WHERE download_status = 'complete'") === 2);
    await until(() => count('SELECT count(*) AS n FROM comments') === 1);
    await until(async () => (await page.textContent('#act-title')) === 'Collect finished', 300_000);
    assert.equal(db.prepare("SELECT status FROM scrape_jobs WHERE job_type = 'pipeline' ORDER BY id DESC LIMIT 1").get().status, 'complete');
    const row = page.locator(`a.row[href="#/a/${USER}"]`);
    await until(async () => /2 posts · collected just now/.test(await row.textContent()));
    await shot('4-finished');

    // Review: the account's grid, then one post with its caption and top comment.
    await row.click();
    await until(async () => (await page.locator('.tile').count()) === 2);
    assert.match(await page.textContent('#a-line2'), /^2 posts saved · collected just now$/);
    await page.locator('.tile').first().click();
    await page.locator('#post[open]').waitFor();
    assert.match(await page.textContent('#p-info'), /Dashboard post #one/);
    assert.match(await page.textContent('#p-info'), /@fan_x.*Nice one/s);
    // The fake photo is not a decodable image, so check the file arrives rather than that it draws.
    const photo = await page.locator('#p-media img').getAttribute('src');
    const served = await page.request.get(new URL(photo, dashboard.url).href);
    assert.equal(served.status(), 200, 'the photo is served from the data folder');
    assert.equal((await served.body()).length, jpeg.length);
    await shot('5-post');
    await page.click('#p-folder');
    await until(() => opened.at(-1)?.endsWith(join('posts', 'DashImg001')));
    await page.keyboard.press('Escape');
    await page.click('#a-folder');
    await until(() => opened.at(-1) === join('competitors', USER));

    // A second run from the account page: the question now names the post count, and Stop ends the run.
    await page.click('#a-collect');
    await until(async () => /has \d+ posts?$/.test(await page.textContent('#hm-title')));
    await page.click('#how-many-form button.primary');
    await page.getByRole('button', { name: 'Stop' }).click();
    await until(() => dashboard.collector.logs.some((l) => l.text.includes('Stopping after the current item')));
    await until(() => !dashboard.collector.running, 300_000);
    await until(async () => /^Collect (stopped|finished)/.test(await page.textContent('#act-title')));
    assert.equal(count("SELECT count(*) AS n FROM posts WHERE extraction_status = 'complete'"), 2, 'stopping kept the collected posts');

    // A .txt dropped anywhere on the page adds its accounts too.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['# more brands\nsecond_brand\n'], 'more.txt', { type: 'text/plain' }));
      for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.getByText('Added 1 account from more.txt.').waitFor();
    await until(async () => (await page.locator('a.row[href="#/a/second_brand"]').count()) === 1);
    assert.equal(await page.locator('#drop').isHidden(), true);
    await shot('6-dropped');
    assert.deepEqual(errors, [], 'the page threw no errors');
  } finally {
    await viewer.close();
    await dashboard.close();
    db.close();
    restoreChromium();
    globalThis.setTimeout = realSetTimeout;
    server.close();
    process.env = env;
    rmSync(work, { recursive: true, force: true });
  }
});
