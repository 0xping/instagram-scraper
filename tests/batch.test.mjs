import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { competitorStatus, formatRetry, formatStatus, lastScrapeLabel, retryCandidates, retryCompetitor } from '../dist/batch.js';
import { recentlyCompleted, runPipeline } from '../dist/pipeline.js';
import { RateLimitedError } from '../dist/profile-scraper.js';
import { migrate, openDatabase } from '../dist/db.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const box = (type, ...parts) => { const body = Buffer.concat(parts); const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), box('moov', box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(1000), u32(4000), Buffer.alloc(80)),
  box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(13)))))]);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  migrate(db);
  const competitor = (name) => ({ id: Number(db.prepare('INSERT INTO competitors (username) VALUES (?)').run(name).lastInsertRowid), username: name });
  const post = (c, code, cols = {}) => {
    const keys = ['competitor_id', 'shortcode', 'url', ...Object.keys(cols)];
    return Number(db.prepare(`INSERT INTO posts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(c.id, code, 'u', ...Object.values(cols)).lastInsertRowid);
  };
  return { dir, db, competitor, post, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('status: one row per competitor, failures across stages, last-scrape labels', () => {
  const { db, competitor, post, close } = fixture();
  try {
    const a = competitor('alpha');
    competitor('beta');
    post(a, 'Done0000001', { extraction_status: 'complete', media_status: 'complete' });
    post(a, 'Bad00000001', { extraction_status: 'failed', availability: 'available' });
    post(a, 'Gone0000001', { extraction_status: 'failed', availability: 'unavailable' });
    post(a, 'Frame000001', { extraction_status: 'complete', type: 'reel', frames_status: 'failed' });
    db.prepare(`INSERT INTO scrape_jobs (competitor_id, job_type, status, started_at) VALUES (?, 'pipeline', 'running', '2026-09-21T10:00:00Z')`).run(a.id);
    const [alpha, beta] = competitorStatus(db);
    assert.deepEqual([alpha.discovered, alpha.metadata, alpha.media, alpha.failed], [4, 2, 1, 2], 'deleted post is not a failure');
    assert.equal(lastScrapeLabel(alpha), 'In progress');
    assert.equal(lastScrapeLabel(beta), 'never');
    assert.equal(lastScrapeLabel({ ...alpha, jobStatus: 'failed', jobError: 'interrupted', jobAt: '2026-09-21T11:00:00Z' }), '2026-09-21 (interrupted)');
    assert.equal(lastScrapeLabel({ ...alpha, jobStatus: 'complete', jobAt: '2026-09-21T11:00:00Z' }), '2026-09-21');
    assert.match(formatStatus([alpha, beta]), /^Competitor\s+Discovered\s+Metadata\s+Media\s+Failed\s+Last scrape\nalpha\s+4\s+2\s+1\s+2\s+In progress\n/);
  } finally { close(); }
});

test('retry:failed: retryable only by default, bounded by attempts, stage by stage, failures isolated', async () => {
  const { dir, db, competitor, post, close } = fixture();
  const fake = join(dir, 'ffmpeg.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '-version') { console.log('ffmpeg version fake'); process.exit(0); }
writeFileSync('frame_00001.jpg', 'jpg'); writeFileSync('frame_00002.jpg', 'jpg');
`);
  chmodSync(fake, 0o755);
  process.env.FFMPEG_PATH = fake;
  try {
    const c = competitor('brand');
    const reel = (code, cols) => {
      const id = post(c, code, { type: 'reel', extraction_status: 'complete', ...cols });
      const rel = `competitors/brand/posts/${code}/media/001.mp4`;
      mkdirSync(join(dir, `competitors/brand/posts/${code}/media`), { recursive: true });
      writeFileSync(join(dir, rel), mp4);
      db.prepare("INSERT INTO media (post_id, position, media_type, download_status, local_path) VALUES (?, 0, 'video', 'complete', ?)").run(id, rel);
      return id;
    };
    reel('Flaky000001', { frames_status: 'failed', frames_attempts: 1, frames_status_reason: 'ffmpeg failed: timeout' });
    reel('Corrupt0001', { frames_status: 'failed', frames_attempts: 1, frames_status_reason: 'unsupported_video: no moov box' });
    reel('GaveUp00001', { frames_status: 'failed', frames_attempts: 5, frames_status_reason: 'ffmpeg failed' });
    const meta = post(c, 'MetaFail001', { extraction_status: 'failed', availability: 'available', extraction_attempts: 2 });
    db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, stage, error_type, error_message, retryable) VALUES (?, ?, 'extraction', 'timeout', 'slow', 1)`).run(c.id, meta);
    const perm = post(c, 'MetaPerm001', { extraction_status: 'failed', availability: 'available', extraction_attempts: 1 });
    db.prepare(`INSERT INTO scrape_errors (competitor_id, post_id, stage, error_type, error_message, retryable) VALUES (?, ?, 'extraction', 'unexpected', 'parser', 0)`).run(c.id, perm);

    const frames = retryCandidates(db, c.id, 'frames');
    assert.deepEqual([frames.eligible.map((x) => [x.shortcode, x.retryable]), frames.exhausted], [[['Flaky000001', 1], ['Corrupt0001', 0]], 1]);

    const options = { config: { dataDir: dir, comments: {} }, log, includePermanent: false, dryRun: false };
    const dry = await retryCompetitor(db, null, c, ['frames'], { ...options, dryRun: true });
    assert.equal(dry.rows[0].retried, 0, 'dry run changes nothing');

    const { rows } = await retryCompetitor(db, null, c, ['metadata', 'frames'], options);
    const [m, f] = rows;
    assert.deepEqual([m.retryable, m.permanent, m.retried, m.note], [1, 1, 0, 'needs the browser'], 'browser stage without a browser is reported, not crashed');
    assert.deepEqual([f.retryable, f.permanent, f.exhausted, f.retried, f.fixed], [1, 1, 1, 1, 1]);
    const status = (code) => db.prepare('SELECT frames_status s, frames_attempts a FROM posts WHERE shortcode = ?').get(code);
    assert.deepEqual(status('Flaky000001'), { s: 'complete', a: 0 });
    assert.deepEqual(status('Corrupt0001'), { s: 'failed', a: 1 }, 'permanent failure left alone');
    assert.deepEqual(status('GaveUp00001'), { s: 'failed', a: 5 }, 'over the cap: never retried');

    const forced = await retryCompetitor(db, null, c, ['frames'], { ...options, includePermanent: true });
    assert.deepEqual([forced.rows[0].retried, forced.rows[0].fixed], [1, 1], '--include-permanent retries it, still under the cap');
    assert.match(formatRetry([...rows, ...forced.rows], false), /frames\s+1\s+1\s+1\s+1\s+1/);
    assert.equal(formatRetry([], false), 'Nothing to retry.');
  } finally {
    delete process.env.FFMPEG_PATH;
    close();
  }
});

test('scrape:all helpers: a block carries to the next competitor; recently completed competitors are skipped', async () => {
  const { db, competitor, close } = fixture();
  try {
    const a = competitor('alpha');
    const b = competitor('beta');
    const calls = [];
    const stages = (who, fail) => [
      { name: 'profile', browser: true, run: async () => { calls.push(`${who}:profile`); if (fail) throw new RateLimitedError('slow down'); return { status: 'ok' }; } },
      { name: 'frames', browser: false, run: async () => { calls.push(`${who}:frames`); return { status: 'ok' }; } },
    ];
    const r1 = await runPipeline(db, a, stages('a', true), { force: false, log });
    assert.match(r1.browserBlocked, /slow down/);
    const r2 = await runPipeline(db, b, stages('b', false), { force: false, log, browserBlocked: r1.browserBlocked });
    assert.deepEqual(calls, ['a:profile', 'a:frames', 'b:frames'], 'beta: only local stages');
    assert.equal(r2.stages.profile.status, 'blocked');

    assert.equal(recentlyCompleted(db, b.id, 24), false, 'blocked is not complete');
    const r3 = await runPipeline(db, b, stages('b', false), { force: false, log });
    assert.deepEqual([r3.jobId, r3.status], [r2.jobId, 'complete'], 'resumed and finished');
    assert.equal(recentlyCompleted(db, b.id, 24), true);
    assert.equal(recentlyCompleted(db, b.id, 0), false, '0 disables skipping');
  } finally { close(); }
});
