import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { decide, finalOutcome, finishPost, parseCommentsPayload, parseCommentsText, parsePostCommentsText, saveComments, scrapeComments, selectCommentPosts } from '../dist/comments.js';
import { migrate, openDatabase } from '../dist/db.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const limits = { maxRounds: 60, maxIdleRounds: 3, maxSeconds: 300, roundDelayMs: 1 };
const t0 = 1_700_000_000;

test('parseCommentsPayload reads REST and GraphQL shapes, links replies, drops the caption and private fields', () => {
  const rest = parseCommentsPayload({
    caption: { pk: 'cap', text: 'the caption', user: { username: 'owner' }, created_at: t0 },
    comments: [{
      pk: '1', text: 'top', created_at: t0, comment_like_count: 3, child_comment_count: 1,
      user: { username: 'a', pk: '99', full_name: 'Alice A', profile_pic_url: 'https://x/pic.jpg', is_private: true, is_verified: true },
      preview_child_comments: [{ pk: '2', text: 'reply', created_at: t0 + 60, comment_like_count: 0, parent_comment_id: '1', user: { username: 'b' } }],
    }],
    has_more_comments: true, next_min_id: 'cursor',
  });
  assert.deepEqual(rest.comments.map((c) => [c.id, c.username, c.text, c.likes, c.parentId, c.publishedAt]),
    [['1', 'a', 'top', 3, null, new Date(t0 * 1000).toISOString()], ['2', 'b', 'reply', 0, '1', new Date((t0 + 60) * 1000).toISOString()]]);
  assert.equal(rest.hasMore, true);
  const stored = JSON.stringify(rest.comments[0].raw);
  for (const secret of ['Alice', 'pic.jpg', 'is_private', '"99"']) assert.equal(stored.includes(secret), false, secret);
  assert.equal(rest.comments[0].raw.is_verified, true);

  const gql = parseCommentsText('for (;;);' + JSON.stringify({ data: { xdt_comments: { edges: [
    { node: { id: '7', text: 'nested', created_at: t0, owner: { username: 'c' }, edge_liked_by: { count: 5 } } },
  ], page_info: { has_next_page: false } } } }));
  assert.deepEqual([gql.comments[0].id, gql.comments[0].likes, gql.hasMore], ['7', 5, false]);
  assert.deepEqual(parseCommentsText('not json'), { comments: [], hasMore: null });
  assert.equal(parseCommentsPayload({ node: { text: 'a status', user: { username: 'x' } } }).comments.length, 0, 'no engagement counters: not a comment');
});

test('mixed page JSON keeps comments from the requested post only', () => {
  const comment = (id) => ({ pk: id, text: id, user: { username: 'a' }, comment_like_count: 1 });
  const text = JSON.stringify({ data: { feed: [
    { code: 'Wanted001', pk: '123', comments: [comment('yes')] },
    { code: 'Other0001', pk: '456', comments: [comment('no')] },
  ] } });
  assert.deepEqual(parsePostCommentsText(text, 'Wanted001', '123').comments.map((c) => c.id), ['yes']);
  assert.deepEqual(parsePostCommentsText(text, 'Absent001', null).comments, []);
});

