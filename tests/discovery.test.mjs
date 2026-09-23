import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { countSaved, decide, normalizePostUrl, parseTimelineResponse, readCheckpoint, saveDiscovered, writeCheckpoint } from '../dist/discovery.js';
import { listCompetitors } from '../dist/competitors.js';
import { migrate, openDatabase } from '../dist/db.js';

test('normalizePostUrl canonicalizes every link shape the grid uses', () => {
  const cases = {
    '/wishoodie/p/DcwFSjaDQ6y/': 'https://www.instagram.com/p/DcwFSjaDQ6y/',
    '/wishoodie/reel/DdbVGpathXB/': 'https://www.instagram.com/reel/DdbVGpathXB/',
    '/p/Abc_12-xy/': 'https://www.instagram.com/p/Abc_12-xy/',
    '/reels/Abc_12-xy': 'https://www.instagram.com/reel/Abc_12-xy/',
    '/tv/Abc_12-xy/': 'https://www.instagram.com/p/Abc_12-xy/',
    'https://www.instagram.com/p/Abc_12-xy/?img_index=2&igsh=x#c': 'https://www.instagram.com/p/Abc_12-xy/',
    'https://instagram.com/brand.name/reel/Abc_12-xy/': 'https://www.instagram.com/reel/Abc_12-xy/',
  };
  for (const [href, url] of Object.entries(cases)) assert.equal(normalizePostUrl(href)?.url, url, href);
  assert.equal(normalizePostUrl('/wishoodie/reel/DdbVGpathXB/').type, 'reel');
  assert.equal(normalizePostUrl('/p/DcwFSjaDQ6y/').shortcode, 'DcwFSjaDQ6y');
  for (const href of ['/wishoodie/', '/wishoodie/followers/', '/explore/', '/stories/highlights/123/', '/p/', '/p/ab/',
    'https://example.com/p/Abc_12-xy/', '/wishoodie/p/Abc_12-xy/comments/', '/a/b/p/Abc_12-xy/']) {
    assert.equal(normalizePostUrl(href), null, href);
  }
});

test('parseTimelineResponse reads the user grid and ignores the home feed', () => {
  const body = JSON.stringify({ data: {
    xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: [
        { node: { code: 'DcwFSjaDQ6y', media_type: 8, product_type: 'carousel_container', user: { username: 'wishoodie' } } },
        { node: { code: 'DdMX9JJNoUt', media_type: 2, product_type: 'clips' } },
        { node: { code: 'Imageaaa1', media_type: 1, product_type: 'feed' } },
        { node: { code: 'Videoaaa1', media_type: 2, product_type: 'feed' } },
        { node: { id: 'no-code' } },
      ],
      page_info: { has_next_page: true, end_cursor: 'x' },
    },
    xdt_api__v1__feed__timeline__connection: { edges: [{ node: { media: { code: 'HomeFeed01' } } }], page_info: { has_next_page: true } },
  } });
  const [page, ...rest] = parseTimelineResponse(body);
  assert.equal(rest.length, 0);
  assert.equal(page.hasNextPage, true);
  assert.deepEqual(page.posts.map((p) => [p.shortcode, p.type]), [['DcwFSjaDQ6y', 'carousel'], ['DdMX9JJNoUt', 'reel'], ['Imageaaa1', 'image'], ['Videoaaa1', 'unknown']]);
  assert.equal(page.posts[1].url, 'https://www.instagram.com/reel/DdMX9JJNoUt/');
  const last = parseTimelineResponse('for (;;);' + JSON.stringify({ a: { polaris_ordered_timeline_connection: { edges: [], page_info: { has_next_page: false } } } }));
  assert.equal(last[0].hasNextPage, false);
  assert.deepEqual(parseTimelineResponse('not json'), []);
  assert.deepEqual(parseTimelineResponse(JSON.stringify({ user_timeline: { edges: [null, {}, { node: null }], page_info: { has_next_page: false } } })),
    [{ posts: [], hasNextPage: false }], 'changed or null edge shapes cannot crash a response callback');
});

const base = { mode: 'full', scrolls: 10, idle: 0, maxIdle: 5, recoveryUsed: false, hasNextPage: null, knownStreak: 0, seenThisRun: 100, profilePostsCount: 200, aborted: false };

test('decide: POST_LIMIT ends the walk once enough posts are seen, not before', () => {
  assert.deepEqual(decide({ ...base, seenThisRun: 100, maxPosts: 100 }), { action: 'stop', status: 'complete', reason: 'post_limit' });
  assert.deepEqual(decide({ ...base, seenThisRun: 99, maxPosts: 100 }), { action: 'continue' });
  assert.deepEqual(decide({ ...base, maxPosts: null }), { action: 'continue' });
});

test('decide never ends on a single quiet scroll', () => {
  for (let idle = 1; idle < 5; idle += 1) assert.deepEqual(decide({ ...base, idle }), { action: 'continue' });
});

