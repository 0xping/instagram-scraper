import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkMediaFile, isExpired, itemStem, postDir, urlExpiry } from '../dist/media-files.js';
import { processCompetitorMedia } from '../dist/media.js';
import { migrate, openDatabase } from '../dist/db.js';

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const box = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), box('moov', Buffer.alloc(40, 1)), box('mdat', Buffer.alloc(300, 2))]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 3), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82])]);
const webpBody = Buffer.concat([Buffer.from('WEBP'), Buffer.alloc(100, 4)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([webpBody.length, 0, 0, 0]), webpBody]);

function withFile(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'media-check-'));
  try { const p = join(dir, 'f'); writeFileSync(p, bytes); return fn(p); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('checkMediaFile recognizes complete files and catches truncation', () => {
  for (const [bytes, format] of [[jpeg, 'jpg'], [mp4, 'mp4'], [png, 'png'], [webp, 'webp']]) {
    assert.deepEqual(withFile(bytes, checkMediaFile), { ok: true, format, bytes: bytes.length, reason: null }, format);
  }
  assert.match(withFile(jpeg.subarray(0, 150), checkMediaFile).reason, /truncated/);
  assert.match(withFile(mp4.subarray(0, mp4.length - 20), checkMediaFile).reason, /truncated/);
  assert.match(withFile(Buffer.concat([mp4.subarray(0, 64), box('mdat', Buffer.alloc(300))]), checkMediaFile).reason, /moov|truncated|invalid/);
  assert.match(withFile(webp.subarray(0, 90), checkMediaFile).reason, /mismatch/);
  assert.match(withFile(Buffer.from('<!DOCTYPE html><html><body>' + 'x'.repeat(100)), checkMediaFile).reason, /web page/);
  assert.match(withFile(Buffer.alloc(10), checkMediaFile).reason, /too small/);
});

test('paths: validated names only, never escaping the data dir', () => {
  assert.equal(postDir('/data', 'wear212club', 'DNyT2xh2IOA'), '/data/competitors/wear212club/posts/DNyT2xh2IOA');
  for (const [user, code] of [['..', 'DNyT2xh2IOA'], ['.', 'DNyT2xh2IOA'], ['a/b', 'DNyT2xh2IOA'], ['brand', '../x1'], ['brand', 'a b c d e'], ['brand', 'My summer caption!']]) {
    assert.throws(() => postDir('/data', user, code), /Unsafe/, `${user} ${code}`);
  }
  assert.deepEqual([itemStem(0), itemStem(9), itemStem(119)], ['001', '010', '120']);
});

test('signed URL expiry comes from oe (hex Unix seconds)', () => {
  const url = (t) => `https://scontent.cdninstagram.com/v/x.jpg?_nc_ht=x&oe=${Math.floor(t / 1000).toString(16).toUpperCase()}`;
  const now = new Date('2026-09-21T00:00:00Z');
  assert.equal(urlExpiry(url(now.getTime())).toISOString(), now.toISOString());
  assert.equal(isExpired(url(now.getTime() - 1000), now), true);
  assert.equal(isExpired(url(now.getTime() + 3_600_000), now), false);
  assert.equal(isExpired('https://example.com/no-signature.jpg', now), false);
  assert.equal(urlExpiry('not a url'), null);
});

test('downloads: verified, atomic, resumable, never re-downloaded, failures recorded', async () => {
  const hits = {};
  const future = Math.floor(Date.now() / 1000 + 86_400).toString(16);
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const send = (type, body, extra = {}) => { res.writeHead(200, { 'content-type': type, 'content-length': body.length, ...extra }); res.end(body); };
    if (path === '/good.jpg') return send('image/jpeg', jpeg);
    if (path === '/clip.mp4') return send('video/mp4', mp4);
    if (path === '/thumb.jpg') return send('image/jpeg', jpeg);
    if (path === '/truncated.jpg') return send('image/jpeg', jpeg.subarray(0, 150));
    if (path === '/drops.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': 5000 }); res.write(jpeg); return res.destroy(); }
    if (path === '/login.jpg') return send('text/html', Buffer.from('<html>log in</html>'));
    if (path === '/expired-by-cdn.jpg') { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('URL signature expired'); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = (p) => `${base}${p}?oe=${future}`;

  const dir = mkdtempSync(join(tmpdir(), 'media-run-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const options = { dataDir: dir, log, limit: null, sleep: async () => {} };
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const post = (code, type, caption, thumb = null) => Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, caption, extraction_status, thumbnail_url, raw_json)
      VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`).run(cid, code, `https://www.instagram.com/p/${code}/`, type, caption, thumb, JSON.stringify({ code, untouched: true })).lastInsertRowid);
    const media = (postId, position, type, url) => db.prepare('INSERT INTO media (post_id, position, media_type, source_url, width, height) VALUES (?, ?, ?, ?, 1080, 1350)').run(postId, position, type, url);

    const carousel = post('Carousel01', 'carousel', 'Été 🌞 مرحبا 東京 #drop\nline two');
    media(carousel, 0, 'image', u('/good.jpg'));
    media(carousel, 1, 'video', u('/clip.mp4'));
    media(carousel, 2, 'image', u('/truncated.jpg'));
    media(carousel, 3, 'image', u('/drops.jpg'));
    media(carousel, 4, 'image', u('/login.jpg'));
    media(carousel, 5, 'image', u('/missing.jpg'));
    media(carousel, 6, 'image', `${base}/good.jpg?oe=5F000000`); // expired in 2020: never requested
    media(carousel, 7, 'image', u('/expired-by-cdn.jpg'));
    const reel = post('ReelPost01', 'reel', null, u('/thumb.jpg'));
    media(reel, 0, 'video', u('/clip.mp4'));
    db.prepare("UPDATE posts SET extraction_status = 'pending' WHERE shortcode = 'ReelPost01'").run();
    const skipped = post('NotExtract', 'image', 'x');
    db.prepare("UPDATE posts SET extraction_status = 'pending' WHERE id = ?").run(skipped);
    db.prepare("UPDATE posts SET extraction_status = 'complete' WHERE id = ?").run(reel);

    const first = await processCompetitorMedia(db, { id: cid, username: 'brand' }, options);
    assert.equal(first.posts, 2, 'only extracted posts');
    assert.equal(first.saved, 3);
    assert.equal(first.failed, 6);
    assert.deepEqual(first.expiredPostIds, [carousel]);

    const postDirPath = join(dir, 'competitors', 'brand', 'posts', 'Carousel01');
    assert.deepEqual(readdirSync(join(postDirPath, 'media')).sort(), ['001.jpg', '002.mp4'], 'only verified files, no .part leftovers');
    assert.deepEqual(readFileSync(join(postDirPath, 'media', '001.jpg')), jpeg);
    assert.equal(readFileSync(join(postDirPath, 'caption.txt'), 'utf8'), 'Été 🌞 مرحبا 東京 #drop\nline two');
    const meta = JSON.parse(readFileSync(join(postDirPath, 'metadata.json'), 'utf8'));
    assert.equal(meta.shortcode, 'Carousel01');
    assert.deepEqual(meta.raw, { code: 'Carousel01', untouched: true });
    assert.deepEqual(meta.media.map((m) => [m.position, m.file, m.download_status]).slice(0, 3),
      [[1, 'media/001.jpg', 'complete'], [2, 'media/002.mp4', 'complete'], [3, null, 'failed']]);
    assert.equal(existsSync(join(dir, 'competitors', 'brand', 'posts', 'ReelPost01', 'media', 'thumbnail.jpg')), true);
    assert.equal(db.prepare("SELECT thumbnail_path FROM posts WHERE id = ?").get(reel).thumbnail_path, 'competitors/brand/posts/ReelPost01/media/thumbnail.jpg');

    const rows = Object.fromEntries(db.prepare('SELECT position, download_status, last_error, download_attempts, bytes, sha256, file_format, local_path FROM media WHERE post_id = ?').all(carousel).map((r) => [r.position, r]));
    assert.equal(rows[0].bytes, jpeg.length);
    assert.match(rows[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(rows[1].file_format, 'mp4');
    const errorType = (p) => rows[p].last_error.split(':')[0];
    assert.deepEqual([2, 3, 4, 5, 6, 7].map(errorType), ['corrupt_download', 'network', 'not_media', 'not_retrievable', 'url_expired', 'url_expired']);
    assert.equal(hits['/truncated.jpg'], 3, 'corrupt downloads are retried within the run');
    assert.equal(hits['/missing.jpg'], 1, '404 is not retried within the run');
    assert.equal(hits['/expired-by-cdn.jpg'], 1, 'an expired signature is not retried');
    assert.equal(rows[6].download_attempts, 0, 'expiry does not count against the item');
    assert.equal(rows[5].download_attempts, 1);

    const statuses = Object.fromEntries(db.prepare('SELECT shortcode, extraction_status, media_status FROM posts').all().map((r) => [r.shortcode, [r.extraction_status, r.media_status]]));
    assert.deepEqual(statuses.Carousel01, ['complete', 'failed'], 'media failure leaves extraction alone');
    assert.deepEqual(statuses.ReelPost01, ['complete', 'complete']);
    assert.ok(db.prepare("SELECT count(*) AS n FROM scrape_errors WHERE stage = 'media'").get().n >= 6);

    // Second run: valid files are kept without a request or a rewrite.
    const mtime = statSync(join(postDirPath, 'media', '001.jpg')).mtimeMs;
    const metaMtime = statSync(join(postDirPath, 'metadata.json')).mtimeMs;
    const goodHits = hits['/good.jpg'];
    await processCompetitorMedia(db, { id: cid, username: 'brand' }, options);
    assert.equal(hits['/good.jpg'], goodHits, 'no re-download');
    assert.equal(statSync(join(postDirPath, 'media', '001.jpg')).mtimeMs, mtime, 'file not rewritten');
    assert.equal(statSync(join(postDirPath, 'metadata.json')).mtimeMs >= metaMtime, true);

    // A valid file on disk that the DB does not know about is adopted; a corrupt one is moved aside.
    db.prepare("UPDATE media SET download_status = 'pending', local_path = NULL, bytes = NULL WHERE post_id = ? AND position = 0").run(carousel);
    writeFileSync(join(postDirPath, 'media', '003.jpg'), jpeg.subarray(0, 120));
    writeFileSync(join(postDirPath, 'media', '.003.999.part'), 'crash leftover');
    await processCompetitorMedia(db, { id: cid, username: 'brand' }, options);
    assert.equal(hits['/good.jpg'], goodHits, 'adopted, not downloaded');
    assert.equal(db.prepare('SELECT download_status FROM media WHERE post_id = ? AND position = 0').get(carousel).download_status, 'complete');
    const names = readdirSync(join(postDirPath, 'media'));
    assert.ok(names.some((n) => /^003\.jpg\.corrupt-\d+$/.test(n)), 'invalid file preserved aside');
    assert.ok(!names.some((n) => n.endsWith('.part')), 'crash leftovers removed');
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-insensitive filesystem collision is refused, not merged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-case-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url, extraction_status) VALUES (?, 'AbCdE1', 'u', 'complete')").run(cid);
    const folder = join(dir, 'competitors', 'brand', 'posts', 'AbCdE1');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'metadata.json'), JSON.stringify({ shortcode: 'abcde1' }));
    const logged = [];
    const summary = await processCompetitorMedia(db, { id: cid, username: 'brand' }, { dataDir: dir, limit: null, sleep: async () => {}, log: { debug() {}, info() {}, warn() {}, error: (m) => logged.push(m) } });
    assert.equal(summary.failed, 1);
    assert.match(logged[0], /case-insensitive/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted media post remains resumable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-interrupt-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  const controller = new globalThis.AbortController();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  let calls = 0;
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const pid = Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status) VALUES (?, 'Interrupt1', 'u', 'carousel', 'complete')").run(cid).lastInsertRowid);
    for (let i = 0; i < 2; i += 1) db.prepare("INSERT INTO media (post_id, position, media_type, source_url) VALUES (?, ?, 'image', ?)")
      .run(pid, i, `https://scontent.cdninstagram.com/${i}.jpg`);
    const fetch = async () => { calls += 1; return new globalThis.Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } }); };
    let pauses = 0;
    const sleep = async () => { if (++pauses === 2) controller.abort(); };
    const first = await processCompetitorMedia(db, { id: cid, username: 'brand' }, { dataDir: dir, log, limit: null, fetch, sleep, signal: controller.signal });
    assert.equal(first.stoppedBy, 'interrupted');
    assert.equal(db.prepare('SELECT media_status FROM posts WHERE id = ?').get(pid).media_status, 'in_progress');
    assert.equal(db.prepare("SELECT count(*) n FROM media WHERE post_id = ? AND download_status = 'complete'").get(pid).n, 1);
    const second = await processCompetitorMedia(db, { id: cid, username: 'brand' }, { dataDir: dir, log, limit: null, fetch, sleep: async () => {} });
    assert.equal(second.complete, 1);
    assert.equal(calls, 2, 'the verified first item is kept');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