test('decide: every branch that ends a post, and the caps that end --limit all', () => {
  const s = { total: 10, limit: 100, rounds: 1, idleRounds: 0, hasMore: null, moreControl: true, elapsedMs: 0, aborted: false };
  const stop = (over) => { const d = decide({ ...s, ...over }, limits); return d.action === 'stop' ? [d.completion, d.reason] : 'continue'; };
  assert.equal(stop({}), 'continue');
  assert.deepEqual(stop({ total: 100 }), ['partial', 'limit_reached']);
  assert.deepEqual(stop({ total: 100, hasMore: false }), ['partial', 'limit_reached']);
  assert.deepEqual(stop({ hasMore: false }), ['complete', 'end_of_comments']);
  assert.deepEqual(stop({ idleRounds: 1, moreControl: false }), ['complete', 'end_of_comments']);
  assert.equal(stop({ idleRounds: 1, moreControl: false, hasMore: true }), 'continue', 'Instagram says more exists');
  assert.equal(stop({ idleRounds: 2 }), 'continue');
  assert.deepEqual(stop({ idleRounds: 3 }), ['partial', 'stalled']);
  assert.deepEqual(stop({ limit: null, rounds: 60 }), ['partial', 'max_rounds']);
  assert.deepEqual(stop({ limit: null, elapsedMs: 300_000 }), ['partial', 'time_limit']);
  assert.deepEqual(stop({ aborted: true }), ['partial', 'interrupted']);
  const end = { action: 'stop', completion: 'complete', reason: 'end_of_comments' };
  assert.deepEqual(finalOutcome(end, 0, 12), { completion: 'partial', reason: 'none_visible', interrupted: false });
  assert.deepEqual(finalOutcome(end, 0, null), { completion: 'partial', reason: 'none_visible', interrupted: false });
  assert.deepEqual(finalOutcome(end, 5, 12), { completion: 'partial', reason: 'count_mismatch', interrupted: false });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comments-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  migrate(db);
  const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
  const addPost = (code, extra = {}) => {
    const p = { extraction_status: 'complete', availability: 'available', comments_count: 500, comments_disabled: 0, caption: 'the caption', ...extra };
    return Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, availability, comments_count, comments_disabled, caption)
      VALUES (?, ?, 'u', 'image', ?, ?, ?, ?, ?)`).run(cid, code, p.extraction_status, p.availability, p.comments_count, p.comments_disabled, p.caption).lastInsertRowid);
  };
  return { dir, db, cid, addPost, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('saveComments deduplicates by id, upgrades id-less rows, and keeps reply links', () => {
  const { db, addPost, close } = fixture();
  try {
    const post = addPost('DedupePost1');
    const c = (id, text, extra = {}) => ({ id, parentId: null, username: 'u', text, likes: 1, publishedAt: '2024-01-01T00:00:00.000Z', raw: { id }, ...extra });
    assert.equal(saveComments(db, post, [c('1', 'a'), c('2', 'b'), c('1', 'a')]), 2, 'same id twice in one batch');
    assert.equal(saveComments(db, post, [c('1', 'a', { likes: 9 }), c('3', 'c', { parentId: '1' })]), 1, 'known id is refreshed, not inserted');
    const rows = db.prepare('SELECT instagram_comment_id id, likes_count l, parent_comment_id p FROM comments WHERE post_id = ? ORDER BY id').all(post);
    assert.deepEqual(rows.map((r) => [r.id, r.l, r.p]), [['1', 9, null], ['2', 1, null], ['3', 1, '1']]);

    assert.equal(saveComments(db, post, [c(null, 'page only'), c(null, 'page only')]), 1, 'id-less duplicates');
    assert.equal(saveComments(db, post, [c(null, 'page only', { publishedAt: '2024-02-01T00:00:00.000Z' })]), 1, 'other time = different comment');
    assert.equal(saveComments(db, post, [c(null, 'page only', { publishedAt: null })]), 0, 'no time but same user and text: already have it');
    assert.equal(saveComments(db, post, [c('9', 'page only')]), 0, 'JSON later supplies the id: same row upgraded');
    assert.equal(db.prepare("SELECT count(*) n FROM comments WHERE post_id = ? AND text = 'page only'").get(post).n, 2);
    assert.equal(db.prepare('SELECT comments_collected n FROM posts WHERE id = ?').get(post).n, 5);
  } finally { close(); }
});

test('selectCommentPosts: resumable states only, and only fully extracted posts', () => {
  const { db, cid, addPost, close } = fixture();
  try {
    const set = (id, sql) => db.prepare(`UPDATE posts SET ${sql} WHERE id = ?`).run(id);
    const pending = addPost('PendingPo01');
    const partial = addPost('PartialPo01'); set(partial, "comments_status = 'complete', comments_completion = 'partial', comments_collected = 100");
    const done = addPost('DonePost001'); set(done, "comments_status = 'complete', comments_completion = 'complete', comments_collected = 40");
    const flaky = addPost('FlakyPost01'); set(flaky, "comments_status = 'failed', comments_attempts = 2");
    const dead = addPost('DeadPost001'); set(dead, "comments_status = 'failed', comments_attempts = 5");
    addPost('NoMetaPost1', { extraction_status: 'pending' });
    addPost('GonePost001', { availability: 'unavailable' });
    const ids = (limit, force = false) => selectCommentPosts(db, cid, limit, force).map((p) => p.id);
    assert.deepEqual(ids(100), [pending, flaky]);
    assert.deepEqual(ids(101), [pending, partial, flaky], 'a higher limit reopens a partial post');
    assert.deepEqual(ids(null), [pending, partial, flaky]);
    assert.equal(ids(100, true).includes(done), true);
  } finally { close(); }
});

test('stalled partial threads stop retrying at the cap; limit partials reopen with a higher limit', () => {
  const { db, cid, addPost, close } = fixture();
  try {
    const stalled = addPost('Stalled001');
    const limited = addPost('Limited001');
    const post = (id) => ({ id });
    for (let i = 0; i < 5; i += 1) finishPost(db, post(stalled), 'partial', 'stalled');
    finishPost(db, post(limited), 'partial', 'limit_reached');
    const selected = selectCommentPosts(db, cid, null, false).map((row) => row.id);
    assert.equal(selected.includes(stalled), false);
    assert.equal(selected.includes(limited), true);
    assert.equal(db.prepare('SELECT comments_attempts FROM posts WHERE id = ?').get(stalled).comments_attempts, 5);
  } finally { close(); }
});

// ---- Real browser against a local stand-in for a post page -------------------------------------------------

const PAGE = 20;
function startSite(sites) {
  const hits = { page: {}, api: {} };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const page = url.pathname.match(/^\/p\/([^/]+)\/$/);
    const api = url.pathname.match(/^\/api\/v1\/media\/([^/]+)\/comments\/$/);
    const code = (page ?? api)?.[1];
    const site = sites[code];
    if (!site) { res.writeHead(404); return res.end(); }
    if (page) {
      hits.page[code] = (hits.page[code] ?? 0) + 1;
      if (site.kind === 'drop') return req.socket.destroy();
      res.writeHead(200, { 'content-type': 'text/html' });
      if (site.kind === 'dom') {
        return res.end(`<main><article><h1>the caption</h1><ul>
          <li><a href="/owner/">owner</a><span dir="auto">the caption</span><time datetime="2024-01-01T00:00:00.000Z"></time></li>
          <li><a href="/ann/">ann</a><span dir="auto">nice one</span><time datetime="2024-02-01T10:00:00.000Z"></time>
            <ul><li><a href="/bob/">bob</a><span dir="auto">a reply</span><time datetime="2024-02-01T11:00:00.000Z"></time></li></ul></li>
          <li><a href="/cat/">cat</a><span dir="auto">second</span><time datetime="2024-02-02T10:00:00.000Z"></time></li></ul></article></main>`);
      }
      return res.end(`<main><article><h1>the caption</h1><button aria-label="Load more comments" id="more">+</button>
        <button id="r">View replies (3)</button><script>
        let next = 0;
        async function load() { const r = await fetch('/api/v1/media/${code}/comments/?min_id=' + next); const j = await r.json();
          next += ${PAGE}; if (!j.has_more_comments) document.getElementById('more').remove(); }
        document.getElementById('more').onclick = load; load();
        document.getElementById('r').onclick = () => fetch('/api/v1/media/${code}/comments/?replies=1');
        </script></article></main>`);
    }
    hits.api[code] = (hits.api[code] ?? 0) + 1;
    if (url.searchParams.get('replies')) { hits.api[`${code}:replies`] = 1; return res.end('{}'); }
    if (site.kind === 'limited') { res.writeHead(429); return res.end('{}'); }
    const from = site.kind === 'stuck' ? 0 : Number(url.searchParams.get('min_id') ?? 0);
    const comments = [];
    for (let i = from; i < Math.min(from + PAGE, site.total); i += 1) {
      comments.push({ pk: String(1000 + i), text: `comment ${i}`, created_at: t0 + i, comment_like_count: i % 7, child_comment_count: 0, user: { username: `user${i % 13}` } });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ comments, has_more_comments: site.kind === 'stuck' || from + PAGE < site.total }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

test('collection in a real browser: limit, resume, all with safety caps, no-page cases, failures isolated', { timeout: 240_000 }, async () => {
  const { db, cid, addPost, close } = fixture();
  const other = Number(db.prepare("INSERT INTO competitors (username) VALUES ('other')").run().lastInsertRowid);
  const site = await startSite({
    Many0000001: { total: 250 }, Few00000001: { total: 7 }, Stuck000001: { kind: 'stuck', total: 1000 }, Dom00000001: { kind: 'dom' },
    Drop0000001: { kind: 'drop' }, Endless0001: { total: 1e9 }, Limited0001: { kind: 'limited' },
  });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const session = { inspect: async () => 'authenticated' };
  const sleep = async () => {};
  const run = (competitor, opts) => scrapeComments(db, context, session, competitor, { dataDir: '.', log: silent, sleep, limits, force: false, baseUrl: site.base, ...opts });
  const brand = { id: cid, username: 'brand' };
  const row = (code) => db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(code);
  const saved = (code) => db.prepare('SELECT count(*) n, count(DISTINCT instagram_comment_id) d FROM comments WHERE post_id = ?').get(row(code).id);
  try {
    addPost('Many0000001', { comments_count: 250 }); addPost('Few00000001', { comments_count: 7 }); addPost('Stuck000001');
    const dom = addPost('Dom00000001', { comments_count: 2 });
    const drop = addPost('Drop0000001'); addPost('Off00000001', { comments_disabled: 1 }); addPost('Zero0000001', { comments_count: 0 });

    const r1 = await run(brand, { limit: 100 });
    assert.deepEqual([r1.selected, r1.failed, r1.stoppedBy], [7, 1, null]);
    assert.deepEqual(saved('Many0000001'), { n: 100, d: 100 }, 'exactly the limit, no duplicates');
    assert.deepEqual([row('Many0000001').comments_status, row('Many0000001').comments_completion, row('Many0000001').comments_stop_reason, row('Many0000001').comments_collected], ['complete', 'partial', 'limit_reached', 100]);
    assert.ok(row('Many0000001').comments_last_collected_at);
    assert.deepEqual([row('Few00000001').comments_completion, row('Few00000001').comments_stop_reason, saved('Few00000001').n], ['complete', 'end_of_comments', 7]);
    assert.deepEqual([row('Stuck000001').comments_completion, row('Stuck000001').comments_stop_reason, saved('Stuck000001').n], ['partial', 'stalled', PAGE]);
    assert.equal(site.hits.api['Many0000001:replies'], undefined, 'reply expanders are never clicked');

    // DOM fallback: top-level only, caption skipped, replies not read as top-level comments.
    assert.deepEqual(db.prepare('SELECT username, text, instagram_comment_id id FROM comments WHERE post_id = ? ORDER BY id').all(dom), [
      { username: 'ann', text: 'nice one', id: null }, { username: 'cat', text: 'second', id: null }]);

    // Disabled / zero-comment posts: complete without loading a page.
    for (const code of ['Off00000001', 'Zero0000001']) { assert.deepEqual([row(code).comments_status, row(code).comments_completion, saved(code).n], ['complete', 'complete', 0]); assert.equal(site.hits.page[code], undefined); }
    assert.equal(row('Off00000001').comments_stop_reason, 'comments_disabled');

    // A failed comment run never fails the post.
    const failed = row('Drop0000001');
    assert.deepEqual([failed.comments_status, failed.comments_attempts, failed.extraction_status, failed.availability], ['failed', 1, 'complete', 'available']);
    assert.equal(db.prepare("SELECT count(*) n FROM scrape_errors WHERE post_id = ? AND stage = 'comments'").get(drop).n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM scrape_errors WHERE post_id = ? AND stage = 'extraction'").get(drop).n, 0);

    // Rerun with the same limit: complete and limit-satisfied posts are not visited again.
    const manyHits = site.hits.page.Many0000001;
    await run(brand, { limit: 100 });
    assert.equal(site.hits.page.Many0000001, manyHits);
    assert.equal(saved('Many0000001').n, 100);

    // A higher limit resumes: the first 100 stay, no duplicates, exactly 150.
    await run(brand, { limit: 150 });
    assert.deepEqual(saved('Many0000001'), { n: 150, d: 150 });
    assert.equal(saved('Stuck000001').n, PAGE, 'repeated data adds nothing');

    // --limit all still stops: an endless thread ends at maxRounds, a rate-limited one stops the batch.
    db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, availability, comments_count)
      VALUES (?, 'Endless0001', 'u', 'image', 'complete', 'available', 999999)`).run(other);
    const capped = await run({ id: other, username: 'other' }, { limit: null, limits: { ...limits, maxRounds: 4 } });
    assert.deepEqual([row('Endless0001').comments_completion, row('Endless0001').comments_stop_reason, capped.partial], ['partial', 'max_rounds', 1]);
    assert.ok(saved('Endless0001').n >= PAGE * 4 && saved('Endless0001').n <= PAGE * 6);

    addPost('Limited0001');
    const limited = await run(brand, { limit: 100 });
    assert.equal(limited.stoppedBy, 'rate_limited');
    assert.deepEqual([row('Limited0001').comments_status, row('Limited0001').comments_attempts], ['pending', 0]);
  } finally {
    await browser.close();
    site.server.close();
    close();
  }
});

test('live post-page comments block: deep media-id connection without shortcode or media id', () => {
  const node = (pk, username, text) => ({ user: { pk: '1', username }, pk, text, created_at: 1756159770, comment_like_count: 0, child_comment_count: 0, parent_comment_id: null });
  const result = { data: { xdt_api__v1__media__media_id__comments__connection: {
    edges: [{ node: node('18062837270618865', 'figoxhin._', 'Omg dessiz moroco') }, { node: node('17874337626404461', 'hiba_sayeh', '😍😍😍') }],
    page_info: { end_cursor: null, has_next_page: false },
  } } };
  // Same nesting depth as the page Instagram served (17 levels to each comment).
  const block = { require: [[0, 0, 0, [{ __bbox: { require: [[0, 0, [], [0, { __bbox: { complete: true, result } }]]] } }]]] };
  const page = parseCommentsText(JSON.stringify(block));
  assert.deepEqual(page.comments.map((c) => [c.id, c.username, c.text, c.parentId]),
    [['18062837270618865', 'figoxhin._', 'Omg dessiz moroco', null], ['17874337626404461', 'hiba_sayeh', '😍😍😍', null]]);
  assert.equal(page.hasMore, false);
});
