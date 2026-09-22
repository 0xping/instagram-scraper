import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { effectiveInterval, ffmpegBin, frameTimestamp, processCompetitorFrames } from '../dist/frames.js';
import { migrate, openDatabase } from '../dist/db.js';

const box = (type, ...parts) => { const body = Buffer.concat(parts); const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const trak = box('trak', box('tkhd', Buffer.alloc(4), Buffer.alloc(72), u32(720 * 65536), u32(1280 * 65536)), box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(13))));
const mp4 = (seconds) => Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), box('moov', box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(1000), u32(seconds * 1000), Buffer.alloc(80)), trak), box('mdat', Buffer.alloc(50, 9))]);

test('effectiveInterval widens only when maxFrames would be exceeded', () => {
  assert.equal(effectiveInterval(60, 2, null), 2);
  assert.equal(effectiveInterval(60, 2, 100), 2);
  assert.equal(effectiveInterval(600, 2, 100), 6);
  assert.equal(frameTimestamp(3, 2), 6);
  assert.equal(frameTimestamp(1, 0.333), 0.333);
});

test('real FFmpeg extracts a frame from a Reel shorter than the frame interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'short-reel-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const pid = Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type) VALUES (?, 'ShortReel01', 'u', 'reel')").run(cid).lastInsertRowid);
    const rel = 'competitors/brand/posts/ShortReel01/media/001.mp4';
    mkdirSync(join(dir, 'competitors/brand/posts/ShortReel01/media'), { recursive: true });
    execFileSync(ffmpegBin(), ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=25:d=0.4', join(dir, rel)], { timeout: 10_000 });
    db.prepare("INSERT INTO media (post_id, position, media_type, download_status, local_path) VALUES (?, 0, 'video', 'complete', ?)").run(pid, rel);
    const result = await processCompetitorFrames(db, { id: cid, username: 'brand' }, {
      dataDir: dir, log: { debug() {}, info() {}, warn() {}, error() {} },
      limit: null, interval: 2, maxFrames: null, force: false,
    });
    assert.equal(result.counts.complete, 1);
    assert.deepEqual(db.prepare('SELECT timestamp_seconds FROM reel_frames').all(), [{ timestamp_seconds: 0 }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('frame extraction: records timestamps, no duplicates, skips done, --force replaces, cleans up failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  // Fake ffmpeg: honours -version, fps=1/N and -frames:v; writes 5 frames, or exits 1 for "bad" videos.
  const fake = join(dir, 'fake-ffmpeg.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '-version') { console.log('ffmpeg version fake'); process.exit(0); }
if (a[a.indexOf('-i') + 1].includes('BadReel01') || process.env.FAKE_FFMPEG_FAIL === '1') { writeFileSync('frame_00001.jpg', 'x'); console.error('Invalid data found when processing input'); process.exit(1); }
const n = a.includes('-frames:v') ? Number(a[a.indexOf('-frames:v') + 1]) : 5;
for (let i = 1; i <= n; i++) writeFileSync('frame_' + String(i).padStart(5, '0') + '.jpg', 'jpg');
`);
  chmodSync(fake, 0o755);
  process.env.FFMPEG_PATH = fake;

  const db = openDatabase(join(dir, 'collector.sqlite'));
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const opts = { dataDir: dir, log, limit: null, interval: 2, maxFrames: null, force: false };
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const addReel = (code, seconds, withVideo = true) => {
      const id = Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type) VALUES (?, ?, 'u', 'reel')").run(cid, code).lastInsertRowid);
      if (withVideo) {
        const rel = `competitors/brand/posts/${code}/media/001.mp4`;
        mkdirSync(join(dir, `competitors/brand/posts/${code}/media`), { recursive: true });
        writeFileSync(join(dir, rel), seconds ? mp4(seconds) : Buffer.from('not a video'));
        db.prepare("INSERT INTO media (post_id, position, media_type, download_status, local_path) VALUES (?, 0, 'video', 'complete', ?)").run(id, rel);
      }
      return id;
    };
    const good = addReel('GoodReel01', 10);
    addReel('BadReel01', 10);
    addReel('Garbage001', 0);
    addReel('NoVideo001', 0, false);
    const unavailable = addReel('GoneReel01', 0, false);
    db.prepare("UPDATE posts SET reel_status = 'unavailable' WHERE id = ?").run(unavailable);
    const brand = { id: cid, username: 'brand' };
    const framesDir = join(dir, 'competitors/brand/posts/GoodReel01/frames');

    const r1 = await processCompetitorFrames(db, brand, opts);
    assert.deepEqual(r1.counts, { complete: 1, skipped: 0, failed: 2, no_video: 1 });
    const rows = db.prepare('SELECT timestamp_seconds t, image_path p FROM reel_frames WHERE post_id = ? ORDER BY t').all(good);
    assert.deepEqual(rows.map((r) => r.t), [0, 2, 4, 6, 8]);
    assert.match(rows[1].p, /^competitors\/brand\/posts\/GoodReel01\/frames\/[^/]+\/frame_00002\.jpg$/);
    assert.equal(readdirSync(framesDir).length, 1);
    assert.equal(readdirSync(join(framesDir, readdirSync(framesDir)[0])).length, 5);
    assert.equal(db.prepare("SELECT count(*) c FROM reel_frames WHERE post_id != ?").get(good).c, 0, 'failed Reels record no frames');
    const st = (code) => db.prepare('SELECT frames_status s, frames_status_reason r FROM posts WHERE shortcode = ?').get(code);
    assert.match(st('BadReel01').r, /Invalid data/);
    assert.match(st('Garbage001').r, /^unsupported_video/);
    assert.equal(existsSync(join(dir, 'competitors/brand/posts/BadReel01/frames')), false, 'no frames dir left by a failure');
    assert.equal(existsSync(join(dir, 'competitors/brand/posts/BadReel01/frames.partial')), false, 'no partial dir left');

    // Rerun: completed Reel untouched, failed ones retried, still no duplicates.
    const r2 = await processCompetitorFrames(db, brand, opts);
    assert.deepEqual(r2.counts, { complete: 0, skipped: 1, failed: 2, no_video: 1 });
    assert.equal(db.prepare('SELECT count(*) c FROM reel_frames').get().c, 5);

    process.env.FAKE_FFMPEG_FAIL = '1';
    await processCompetitorFrames(db, brand, { ...opts, force: true });
    delete process.env.FAKE_FFMPEG_FAIL;
    assert.deepEqual(db.prepare('SELECT image_path p FROM reel_frames WHERE post_id = ? ORDER BY id').all(good).map((r) => r.p), rows.map((r) => r.p));
    assert.equal(db.prepare('SELECT frames_status FROM posts WHERE id = ?').get(good).frames_status, 'complete');
    assert.equal(readdirSync(framesDir).length, 1, 'failed replacement preserves the prior generation');

    // --force with another interval + cap replaces the rows.
    await processCompetitorFrames(db, brand, { ...opts, force: true, interval: 5, maxFrames: 2 });
    assert.deepEqual(db.prepare('SELECT timestamp_seconds t FROM reel_frames WHERE post_id = ? ORDER BY t').all(good).map((r) => r.t), [0, 5]);
    assert.equal(readdirSync(framesDir).length, 1);
    assert.equal(readdirSync(join(framesDir, readdirSync(framesDir)[0])).length, 2);

    // Frames deleted from disk: not treated as done.
    rmSync(framesDir, { recursive: true });
    assert.equal((await processCompetitorFrames(db, brand, opts)).counts.complete, 1);
  } finally {
    delete process.env.FAKE_FFMPEG_FAIL;
    delete process.env.FFMPEG_PATH;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
