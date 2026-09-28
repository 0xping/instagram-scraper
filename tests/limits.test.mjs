import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrate, openDatabase, registerCompetitors } from '../dist/db.js';
import { assertMayCollect, instagramPause, pagesToday, watchInstagram } from '../dist/instagram-limits.js';

function dataset(t) {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  migrate(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

/** Just enough of a Playwright context: page loads and responses, as events. */
function fakeContext() {
  const context = new EventEmitter();
  const main = { parentFrame: () => null };
  context.open = (url) => context.emit('request', { isNavigationRequest: () => true, frame: () => main, url: () => url });
  context.fetch = (url) => context.emit('request', { isNavigationRequest: () => false, frame: () => main, url: () => url });
  context.respond = (url, status) => context.emit('response', { url: () => url, status: () => status });
  return context;
}

test('pages opened count toward the daily limit, and reaching it stops the run once', (t) => {
  const db = dataset(t);
  const context = fakeContext();
  const stops = [];
  watchInstagram(db, context, 3, (reason) => stops.push(reason));
  context.open('https://www.instagram.com/nike/');
  context.fetch('https://www.instagram.com/graphql/query');
  context.open('https://scontent.cdninstagram.com/v/photo.jpg');
  context.open('https://www.instagram.com/p/Abc12/');
  assert.equal(pagesToday(db), 2, 'only instagram.com pages count, not data requests or the CDN');
  assert.deepEqual(stops, []);
  context.open('https://www.instagram.com/p/Def34/');
  context.open('https://www.instagram.com/p/Ghi56/');
  assert.equal(stops.length, 1);
  assert.match(stops[0], /Daily limit reached: 3 Instagram pages/);
  assert.throws(() => assertMayCollect(db, 3), /Today's limit is used up: 4 Instagram pages opened \(limit 3\)/);
  assertMayCollect(db, 10);
  assertMayCollect(db, null);
});

test('Instagram pushing back pauses collecting for a day, from the browser or from a recorded failure', (t) => {
  const db = dataset(t);
  assert.equal(instagramPause(db), null);
  const context = fakeContext();
  watchInstagram(db, context, null, () => assert.fail('no limit set'));
  context.respond('https://scontent.cdninstagram.com/v/video.mp4', 429);
  assert.equal(instagramPause(db), null, 'a CDN 429 is not Instagram pushing back on the account');
  context.respond('https://www.instagram.com/graphql/query', 429);
  const pause = instagramPause(db);
  assert.match(pause.reason, /rate_limited: HTTP 429/);
  assert.equal(Date.parse(pause.until) - Date.parse(pause.at), 24 * 3_600_000);
  assert.throws(() => assertMayCollect(db, null), /Collecting is paused until .* --ignore-limits/);
  const tomorrow = new Date(Date.now() + 25 * 3_600_000);
  assert.equal(instagramPause(db, tomorrow), null, 'the pause ends after a day');

  const later = dataset(t);
  registerCompetitors(later, ['nike']);
  const id = later.prepare("SELECT id FROM competitors WHERE username = 'nike'").get().id;
  later.prepare(`INSERT INTO scrape_errors (competitor_id, stage, error_type, error_message, retryable)
    VALUES (?, 'comments', 'security_challenge', 'Instagram is showing a security challenge', 0)`).run(id);
  assert.match(instagramPause(later).reason, /^security_challenge/);
  const other = fakeContext();
  watchInstagram(later, other, null, () => {});
  other.open('https://www.instagram.com/challenge/?next=/');
  assert.equal(later.prepare('SELECT count(*) n FROM instagram_pushback').get().n, 1, 'a jump to a security check is recorded');
});
