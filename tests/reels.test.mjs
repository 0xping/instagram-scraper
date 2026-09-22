import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeMp4 } from '../dist/media-files.js';
import { durationMismatch, processCompetitorReels, reelAccess } from '../dist/reels.js';
import { migrate, openDatabase } from '../dist/db.js';

const box = (type, ...parts) => { const body = Buffer.concat(parts); const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function mvhd(timescale, duration) { return box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80)); }
function tkhd(width, height) { return box('tkhd', Buffer.alloc(4), Buffer.alloc(72), u32(width * 65536), u32(height * 65536)); }
function trak(handler, w, h) { return box('trak', tkhd(w, h), box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler), Buffer.alloc(13)))); }
function mp4({ duration = 24_543, audio = true, withMvhd = true } = {}) {
  const moov = box('moov', ...(withMvhd ? [mvhd(1000, duration)] : []), trak('vide', 720, 1280), ...(audio ? [trak('soun', 0, 0)] : []));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), moov, box('mdat', Buffer.alloc(500, 9))]);
}
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

test('probeMp4 reads duration, frame size and tracks from the boxes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  try {
    const p = join(dir, 'v.mp4');
    writeFileSync(p, mp4());
    assert.deepEqual(probeMp4(p), { durationSeconds: 24.543, width: 720, height: 1280, hasVideo: true, hasAudio: true });
    writeFileSync(p, mp4({ audio: false }));
    assert.equal(probeMp4(p).hasAudio, false);
    writeFileSync(p, mp4({ withMvhd: false }));
    assert.throws(() => probeMp4(p), /mvhd/);
    writeFileSync(p, jpeg);
    assert.throws(() => probeMp4(p), /moov/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reelAccess decides from what Instagram served, without any request', () => {
  const reel = { id: 1, shortcode: 'R', extraction_status: 'complete', availability: 'available', reel_status: 'pending', duration_seconds: 10 };
  const future = Math.floor(Date.now() / 1000 + 86_400).toString(16);
  const video = { id: 1, source_url: `https://cdn.example/v.mp4?oe=${future}`, local_path: null, bytes: null, download_status: 'pending', download_attempts: 0, last_error: null };
  assert.deepEqual(reelAccess(reel, video), { ok: true });
  const denied = (r, v) => { const a = reelAccess(r, v); return [a.status, a.needs]; };
  assert.deepEqual(denied({ ...reel, availability: 'unavailable' }, video), ['unavailable', null]);
  assert.deepEqual(denied({ ...reel, availability: 'restricted' }, video), ['unavailable', null]);
  assert.deepEqual(denied({ ...reel, extraction_status: 'pending', availability: 'unknown' }, undefined), ['pending', 'metadata']);
  assert.deepEqual(denied(reel, undefined), ['unavailable', null]);
  assert.deepEqual(denied(reel, { ...video, source_url: null }), ['unavailable', null]);
  assert.deepEqual(denied(reel, { ...video, source_url: 'https://cdn.example/v.mp4?oe=5F000000' }), ['pending', 'fresh_link']);
  assert.deepEqual(denied(reel, { ...video, last_error: 'not_retrievable: HTTP 403' }), ['unavailable', null]);
  assert.deepEqual(denied(reel, { ...video, download_attempts: 5, last_error: 'timeout: x' }), ['failed', null]);
  assert.deepEqual(reelAccess(reel, { ...video, download_status: 'complete', source_url: 'https://cdn.example/v.mp4?oe=5F000000' }), { ok: true }, 'a saved file needs no live link');
});

test('durationMismatch tolerates rounding, flags real differences', () => {
  assert.equal(durationMismatch(24.543, 24.427), false);
  assert.equal(durationMismatch(8.5, 30), true);
  assert.equal(durationMismatch(60, null), false);
});

