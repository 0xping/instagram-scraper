import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectorStages, formatPipelineSummary, pipelineTotals, runPipeline } from '../dist/pipeline.js';
import { RateLimitedError } from '../dist/profile-scraper.js';
import { migrate, openDatabase } from '../dist/db.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('runPipeline: tracks every stage, isolates failures, resumes the same job, blocks only browser stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const brand = { id: cid, username: 'brand' };
    const calls = {};
    let behaviour = {};
    const stage = (name, browser = false) => ({
      name, browser, run: async () => {
        calls[name] = (calls[name] ?? 0) + 1;
        const b = behaviour[name];
        if (b instanceof Error) throw b;
        if (typeof b === 'function') return b();
        return { status: 'ok', counts: { failed: 0 } };
      },
    });
    const stages = [stage('session', true), stage('profile', true), stage('discovery', true), stage('media'), stage('frames'), stage('comments', true)];
    const job = (id) => db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(id);

    // 1. A later non-critical stage fails: earlier work stays recorded, the next stages still run.
    behaviour = { frames: new Error('ffmpeg exploded') };
    const r1 = await runPipeline(db, brand, stages, { force: false, log });
    assert.equal(r1.status, 'failed');
    assert.deepEqual(Object.fromEntries(Object.entries(r1.stages).map(([k, v]) => [k, v.status])),
      { session: 'ok', profile: 'ok', discovery: 'ok', media: 'ok', frames: 'failed', comments: 'ok' });
    assert.match(r1.stages.frames.detail, /ffmpeg exploded/);
    const saved = JSON.parse(job(r1.jobId).stages_json);
    assert.equal(saved.frames.status, 'failed', 'progress persisted in scrape_jobs');
    assert.equal(job(r1.jobId).status, 'failed');

    // 2. Rerun: same job, finished stages skipped (session always rechecked), the failed one retried, and the
    //    stages after it run again because the retry can give them new work.
    behaviour = {};
    const r2 = await runPipeline(db, brand, stages, { force: false, log });
    assert.deepEqual([r2.jobId, r2.resumed, r2.status], [r1.jobId, true, 'complete']);
    assert.deepEqual(calls, { session: 2, profile: 1, discovery: 1, media: 1, frames: 2, comments: 2 });
    assert.equal(job(r2.jobId).status, 'complete');

    // 3. A complete job is not resumed; a rate limit blocks later browser stages but not local ones.
    behaviour = { profile: new RateLimitedError('slow down') };
    const r3 = await runPipeline(db, brand, stages, { force: false, log });
    assert.notEqual(r3.jobId, r1.jobId);
    assert.deepEqual([r3.stages.profile.status, r3.stages.discovery.status, r3.stages.media.status, r3.stages.comments.status], ['blocked', 'blocked', 'ok', 'blocked']);
    assert.match(r3.stages.discovery.detail, /^not run: /);
    assert.equal(calls.discovery, 1, 'blocked browser stage is not run');
    assert.equal(calls.media, 2, 'local stage still runs');
    assert.equal(r3.status, 'blocked');

    // 4. Ctrl-C mid-stage: that stage is interrupted, nothing after it runs, and the rerun resumes there.
    behaviour = {};
    const abort = new globalThis.AbortController();
    behaviour.discovery = () => { abort.abort(); return { status: 'ok' }; };
    const r4 = await runPipeline(db, brand, stages, { force: false, log, signal: abort.signal });
    assert.deepEqual([r4.jobId, r4.status, r4.stages.discovery.status, r4.stages.profile.status], [r3.jobId, 'interrupted', 'interrupted', 'ok']);
    assert.equal(calls.comments, 2, 'stopped before comments');
    behaviour = {};
    const r5 = await runPipeline(db, brand, stages, { force: false, log });
    assert.deepEqual([r5.jobId, r5.status], [r3.jobId, 'complete']);
    assert.equal(calls.profile, 3, 'profile finished in the interrupted run, not repeated');

    // 5. --force always starts a new job and runs everything.
    const r6 = await runPipeline(db, brand, stages, { force: true, log });
    assert.equal(r6.resumed, false);
    assert.equal(calls.profile, 4);

    // 6. Summary: skipped stages say so; totals come from the dataset.
    db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, media_status) VALUES (?, 'ImagePost01', 'u', 'image', 'complete', 'complete')").run(cid);
    const reel = Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, frames_status) VALUES (?, 'ReelPost001', 'u', 'reel', 'complete', 'complete')").run(cid).lastInsertRowid);
    db.prepare("INSERT INTO comments (post_id, username, text, published_at) VALUES (?, 'a', 'hi', '2024-01-01T00:00:00Z')").run(reel);
    const totals = pipelineTotals(db, cid);
    assert.deepEqual(totals, { posts: 2, reels: 1, mediaPosts: 1, mediaComplete: 1, frames: 1, transcripts: 0, comments: 1 });
    const text = formatPipelineSummary('brand', {
      jobId: 9, resumed: false, status: 'failed', stages: {
        profile: { status: 'ok', detail: null, counts: {}, at: '' },
        metadata: { status: 'partial', detail: null, counts: { selected: 3, extracted: 2, failed: 1, previously: 5 }, at: '' },
        frames: { status: 'ok', detail: null, counts: { failed: 0 }, at: '' },
        transcripts: { status: 'skipped', detail: '--skip-transcripts', counts: {}, at: '' },
      },
    }, totals);
    assert.match(text, /^Profile\s+✅$/m);
    assert.match(text, /^Previously processed\s+5$/m);
    assert.match(text, /^Metadata\s+2\/3$/m);
    assert.match(text, /^Frames\s+1\/1$/m);
    assert.match(text, /^Transcripts\s+skipped \(--skip-transcripts\)$/m);
    assert.match(text, /^Errors\s+1$/m);
    assert.match(text, /metadata: partial/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capped metadata and comment failures remain partial pipeline stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-capped-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, extraction_status, availability, extraction_attempts)
      VALUES (?, 'FailedMeta1', 'u', 'failed', 'available', 5)`).run(cid);
    const commentPost = Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, extraction_status, availability, comments_status, comments_attempts)
      VALUES (?, 'FailedComm1', 'u', 'complete', 'available', 'failed', 5)`).run(cid).lastInsertRowid);
    const stages = collectorStages({ db, context: {}, session: {}, competitor: { id: cid, username: 'brand' },
      config: { dataDir: dir }, log, signal: new globalThis.AbortController().signal,
      flags: { force: false, skipMedia: false, skipFrames: false, skipTranscripts: false, skipComments: false, commentLimit: 100 } });
    const run = (name) => stages.find((stage) => stage.name === name).run({ browserBlocked: null });
    assert.deepEqual([(await run('metadata')).status, (await run('comments')).status], ['partial', 'partial']);
    db.prepare("UPDATE posts SET availability = 'unavailable' WHERE id = ?").run(commentPost);
    assert.equal((await run('comments')).status, 'ok', 'unavailable posts do not hold the stage open');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
