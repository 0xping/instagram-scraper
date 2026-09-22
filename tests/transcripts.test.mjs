import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { migrate, openDatabase } from '../dist/db.js';
import { processCompetitorTranscripts } from '../dist/transcripts.js';
import { createTranscriptionProvider, TranscriptionServiceError } from '../dist/transcription-provider.js';

const box = (type, ...parts) => { const body = Buffer.concat(parts); const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const track = (type) => box('trak', box('tkhd', Buffer.alloc(4), Buffer.alloc(72), u32(720 * 65536), u32(1280 * 65536)), box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(type), Buffer.alloc(13))));
const mp4 = (audio) => Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), box('moov', box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(1000), u32(10000), Buffer.alloc(80)), track('vide'), ...(audio ? [track('soun')] : [])), box('mdat', Buffer.alloc(50, 9))]);

test('transcripts keep raw results, skip completed Reels, record silence and preserve prior results on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  const fake = join(dir, 'ffmpeg.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), 'audio');
`);
  chmodSync(fake, 0o755);
  process.env.FFMPEG_PATH = fake;
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const add = (code, audio, downloaded = true) => {
      const id = Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, reel_status) VALUES (?, ?, 'u', 'reel', 'complete', 'processed')").run(cid, code).lastInsertRowid);
      if (downloaded) {
        const path = `competitors/brand/posts/${code}/media/001.mp4`;
        mkdirSync(join(dir, `competitors/brand/posts/${code}/media`), { recursive: true });
        writeFileSync(join(dir, path), mp4(audio));
        db.prepare("INSERT INTO media (post_id, position, media_type, download_status, local_path) VALUES (?, 0, 'video', 'complete', ?)").run(id, path);
      }
      return id;
    };
    const spoken = add('Spoken01', true);
    const silent = add('Silent01', false);
    add('NoVideo01', false, false);
    const quietAudio = add('QuietAudio01', true);
    let calls = 0;
    const provider = { name: 'mock', model: 'test-v1', async transcribe(path) {
      assert.match(path, /audio\.mp3$/);
      calls++;
      if (calls === 2) return { transcript: '  ', language: 'fr', segments: [], raw: { text: '  ', language: 'fr' } };
      return { transcript: 'مرحبا hello', language: 'ar', segments: [{ start: 0, end: 2, text: 'مرحبا hello' }], raw: { text: 'مرحبا hello', language: 'ar', extra: 1 } };
    } };
    const options = { dataDir: dir, log: { info() {}, warn() {} }, force: false, provider };
    const competitor = { id: cid, username: 'brand' };
    assert.deepEqual((await processCompetitorTranscripts(db, competitor, options)).counts,
      { complete: 1, no_speech: 2, skipped: 0, no_video: 1, failed: 0 });
    assert.equal(calls, 2);
    assert.deepEqual(db.prepare('SELECT provider, model, language, transcript, segments_json, transcript_json, has_speech FROM transcripts WHERE post_id = ?').get(spoken),
      { provider: 'mock', model: 'test-v1', language: 'ar', transcript: 'مرحبا hello', segments_json: '[{"start":0,"end":2,"text":"مرحبا hello"}]', transcript_json: '{"text":"مرحبا hello","language":"ar","extra":1}', has_speech: 1 });
    assert.deepEqual(db.prepare('SELECT provider, has_speech, transcript FROM transcripts WHERE post_id = ?').get(silent), { provider: 'none', has_speech: 0, transcript: '' });
    assert.deepEqual(db.prepare('SELECT provider, language, has_speech, transcript FROM transcripts WHERE post_id = ?').get(quietAudio),
      { provider: 'mock', language: 'fr', has_speech: 0, transcript: '' });
    assert.equal((await processCompetitorTranscripts(db, competitor, options)).counts.skipped, 3);
    assert.equal(calls, 2);
    const failing = { ...provider, async transcribe() { throw new Error('provider unavailable'); } };
    assert.equal((await processCompetitorTranscripts(db, competitor, { ...options, force: true, provider: failing })).counts.failed, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM transcripts WHERE post_id = ?').get(spoken).n, 1);
    assert.deepEqual(db.prepare('SELECT transcript_status, transcript_error, extraction_status, reel_status FROM posts WHERE id = ?').get(spoken),
      { transcript_status: 'complete', transcript_error: 'provider unavailable', extraction_status: 'complete', reel_status: 'processed' });
    let blockedCalls = 0;
    const blocked = { ...provider, async transcribe() { blockedCalls++; throw new TranscriptionServiceError('mock', 429); } };
    await assert.rejects(processCompetitorTranscripts(db, competitor, { ...options, force: true, provider: blocked }), /HTTP 429/);
    assert.equal(blockedCalls, 1, 'provider-wide failures do not consume every remaining post');
    assert.equal(db.prepare('SELECT transcript_attempts FROM posts WHERE id = ?').get(spoken).transcript_attempts, 0);
  } finally {
    delete process.env.FFMPEG_PATH;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcription provider: presets, custom server, and clear configuration errors', () => {
  const keys = ['TRANSCRIPTION_PROVIDER', 'TRANSCRIPTION_MODEL', 'TRANSCRIPTION_BASE_URL', 'TRANSCRIPTION_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const make = (env) => {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    return createTranscriptionProvider();
  };
  try {
    assert.throws(() => make({}), /Set TRANSCRIPTION_PROVIDER/);
    assert.throws(() => make({ TRANSCRIPTION_PROVIDER: 'nope' }), /Unsupported/);
    assert.throws(() => make({ TRANSCRIPTION_PROVIDER: 'groq' }), /GROQ_API_KEY/);
    const groq = make({ TRANSCRIPTION_PROVIDER: 'groq', GROQ_API_KEY: 'k' });
    assert.deepEqual([groq.name, groq.model], ['groq', 'whisper-large-v3-turbo']);
    const openai = make({ TRANSCRIPTION_PROVIDER: 'OpenAI', TRANSCRIPTION_API_KEY: 'k', TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe' });
    assert.deepEqual([openai.name, openai.model], ['openai', 'gpt-4o-mini-transcribe']);
    assert.throws(() => make({ TRANSCRIPTION_PROVIDER: 'custom', TRANSCRIPTION_MODEL: 'm' }), /TRANSCRIPTION_BASE_URL/);
    assert.throws(() => make({ TRANSCRIPTION_PROVIDER: 'custom', TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1' }), /TRANSCRIPTION_MODEL/);
    assert.equal(make({ TRANSCRIPTION_PROVIDER: 'custom', TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1/', TRANSCRIPTION_MODEL: 'Systran/faster-whisper-small' }).name, 'custom', 'no key needed');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