test('Reel lifecycle: pending -> processed, idempotent reruns, deletion, corrupt video, expiry', async () => {
  const hits = {};
  const bodies = { '/reel.mp4': mp4(), '/thumb.jpg': jpeg, '/bad.mp4': mp4({ withMvhd: false }) };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const body = bodies[path];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': path.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const future = Math.floor(Date.now() / 1000 + 86_400).toString(16);
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}?oe=${future}`;

  const dir = mkdtempSync(join(tmpdir(), 'reels-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  const options = { dataDir: dir, limit: null, sleep: async () => {}, log: { debug() {}, info() {}, warn() {}, error() {} } };
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const reel = (code, extra = {}) => {
      const r = { extraction_status: 'complete', availability: 'available', thumbnail_url: url('/thumb.jpg'), duration_seconds: 24.4, ...extra };
      return Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, availability, thumbnail_url, duration_seconds)
        VALUES (?, ?, ?, 'reel', ?, ?, ?, ?)`).run(cid, code, `https://www.instagram.com/reel/${code}/`, r.extraction_status, r.availability, r.thumbnail_url, r.duration_seconds).lastInsertRowid);
    };
    const video = (postId, src) => db.prepare("INSERT INTO media (post_id, position, media_type, source_url) VALUES (?, 0, 'video', ?)").run(postId, src);

    const good = reel('GoodReel01'); video(good, url('/reel.mp4'));
    const noMeta = reel('NoMetaYet1', { extraction_status: 'pending', availability: 'unknown' });
    reel('DeletedRe1', { extraction_status: 'failed', availability: 'unavailable' });
    const expired = reel('ExpiredRe1'); video(expired, 'http://127.0.0.1:1/reel.mp4?oe=5F000000');
    const corrupt = reel('CorruptRe1'); video(corrupt, url('/bad.mp4'));
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type) VALUES (?, 'ImagePost1', 'u', 'image')").run(cid);

    const status = () => Object.fromEntries(db.prepare("SELECT shortcode, reel_status FROM posts WHERE type = 'reel'").all().map((r) => [r.shortcode, r.reel_status]));
    const run1 = await processCompetitorReels(db, { id: cid, username: 'brand' }, options);
    assert.deepEqual(status(), { GoodReel01: 'processed', NoMetaYet1: 'pending', DeletedRe1: 'unavailable', ExpiredRe1: 'pending', CorruptRe1: 'failed' });
    assert.deepEqual([run1.needMetadata, run1.needFreshLink], [[noMeta], [expired]]);
    assert.equal(db.prepare('SELECT extraction_status FROM posts WHERE id = ?').get(corrupt).extraction_status, 'complete', 'video failure never touches metadata');

    const g = db.prepare('SELECT * FROM posts WHERE id = ?').get(good);
    assert.deepEqual([g.video_probe_duration, g.video_width, g.video_height, g.video_has_audio, g.reel_status_reason], [24.543, 720, 1280, 1, null]);
    assert.equal(g.thumbnail_path, 'competitors/brand/posts/GoodReel01/media/thumbnail.jpg');
    assert.equal(db.prepare('SELECT local_path FROM media WHERE post_id = ?').get(good).local_path, 'competitors/brand/posts/GoodReel01/media/001.mp4');
    assert.match(db.prepare('SELECT last_error FROM media WHERE post_id = ?').get(corrupt).last_error, /^corrupt_video: /);

    // Rerun: nothing processed is touched; the corrupt video is fetched again.
    const before = { ...hits };
    await processCompetitorReels(db, { id: cid, username: 'brand' }, options);
    assert.equal(hits['/reel.mp4'], before['/reel.mp4'], 'processed Reel: no request');
    assert.equal(hits['/thumb.jpg'], before['/thumb.jpg'], 'thumbnails kept');
    assert.ok(hits['/bad.mp4'] > before['/bad.mp4'], 'corrupt video re-downloaded');
    assert.equal(status().GoodReel01, 'processed');

    // Deleted on Instagram after download: metadata and the local copy are both kept.
    db.prepare("UPDATE posts SET availability = 'unavailable', reel_status = 'downloaded' WHERE id = ?").run(good);
    await processCompetitorReels(db, { id: cid, username: 'brand' }, options);
    const kept = db.prepare('SELECT reel_status, reel_status_reason FROM posts WHERE id = ?').get(good);
    assert.equal(kept.reel_status, 'processed');
    assert.match(kept.reel_status_reason, /deleted on Instagram; local copy kept/);

    // The file vanished: back through acquisition, not stuck as "processed".
    rmSync(join(dir, 'competitors/brand/posts/GoodReel01/media/001.mp4'));
    db.prepare("UPDATE posts SET availability = 'available' WHERE id = ?").run(good);
    const n = hits['/reel.mp4'];
    await processCompetitorReels(db, { id: cid, username: 'brand' }, options);
    assert.equal(hits['/reel.mp4'], n + 1);
    assert.equal(status().GoodReel01, 'processed');
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
