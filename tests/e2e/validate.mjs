/* global process, console, URL, setTimeout, clearTimeout */
// End-to-end validation of the collector: runs the real CLI against a local fake Instagram (see fake-instagram.mjs)
// on a small fixture competitor, interrupts it (Ctrl-C and a hard kill), reruns it, refreshes it, retries failures
// and exports it, checking SQLite and the files on disk after every step. Prints PASS/FAIL per subsystem.
//
//   npm run validate:e2e            (uses the FFmpeg npm install downloads, or FFMPEG_PATH)
//   E2E_KEEP=1 npm run validate:e2e keeps the workspace for inspection

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ffmpegBin } from '../../dist/frames.js';
import { createState, hitCount, startFakeInstagram } from './fake-instagram.mjs';

const USER = 'e2e_brand';
const ffmpeg = ffmpegBin();
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); } catch {
  console.error(`FFmpeg not found (tried "${ffmpeg}"). Run npm install or set FFMPEG_PATH; the frame and transcript checks need it.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'ig-e2e-'));
const dataDir = join(work, 'data');
const fixtures = join(work, 'fixtures');
mkdirSync(fixtures);

// ---- Fixtures --------------------------------------------------------------------------------------

const ff = (...args) => execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: fixtures });
const files = {};
for (const [name, color] of [['img1.jpg', 'red'], ['img2.jpg', 'green'], ['img3.jpg', 'blue'], ['img4.jpg', 'yellow'], ['car1.jpg', 'purple'], ['car2.jpg', 'orange'], ['avatar.jpg', 'white'], ['fallback.jpg', 'gray']]) {
  ff('-f', 'lavfi', '-i', `color=c=${color}:s=320x320`, '-frames:v', '1', name);
  files[name] = readFileSync(join(fixtures, name));
}
for (const [name, seconds, audio] of [['reel1.mp4', 6, true], ['reel2.mp4', 6, true], ['car3.mp4', 3, false]]) {
  ff('-f', 'lavfi', '-i', `testsrc=size=360x640:rate=25:duration=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', name);
  files[name] = readFileSync(join(fixtures, name));
}

const t0 = 1788000000;
const state = createState(USER);
state.posts = [
  { code: 'E2eImage01', pk: '9000000001', kind: 'image', files: ['img1.jpg'], caption: 'First drop #E2E with @friend', likes: 10, location: 'Casablanca', tagged: ['friend'], takenAt: t0,
    comments: [{ id: '17800000001', user: 'fan_a', text: 'Love it', at: t0 + 60, likes: 2 }] },
  { code: 'E2eCarou01', pk: '9000000002', kind: 'carousel', files: ['car1.jpg', 'car2.jpg', 'car3.mp4'], pageSize: 1, caption: 'Lookbook, "vol 2"\nout now', likes: 20, takenAt: t0 - 86400,
    comments: [{ id: '17800000002', user: 'fan_b', text: 'Fire, "really"', at: t0 - 80000, likes: 0 }, { id: '17800000003', user: 'fan_c', text: 'Price?', at: t0 - 70000, likes: 1 }] },
  { code: 'E2eReel001', pk: '9000000003', kind: 'reel', files: ['reel1.mp4'], duration: 6, views: 500, plays: 800, caption: 'Reel one #bts', likes: 30, takenAt: t0 - 2 * 86400,
    comments: [{ id: '17800000004', user: 'fan_d', text: 'Song?', at: t0 - 150000, likes: 4, replies: [{ id: '17800000005', user: USER, text: 'Original audio', at: t0 - 140000, likes: 1 }] }] },
  { code: 'E2eReel002', pk: '9000000004', kind: 'reel', files: ['reel2.mp4'], duration: 6, views: 50, plays: 90, caption: 'Reel two', likes: 5, takenAt: t0 - 3 * 86400, comments: [] },
  { code: 'E2eNoComm1', pk: '9000000005', kind: 'image', files: ['img2.jpg'], caption: 'Comments off', likes: 7, commentsDisabled: true, takenAt: t0 - 4 * 86400, comments: [] },
  { code: 'E2eGone001', pk: '9000000006', kind: 'image', files: [], caption: 'deleted', likes: 0, takenAt: t0 - 5 * 86400, comments: [], deleted: true },
  { code: 'E2eFlaky01', pk: '9000000007', kind: 'image', files: ['img3.jpg'], caption: 'Flaky page', likes: 3, takenAt: t0 - 6 * 86400,
    comments: [{ id: '17800000006', user: 'fan_e', text: 'Nice', at: t0 - 500000, likes: 0 }] },
];
const post = (code) => state.posts.find((p) => p.code === code);
const { server, url } = await startFakeInstagram(state, files);

writeFileSync(join(work, '.env'), [
  'DATA_DIR=./data', 'LOG_LEVEL=info', 'BROWSER_HEADED=false', 'NAVIGATION_TIMEOUT_MS=20000',
  'DISCOVERY_SCROLL_DELAY_MS=400', 'DISCOVERY_MAX_IDLE_SCROLLS=2', `FFMPEG_PATH=${ffmpeg}`,
  'TRANSCRIPTION_PROVIDER=custom', `TRANSCRIPTION_BASE_URL=${url}/openai/v1`, 'TRANSCRIPTION_MODEL=whisper-1', 'TRANSCRIPTION_API_KEY=e2e-not-a-real-key',
  'COMMENTS_ROUND_DELAY_MS=300', 'COMMENTS_MAX_SECONDS=60', '',
].join('\n'));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(DATA_DIR|LOG_LEVEL|BROWSER_|NAVIGATION_|LOGIN_|DISCOVERY_|FFMPEG_PATH|TRANSCRIPTION_|OPENAI_|GROQ_|COMMENTS_|npm_config_)/.test(k)));

