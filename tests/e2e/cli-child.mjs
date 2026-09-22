/* global process, URL, Buffer */
// Runs the real CLI (dist/cli.js) with two test-only changes, so nothing reaches the internet (transcription is
// pointed at the same server through TRANSCRIPTION_BASE_URL in the workspace .env):
//   - every instagram.com request from Chromium is answered by the fake server (E2E_SERVER);
//   - fractional waits of 1 s or more are shortened 20x. Only the collector's jittered pacing and scroll pauses are
//     fractional (base + Math.random() * spread); Playwright's own timeouts are whole numbers and keep their length.
// Usage: node cli-child.mjs <cli args...>   (cwd = the validation workspace with its own .env)

import { chromium } from 'playwright';

const server = process.env.E2E_SERVER;
if (!server) throw new Error('E2E_SERVER is required');
const realFetch = globalThis.fetch;

const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    await context.route(/^https:\/\/([a-z0-9-]+\.)*instagram\.com\//, async (route) => {
      const request = route.request();
      const { pathname, search } = new URL(request.url());
      try {
        const response = await realFetch(`${server}${pathname}${search}`, { method: request.method(), body: request.postData() ?? undefined, redirect: 'manual' });
        const headers = Object.fromEntries([...response.headers].filter(([name]) => !['content-encoding', 'transfer-encoding'].includes(name)));
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      } catch {
        await route.abort().catch(() => undefined); // browser closing during a Ctrl-C
      }
    });
    return context;
  };
  return browser;
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, typeof ms === 'number' && ms >= 1000 && !Number.isInteger(ms) ? ms / 20 : ms, ...args);

process.argv = [process.argv[0], new URL('../../dist/cli.js', import.meta.url).pathname, ...process.argv.slice(2)];
await import('../../dist/cli.js');