test('decide: has_next_page false is definitive, even mid-run', () => {
  assert.deepEqual(decide({ ...base, hasNextPage: false }), { action: 'stop', status: 'complete', reason: 'end_of_profile' });
});

test('decide: idle with posts missing recovers once, then records incomplete', () => {
  assert.deepEqual(decide({ ...base, idle: 5 }), { action: 'recover' });
  assert.deepEqual(decide({ ...base, idle: 5, recoveryUsed: true }), { action: 'stop', status: 'incomplete', reason: 'posts_missing' });
  assert.equal(decide({ ...base, idle: 5, recoveryUsed: true, hasNextPage: true }).reason, 'loading_stalled');
  assert.equal(decide({ ...base, idle: 5, recoveryUsed: true, profilePostsCount: null }).reason, 'end_unverified');
});

test('decide: only posts seen in this walk prove count-based completion; no tolerance hides missing posts', () => {
  assert.deepEqual(decide({ ...base, idle: 5, seenThisRun: 200 }), { action: 'stop', status: 'complete', reason: 'all_posts_found' });
  assert.deepEqual(decide({ ...base, idle: 5, seenThisRun: 199 }), { action: 'recover' });
  assert.deepEqual(decide({ ...base, idle: 5, seenThisRun: 0, savedForCompetitor: 10000, profilePostsCount: 2 }), { action: 'recover' });
  // Instagram saying there is more overrides the count.
  assert.deepEqual(decide({ ...base, idle: 5, seenThisRun: 200, hasNextPage: true }), { action: 'recover' });
});

test('decide: incremental stops on a known streak; full mode never does', () => {
  assert.equal(decide({ ...base, mode: 'incremental', knownStreak: 24 }).reason, 'caught_up');
  assert.deepEqual(decide({ ...base, mode: 'incremental', knownStreak: 23 }), { action: 'continue' });
  assert.deepEqual(decide({ ...base, mode: 'full', knownStreak: 500 }), { action: 'continue' });
});

test('decide: interruption, empty profile and the scroll ceiling', () => {
  assert.equal(decide({ ...base, aborted: true, hasNextPage: false }).reason, 'interrupted');
  assert.equal(decide({ ...base, seenThisRun: 0, profilePostsCount: 0 }).reason, 'no_posts');
  assert.equal(decide({ ...base, scrolls: 2000 }).reason, 'scroll_limit');
});

test('saveDiscovered is idempotent, links collabs, and reports when each post became known', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-discovery-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const a = Number(db.prepare("INSERT INTO competitors (username) VALUES ('alpha')").run().lastInsertRowid);
    const b = Number(db.prepare("INSERT INTO competitors (username) VALUES ('beta')").run().lastInsertRowid);
    const post = (code, type = 'unknown') => ({ shortcode: code, url: `https://www.instagram.com/p/${code}/`, type });

    const first = saveDiscovered(db, a, [post('Code0001'), post('Code0002', 'reel')]);
    assert.deepEqual(first.map((f) => f.isNew), [true, true]);
    const again = saveDiscovered(db, a, [post('Code0001', 'carousel'), post('Code0002'), post('Code0003')]);
    assert.deepEqual(again.map((f) => f.isNew), [false, false, true]);
    assert.match(again[0].knownSince, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(db.prepare("SELECT type FROM posts WHERE shortcode = 'Code0001'").get().type, 'carousel', 'unknown type filled in');
    assert.equal(db.prepare("SELECT type FROM posts WHERE shortcode = 'Code0002'").get().type, 'reel', 'known type not overwritten');

    // A collab: already saved under alpha, found on beta's grid. New for beta, still one row.
    assert.deepEqual(saveDiscovered(db, b, [post('Code0001')]).map((f) => f.isNew), [true]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n, 3);
    assert.equal(countSaved(db, a), 3);
    assert.equal(countSaved(db, b), 1);
    assert.deepEqual(listCompetitors(db).map((r) => [r.username, r.discovered]), [['alpha', 3], ['beta', 1]]);
    const row = db.prepare("SELECT discovery_status, extraction_status FROM posts WHERE shortcode = 'Code0003'").get();
    assert.deepEqual(row, { discovery_status: 'complete', extraction_status: 'pending' });

    assert.equal(readCheckpoint(db, a), null);
    const checkpoint = { version: 1, status: 'incomplete', completedAt: null, lastRunAt: 'x', endReason: 'interrupted', deepestShortcode: 'Code0003', lastRun: { mode: 'full', seen: 3, new: 1, known: 2, scrolls: 1 } };
    writeCheckpoint(db, a, checkpoint);
    writeCheckpoint(db, a, { ...checkpoint, status: 'complete' });
    assert.equal(readCheckpoint(db, a).status, 'complete');
    assert.equal(db.prepare("SELECT count(*) AS n FROM collection_checkpoints WHERE stage = 'discovery'").get().n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