// ---- Helpers ---------------------------------------------------------------------------------------

const cliChild = new URL('./cli-child.mjs', import.meta.url).pathname;
const runs = [];

/** Runs the CLI; `interrupt` sends a signal the first time `when(path, count)` is true for a request to the fake server. */
function cli(args, interrupt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliChild, ...args], { cwd: work, env: { ...childEnv, E2E_SERVER: url } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let fired = false;
    state.onHit = interrupt ? (path, count) => {
      if (!fired && interrupt.when(path, count)) { fired = true; child.kill(interrupt.signal); }
    } : null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cli ${args.join(' ')} timed out\n${out}`)); }, 8 * 60_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      state.onHit = null;
      runs.push({ args: args.join(' '), code, signal, interrupted: fired });
      if (process.env.E2E_VERBOSE) process.stdout.write(`\n$ ${args.join(' ')} -> ${code ?? signal}\n${out}\n`);
      resolve({ code, signal, out, fired });
    });
  });
}

function db() {
  return new Database(join(dataDir, 'raw', 'collector.sqlite'), { readonly: true, fileMustExist: true });
}
function q(sql, ...params) { const d = db(); try { return d.prepare(sql).all(...params); } finally { d.close(); } }
function one(sql, ...params) { return q(sql, ...params)[0]; }
const postRow = (code) => one('SELECT * FROM posts WHERE shortcode = ?', code);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const results = [];
let section = '';
function check(subsystem, name, fn) {
  try {
    const detail = fn();
    results.push({ subsystem, name, ok: true, detail: detail ?? null, section });
  } catch (error) {
    results.push({ subsystem, name, ok: false, detail: error.message.split('\n')[0].slice(0, 400), section });
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function eq(actual, expected, what) {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

/** Every table row count and every media file's hash: what a rerun must leave unchanged. */
function snapshot() {
  const counts = {};
  for (const table of ['posts', 'competitor_posts', 'media', 'comments', 'reel_frames', 'transcripts', 'raw_post_snapshots', 'post_metrics_history']) {
    counts[table] = one(`SELECT count(*) AS n FROM ${table}`).n;
  }
  const fileHashes = Object.fromEntries(q("SELECT local_path FROM media WHERE local_path IS NOT NULL ORDER BY id").map(({ local_path: p }) => [p, sha(join(dataDir, p))]));
  const mtimes = Object.fromEntries(Object.keys(fileHashes).map((p) => [p, statSync(join(dataDir, p)).mtimeMs]));
  return { counts, fileHashes, mtimes, cdn: hitCount(state, '/cdn/') - (state.hits['/cdn/avatar.jpg'] ?? 0), pages: hitCount(state, '/p/'), transcriptions: state.transcriptions };
}

function partFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.part') || String(name).endsWith('.partial'));
}

/** RFC 4180 parser for checking the exported CSVs. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; } else field += c;
  }
  return rows;
}

// ---- 1. Competitor import --------------------------------------------------------------------------

section = 'import';
writeFileSync(join(work, 'competitors.txt'), `# validation list\n@E2E_Brand\nhttps://www.instagram.com/e2e_brand/?hl=en\n\ne2e_other\n`);
let r = await cli(['competitors-import']);
check('1. Competitor import', 'import normalizes @, case and URLs and merges duplicates', () => {
  eq(r.code, 0, 'exit code');
  eq(q('SELECT username FROM competitors ORDER BY username').map((c) => c.username), ['e2e_brand', 'e2e_other'], 'competitors');
});
r = await cli(['competitors-import']);
check('1. Competitor import', 'rerun adds nothing', () => { eq(r.code, 0, 'exit'); assert(/0 added, 2 already saved/.test(r.out), r.out.trim()); });
writeFileSync(join(work, 'competitors.txt'), `e2e_brand\nnew_one\nhttps://www.instagram.com/p/Abc12345/\n`);
r = await cli(['competitors-import']);
check('1. Competitor import', 'an invalid line imports nothing and names the line', () => {
  eq(r.code, 1, 'exit'); assert(/line 3/.test(r.out), r.out.trim()); eq(one('SELECT count(*) AS n FROM competitors').n, 2, 'competitors');
});
writeFileSync(join(work, 'competitors.txt'), 'e2e_brand\ne2e_other\n');

// ---- 2. Session detection --------------------------------------------------------------------------

section = 'session';
r = await cli(['instagram-status']);
check('2. Session detection', 'no saved session is reported', () => { eq(r.code, 1, 'exit'); assert(/No saved Instagram session/.test(r.out), r.out.trim()); });
mkdirSync(join(dataDir, 'browser'), { recursive: true });
writeFileSync(join(dataDir, 'browser', 'instagram-state.json'), JSON.stringify({
  cookies: [{ name: 'sessionid', value: 'e2e-session', domain: '.instagram.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }], origins: [],
}));
state.home = 'logged_out';
r = await cli(['instagram-status']);
check('2. Session detection', 'logged-out home page is an expired session', () => { eq(r.code, 1, 'exit'); assert(/expired/i.test(r.out), r.out.trim()); });
state.home = 'challenge';
r = await cli(['instagram-status']);
check('2. Session detection', 'CAPTCHA/checkpoint page is a challenge, not bypassed', () => { eq(r.code, 1, 'exit'); assert(/security challenge/i.test(r.out), r.out.trim()); });
r = await cli(['scrape', USER]);
check('2. Session detection', 'scrape refuses to start behind a challenge and saves nothing', () => {
  eq(r.code, 1, 'exit'); eq(one('SELECT count(*) AS n FROM posts').n, 0, 'posts'); eq(hitCount(state, `/${USER}/`), 0, 'profile loads');
});
state.home = 'ok';
r = await cli(['instagram-status']);
check('2. Session detection', 'valid session is accepted', () => { eq(r.code, 0, 'exit'); assert(/still logged in/.test(r.out), r.out.trim()); });

// ---- Run 1: Ctrl-C during post metadata (third post page) ------------------------------------------

section = 'run1';
state.brokenPages.add('E2eFlaky01');
state.brokenFiles.add('car2.jpg');
r = await cli(['scrape', USER], { signal: 'SIGINT', when: (path) => path.startsWith('/p/') && hitCount(state, '/p/') === 3 });
const job1 = one("SELECT * FROM scrape_jobs WHERE job_type = 'pipeline' ORDER BY id DESC LIMIT 1");
const stages1 = JSON.parse(job1.stages_json);
const profileLoadsRun1 = hitCount(state, `/${USER}/`);
check('13. Restart/resume', 'Ctrl-C stops with exit 130 and records the stage as interrupted', () => {
  assert(r.fired, 'interrupt did not fire'); eq(r.code, 130, 'exit');
  eq([job1.status, job1.error], ['failed', 'interrupted'], 'job');
  eq([stages1.session?.status, stages1.profile?.status, stages1.discovery?.status, stages1.metadata?.status], ['ok', 'ok', 'ok', 'interrupted'], 'stages');
  assert(!stages1.media, 'media stage ran after the interrupt');
});
check('13. Restart/resume', 'finished posts are saved; the interrupted post is back to pending, not stuck in_progress', () => {
  eq(q("SELECT shortcode FROM posts WHERE extraction_status = 'complete' ORDER BY id").map((p) => p.shortcode), ['E2eImage01', 'E2eCarou01'], 'complete');
  eq(one("SELECT count(*) AS n FROM posts WHERE extraction_status = 'in_progress'").n, 0, 'in_progress posts');
  eq(postRow('E2eReel001').extraction_status, 'pending', 'interrupted post');
});

// ---- Run 2: resume, then hard kill (SIGKILL) during media downloads -------------------------------

section = 'run2';
r = await cli(['scrape', USER], { signal: 'SIGKILL', when: (path) => path === '/cdn/img2.jpg' });
check('13. Restart/resume', 'resumed run did not reload profile/discovery or re-extract finished posts', () => {
  assert(r.fired && r.signal === 'SIGKILL', `hard kill did not happen (exit ${r.code})`);
  eq(hitCount(state, `/${USER}/`), profileLoadsRun1, 'profile page loads');
  eq([state.hits['/p/E2eImage01/'], state.hits['/p/E2eCarou01/']], [1, 1], 'finished post page loads');
  eq(state.hits['/p/E2eReel001/'], 2, 'interrupted post loaded again');
});
const killedJob = one('SELECT * FROM scrape_jobs WHERE id = ?', job1.id);
check('13. Restart/resume', 'after a hard kill the job is left resumable (running) with earlier stages recorded', () => {
  eq(killedJob.status, 'running', 'job status');
  const s = JSON.parse(killedJob.stages_json);
  eq([s.profile.status, s.discovery.status, s.metadata.status], ['ok', 'ok', 'partial'], 'stages');
});

// ---- Run 3: resume to the end ---------------------------------------------------------------------

section = 'run3';
r = await cli(['scrape', USER]);
const job3 = one('SELECT * FROM scrape_jobs WHERE id = ?', job1.id);
const stages3 = JSON.parse(job3.stages_json);
check('13. Restart/resume', 'third run continues the same job, skipping finished stages', () => {
  eq(one("SELECT count(*) AS n FROM scrape_jobs WHERE job_type = 'pipeline'").n, 1, 'pipeline jobs');
  eq(hitCount(state, `/${USER}/`), profileLoadsRun1, 'profile page loads');
  assert(/resumed/.test(r.out), 'summary does not say resumed');
});
check('13. Restart/resume', 'files saved before the hard kill were kept, not downloaded again', () => {
  eq([state.hits['/cdn/img1.jpg'], state.hits['/cdn/car1.jpg'], state.hits['/cdn/car3.mp4']], [1, 1, 1], 'CDN requests');
  eq(partFiles(join(dataDir, 'competitors')), [], 'leftover partial files');
});
check('13. Restart/resume', 'pending work continued: every reachable post has metadata', () => {
  eq(q("SELECT shortcode FROM posts WHERE extraction_status != 'complete' AND availability = 'available'").length, 0, 'available but incomplete');
  eq(q("SELECT shortcode, extraction_status FROM posts WHERE extraction_status != 'complete' ORDER BY id").map((p) => p.shortcode), ['E2eGone001', 'E2eFlaky01'], 'not complete');
});
check('13. Restart/resume', 'stages with remaining failures are partial and the job is failed (resumable)', () => {
  eq([stages3.metadata.status, stages3.media.status, job3.status], ['partial', 'partial', 'failed'], 'metadata, media, job');
});

// ---- 3-12: what one full collection produced -------------------------------------------------------

section = 'content';
check('3. Profile extraction', 'profile fields, avatar file and a raw snapshot saved', () => {
  const c = one('SELECT * FROM competitors WHERE username = ?', USER);
  eq([c.display_name, c.bio, c.followers_count, c.following_count, c.posts_count, c.category, c.external_url, c.account_status],
    ['E2E Brand', 'Validation fixture', 1234, 12, 7, 'Clothing', 'https://example.com/shop', 'active'], 'fields');
  assert(c.profile_image_path && existsSync(join(dataDir, c.profile_image_path)), 'avatar file missing');
  assert(one('SELECT count(*) AS n FROM raw_profile_snapshots WHERE competitor_id = ?', c.id).n >= 1, 'no raw snapshot');
});
check('4. Post discovery', 'every grid post discovered once with its type; checkpoint complete', () => {
  eq(q('SELECT shortcode, type FROM posts ORDER BY id').map((p) => `${p.shortcode}:${p.type}`),
    ['E2eImage01:image', 'E2eCarou01:carousel', 'E2eReel001:reel', 'E2eReel002:reel', 'E2eNoComm1:image', 'E2eGone001:image', 'E2eFlaky01:image'], 'posts');
  const cp = JSON.parse(one("SELECT cursor_json FROM collection_checkpoints WHERE stage = 'discovery'").cursor_json);
  eq([cp.status, cp.endReason], ['complete', 'end_of_profile'], 'checkpoint');
});
check('5. Post metadata', 'caption, entities, time, location, tags, metrics from the media object', () => {
  const p = postRow('E2eImage01');
  eq([p.instagram_post_id, p.caption, JSON.parse(p.hashtags_json), JSON.parse(p.mentions_json), JSON.parse(p.tagged_users_json), p.location, p.published_at, p.likes_count, p.comments_count, p.owner_username],
    ['9000000001', 'First drop #E2E with @friend', ['e2e'], ['friend'], ['friend'], 'Casablanca', new Date(t0 * 1000).toISOString(), 10, 1, USER], 'image post');
  eq(one('SELECT count(*) AS n FROM post_metrics_history WHERE post_id = ?', p.id).n, 1, 'metrics observations');
  assert(one('SELECT count(*) AS n FROM raw_post_snapshots WHERE post_id = ?', p.id).n === 1, 'raw snapshot missing');
});
check('5. Post metadata', 'deleted post recorded as unavailable (permanent), not as a failure', () => {
  const p = postRow('E2eGone001');
  eq([p.availability, p.extraction_attempts], ['unavailable', 0], 'deleted post');
});
check('6. Image post', 'single image downloaded, verified and described in the post folder', () => {
  const p = postRow('E2eImage01');
  const m = q('SELECT * FROM media WHERE post_id = ?', p.id);
  eq(m.map((x) => [x.position, x.media_type, x.download_status, x.file_format]), [[0, 'image', 'complete', 'jpg']], 'media');
  eq(sha(join(dataDir, m[0].local_path)), createHash('sha256').update(files['img1.jpg']).digest('hex'), 'file content');
  const dir = join(dataDir, 'competitors', USER, 'posts', 'E2eImage01');
  eq(readFileSync(join(dir, 'caption.txt'), 'utf8'), p.caption, 'caption.txt');
  eq(JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')).shortcode, 'E2eImage01', 'metadata.json');
  eq(p.media_status, 'complete', 'media_status');
});
check('7. Carousel post', 'slides kept in order as 001/002/003 with the video slide as mp4', () => {
  const p = postRow('E2eCarou01');
  eq(p.carousel_count, 3, 'carousel_count');
  const m = q('SELECT position, media_type, local_path, download_status FROM media WHERE post_id = ? ORDER BY position', p.id);
  eq(m.map((x) => `${x.position}:${x.media_type}:${x.download_status}:${x.local_path?.split('/').pop() ?? '-'}`),
    ['0:image:complete:001.jpg', '1:image:failed:-', '2:video:complete:003.mp4'], 'slides (002 fails until the CDN recovers)');
});
check('8. Reel', 'Reel metadata: views, plays, duration, audio', () => {
  const p = postRow('E2eReel001');
  eq([p.type, p.product_type, p.views_count, p.plays_count, p.duration_seconds, p.audio_title, p.audio_type], ['reel', 'clips', 500, 800, 6, 'Original audio', 'original_sounds'], 'reel');
});
check('9. Reel media', 'video + thumbnail downloaded, MP4 probed, status processed', () => {
  for (const code of ['E2eReel001', 'E2eReel002']) {
    const p = postRow(code);
    eq([p.reel_status, p.video_width, p.video_height, p.video_has_audio], ['processed', 360, 640, 1], `${code} reel`);
    assert(Math.abs(p.video_probe_duration - 6) < 0.2, `${code} probe duration ${p.video_probe_duration}`);
    assert(p.thumbnail_path && existsSync(join(dataDir, p.thumbnail_path)), `${code} thumbnail missing`);
    const v = one("SELECT * FROM media WHERE post_id = ? AND media_type = 'video'", p.id);
    eq(v.sha256, createHash('sha256').update(files[post(code).files[0]]).digest('hex'), `${code} video content`);
  }
});
check('10. FFmpeg frames', '6 s Reel at the default 1 s interval gives frames at 0-5 s, files on disk', () => {
  for (const code of ['E2eReel001', 'E2eReel002']) {
    const p = postRow(code);
    const frames = q('SELECT timestamp_seconds, image_path FROM reel_frames WHERE post_id = ? ORDER BY timestamp_seconds', p.id);
    eq([p.frames_status, p.frames_count, frames.map((f) => f.timestamp_seconds)], ['complete', 6, [0, 1, 2, 3, 4, 5]], `${code} frames`);
    for (const f of frames) assert(statSync(join(dataDir, f.image_path)).size > 0, `${f.image_path} missing`);
  }
});
check('11. Transcript', 'each Reel transcribed once through the configured provider, segments kept', () => {
  eq(state.transcriptions, 2, 'provider calls');
  const t = one('SELECT t.* FROM transcripts t JOIN posts p ON p.id = t.post_id WHERE p.shortcode = ?', 'E2eReel001');
  eq([t.provider, t.model, t.transcript, t.has_speech, JSON.parse(t.segments_json).length], ['custom', 'whisper-1', 'Hello from the validation reel.', 1, 1], 'transcript');
  eq(postRow('E2eReel001').transcript_status, 'complete', 'status');
});
check('12. Comments', 'comments and the reply saved with ids, likes and parent links', () => {
  const rows = q('SELECT c.instagram_comment_id AS id, c.parent_comment_id AS parent, c.username, c.likes_count AS likes FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.shortcode = ? ORDER BY c.id', 'E2eReel001');
  eq(rows, [{ id: '17800000004', parent: null, username: 'fan_d', likes: 4 }, { id: '17800000005', parent: '17800000004', username: USER, likes: 1 }], 'reel comments');
  eq(one('SELECT count(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.shortcode = ?', 'E2eCarou01').n, 2, 'carousel comments (second one loaded by scrolling the panel)');
  eq([postRow('E2eCarou01').comments_completion, postRow('E2eCarou01').comments_stop_reason], ['complete', 'end_of_comments'], 'carousel completion');
  eq([postRow('E2eNoComm1').comments_status, postRow('E2eNoComm1').comments_stop_reason], ['complete', 'comments_disabled'], 'comments off');
  eq(state.hits['/p/E2eNoComm1/'], 1, 'comments-off post not opened for comments');
});

// ---- 15. Failed-item retry -------------------------------------------------------------------------

section = 'retry';
r = await cli(['retry-failed', USER, '--dry-run']);
check('15. Failed-item retry', 'dry run lists the failed metadata and media items, changes nothing', () => {
  eq(r.code, 0, 'exit');
  assert(/e2e_brand\s+metadata\s+1\s+0\s+0/.test(r.out) && /e2e_brand\s+media\s+1\s+0\s+0/.test(r.out), r.out.trim());
  eq(postRow('E2eFlaky01').extraction_status, 'failed', 'flaky post');
});
state.brokenPages.clear();
state.brokenFiles.clear();
r = await cli(['retry-failed', USER]);
check('15. Failed-item retry', 'retry fixes the post page and the CDN file once they recover', () => {
  eq(r.code, 0, `exit (${r.out.trim().split('\n').slice(-4).join(' | ')})`);
  eq(postRow('E2eFlaky01').extraction_status, 'complete', 'flaky post');
  eq(postRow('E2eCarou01').media_status, 'complete', 'carousel media');
  eq(one("SELECT count(*) AS n FROM media WHERE download_status = 'failed'").n, 0, 'failed media');
  eq(postRow('E2eGone001').availability, 'unavailable', 'deleted post left alone');
});
r = await cli(['scrape', USER]);
check('15. Failed-item retry', 'the next scrape finishes the retried post (media, comments) and completes the job', () => {
  eq(r.code, 0, 'exit');
  eq(one('SELECT status FROM scrape_jobs WHERE id = ?', job1.id).status, 'complete', 'job');
  eq([postRow('E2eFlaky01').media_status, postRow('E2eFlaky01').comments_status], ['complete', 'complete'], 'flaky post stages');
});
r = await cli(['status']);
check('15. Failed-item retry', 'status shows no failed posts', () => { assert(/e2e_brand\s+7\s+6\s+6\s+0\s/.test(r.out), r.out.trim()); });

// ---- 14. Duplicate prevention ----------------------------------------------------------------------

section = 'duplicates';
const before = snapshot();
r = await cli(['scrape', USER]);
const after = snapshot();
check('14. Duplicate prevention', 'second scrape of the same competitor creates no rows and downloads nothing', () => {
  eq(r.code, 0, 'exit');
  eq(after.counts, before.counts, 'row counts');
  eq(after.cdn - before.cdn, 0, 'CDN media requests');
  eq(after.pages - before.pages, 0, 'post page loads');
  eq(after.transcriptions, before.transcriptions, 'transcription calls');
});
check('14. Duplicate prevention', 'files on disk untouched (same hash, same mtime)', () => {
  eq(after.fileHashes, before.fileHashes, 'hashes'); eq(after.mtimes, before.mtimes, 'mtimes');
});
state.posts.unshift({ code: 'E2eNewPost', pk: '9000000008', kind: 'image', files: ['img4.jpg'], caption: 'Brand new', likes: 1, takenAt: t0 + 86400, comments: [] });
const beforeNew = snapshot();
r = await cli(['scrape', USER]);
check('14. Duplicate prevention', 'a new post on the profile is added once and collected; nothing else repeats', () => {
  eq(r.code, 0, 'exit');
  const now = snapshot();
  eq(now.counts.posts - beforeNew.counts.posts, 1, 'new posts');
  eq(now.counts.media - beforeNew.counts.media, 1, 'new media rows');
  eq(now.pages - beforeNew.pages, 1, 'post page loads');
  eq(postRow('E2eNewPost').media_status, 'complete', 'new post media');
});
check('14. Duplicate prevention', 'no duplicate keys anywhere', () => {
  eq(q('SELECT shortcode FROM posts GROUP BY shortcode HAVING count(*) > 1'), [], 'posts');
  eq(q('SELECT post_id, position FROM media GROUP BY post_id, position HAVING count(*) > 1'), [], 'media');
  eq(q('SELECT post_id, instagram_comment_id FROM comments GROUP BY post_id, instagram_comment_id HAVING count(*) > 1'), [], 'comments');
  eq(q('SELECT post_id, timestamp_seconds FROM reel_frames GROUP BY post_id, timestamp_seconds HAVING count(*) > 1'), [], 'frames');
});

// ---- Refresh: metrics change, content must not ---------------------------------------------------

section = 'refresh';
const permanent = (code) => {
  const p = postRow(code);
  return [p.instagram_post_id, p.type, p.product_type, p.caption, p.published_at, p.location, p.tagged_users_json, p.hashtags_json, p.owner_username, p.duration_seconds, p.audio_title, p.width, p.height, p.carousel_count];
};
const codes = ['E2eImage01', 'E2eCarou01', 'E2eReel001'];
const contentBefore = Object.fromEntries(codes.map((c) => [c, permanent(c)]));
const refreshBefore = snapshot();
for (const p of state.posts) { p.likes += 100; if (p.kind === 'reel') { p.views += 1000; p.plays += 2000; } }
post('E2eReel001').comments[0].likes = 40;
state.followers = 1500;
state.urlGeneration = 2;
r = await cli(['scrape', USER, '--force']);
const refreshAfter = snapshot();
check('Refresh (--force)', 'likes, views and plays updated; each observation kept in metrics history', () => {
  eq(r.code, 0, 'exit');
  eq([postRow('E2eImage01').likes_count, postRow('E2eReel001').views_count, postRow('E2eReel001').plays_count], [110, 1500, 2800], 'latest metrics');
  eq(q('SELECT h.likes_count FROM post_metrics_history h JOIN posts p ON p.id = h.post_id WHERE p.shortcode = ? ORDER BY h.id', 'E2eImage01').map((h) => h.likes_count), [10, 110], 'history');
  eq(one('SELECT followers_count FROM competitors WHERE username = ?', USER).followers_count, 1500, 'followers');
});
check('Refresh (--force)', 'caption, time, tags, type and other content unchanged', () => {
  for (const c of codes) eq(permanent(c), contentBefore[c], c);
});
check('Refresh (--force)', 'fresh signed URLs stored, files not downloaded again or rewritten', () => {
  assert(q('SELECT source_url FROM media WHERE source_url IS NOT NULL').every((m) => m.source_url.includes('_nc_gen=2')), 'old URLs kept');
  eq(refreshAfter.fileHashes, refreshBefore.fileHashes, 'hashes');
  eq(refreshAfter.mtimes, refreshBefore.mtimes, 'mtimes');
  eq(refreshAfter.cdn - refreshBefore.cdn, 0, 'CDN media requests');
});
check('Refresh (--force)', 'comments refreshed in place (likes), none duplicated; frames replaced, not added', () => {
  eq(refreshAfter.counts.comments, refreshBefore.counts.comments, 'comment rows');
  eq(one("SELECT likes_count FROM comments WHERE instagram_comment_id = '17800000004'").likes_count, 40, 'comment likes');
  eq(refreshAfter.counts.reel_frames, refreshBefore.counts.reel_frames, 'frame rows');
  for (const code of ['E2eReel001', 'E2eReel002']) eq(readdirSync(join(dataDir, 'competitors', USER, 'posts', code, 'frames')).length, 1, `${code} frame generations on disk`);
});
check('Refresh (--force)', 'raw payloads appended as new snapshots, earlier ones kept', () => {
  assert(refreshAfter.counts.raw_post_snapshots > refreshBefore.counts.raw_post_snapshots, 'no new raw snapshots');
  eq(refreshAfter.counts.posts, refreshBefore.counts.posts, 'posts');
  eq(refreshAfter.counts.media, refreshBefore.counts.media, 'media rows');
});

// A refresh that only gets a degraded page (no media JSON, just OpenGraph) must not wipe what was collected.
state.degraded = new Set(codes);
const degradedBefore = Object.fromEntries(codes.map((c) => [c, [...permanent(c), postRow(c).likes_count, postRow(c).comments_count, postRow(c).views_count]]));
const degradedMedia = () => q(`SELECT m.* FROM media m JOIN posts p ON p.id = m.post_id WHERE p.shortcode IN (${codes.map(() => '?').join(',')}) ORDER BY m.id`, ...codes);
const mediaBefore = degradedMedia();
r = await cli(['scrape-posts', USER, '--force']);
check('Refresh (--force)', 'a degraded refresh page (meta only) does not erase collected content or metrics', () => {
  eq(r.code, 0, 'exit');
  for (const c of codes) eq([...permanent(c), postRow(c).likes_count, postRow(c).comments_count, postRow(c).views_count], degradedBefore[c], c);
  eq(degradedMedia(), mediaBefore, 'media rows of the degraded posts');
});
state.degraded = new Set();

// ---- 16. Exports -----------------------------------------------------------------------------------

section = 'export';
r = await cli(['export', USER]);
check('16. Exports', 'JSON export holds every post with media, comments, frames, transcript and history', () => {
  eq(r.code, 0, 'exit');
  const doc = JSON.parse(readFileSync(join(dataDir, 'exports', USER, `${USER}.json`), 'utf8'));
  eq(doc.posts.length, one('SELECT count(*) AS n FROM posts').n, 'posts');
  eq(doc.posts.reduce((n, p) => n + p.comments.length, 0), one('SELECT count(*) AS n FROM comments').n, 'comments');
  const reel = doc.posts.find((p) => p.shortcode === 'E2eReel001');
  eq([reel.frames.length, reel.transcript?.text, reel.metrics.history.length >= 2], [6, 'Hello from the validation reel.', true], 'reel');
  for (const p of doc.posts) for (const m of p.media) if (m.local_path) assert(existsSync(join(doc.export.data_dir, m.local_path)), `missing ${m.local_path}`);
  for (const f of reel.frames) assert(existsSync(join(doc.export.data_dir, f.path)), `missing ${f.path}`);
});
check('16. Exports', 'CSV files parse back with one row per post, comment and observation', () => {
  const csv = (name) => parseCsv(readFileSync(join(dataDir, 'exports', USER, `${name}.csv`), 'utf8'));
  const posts = csv('posts');
  eq(posts.length - 1, one('SELECT count(*) AS n FROM posts').n, 'posts.csv rows');
  eq(posts.every((row) => row.length === posts[0].length), true, 'posts.csv column count');
  eq(posts.find((row) => row[1] === 'E2eCarou01')[posts[0].indexOf('caption')], 'Lookbook, "vol 2"\nout now', 'caption with comma, quotes, newline');
  eq(csv('comments').length - 1, one('SELECT count(*) AS n FROM comments').n, 'comments.csv rows');
  eq(csv('metrics').length - 1, one('SELECT count(*) AS n FROM post_metrics_history').n, 'metrics.csv rows');
});

// ---- Report ----------------------------------------------------------------------------------------

server.close();
const subsystems = [...new Set(results.map((x) => x.subsystem))];
const lines = ['', 'VALIDATION REPORT', '================='];
for (const s of subsystems) {
  const rows = results.filter((x) => x.subsystem === s);
  lines.push(`${rows.every((x) => x.ok) ? 'PASS' : 'FAIL'}  ${s}`);
  for (const x of rows) lines.push(`        ${x.ok ? 'ok  ' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n                ${x.detail}`}`);
}
const failed = results.filter((x) => !x.ok).length;
lines.push('', `${results.length - failed}/${results.length} checks passed across ${subsystems.length} subsystems; ${runs.length} CLI runs.`);
if (process.env.E2E_KEEP) lines.push(`Workspace kept: ${work}`); else rmSync(work, { recursive: true, force: true });
console.log(lines.join('\n'));
process.exitCode = failed ? 1 : 0;
