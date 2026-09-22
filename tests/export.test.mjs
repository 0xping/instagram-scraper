import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCompetitorExport, csvField, exportCompetitor, toCsv } from '../dist/export.js';
import { migrate, openDatabase } from '../dist/db.js';

/** Minimal RFC 4180 reader, so the test checks what a real CSV parser would get back. */
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else field += ch;
  }
  return rows;
}

test('csvField escapes per RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField(' padded'), '" padded"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(false), 'false');
  assert.equal(csvField(0), '0');
  const tricky = ['é ✨ 🇲🇦 مرحبا', 'x,"y"\r\nz', ''];
  assert.deepEqual(parseCsv(toCsv(['a', 'b', 'c'], [tricky])), [['a', 'b', 'c'], tricky]);
});

test('export: normalized JSON with everything nested, paths not bytes, CSVs that round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username, display_name, verified, followers_count) VALUES ('brand', 'Brând ✨', 1, 1200)").run().lastInsertRowid);
    const reel = Number(db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, extraction_status, caption, hashtags_json, mentions_json,
        likes_count, comments_count, published_at, duration_seconds, audio_title, video_has_audio, raw_json, thumbnail_path)
      VALUES (?, 'Reel0000001', 'https://www.instagram.com/reel/Reel0000001/', 'reel', 'complete', ?, '["drop","مغرب"]', '["friend"]',
        50, 2, '2026-01-02T00:00:00.000Z', 12.5, 'Original audio', 1, '{"code":"Reel0000001"}', 'competitors/brand/posts/Reel0000001/media/thumbnail.jpg')`)
      .run(cid, 'New drop, "limited"\nمرحبا 🔥').lastInsertRowid);
    db.prepare(`INSERT INTO posts (competitor_id, shortcode, url, type, published_at) VALUES (?, 'Image000001', 'u', 'image', '2025-01-01T00:00:00.000Z')`).run(cid);
    db.prepare("INSERT INTO media (post_id, position, media_type, local_path, bytes, download_status) VALUES (?, 0, 'video', 'competitors/brand/posts/Reel0000001/media/001.mp4', 999, 'complete')").run(reel);
    db.prepare("INSERT INTO post_metrics_history (post_id, likes_count, comments_count, observed_at) VALUES (?, 40, 1, '2026-01-03T00:00:00Z'), (?, 50, 2, '2026-01-04T00:00:00Z')").run(reel, reel);
    db.prepare("INSERT INTO comments (post_id, instagram_comment_id, username, text, likes_count, published_at) VALUES (?, '1', 'fan', 'love it, \"really\"', 3, '2026-01-02T01:00:00Z'), (?, '2', 'fan2', 'مرحبا', 0, '2026-01-02T02:00:00Z')").run(reel, reel);
    db.prepare("UPDATE comments SET parent_comment_id = '1' WHERE instagram_comment_id = '2'").run();
    db.prepare("INSERT INTO reel_frames (post_id, timestamp_seconds, image_path) VALUES (?, 0, 'f/frame_00001.jpg'), (?, 2, 'f/frame_00002.jpg')").run(reel, reel);
    db.prepare("INSERT INTO transcripts (post_id, provider, transcript) VALUES (?, 'openai', 'old attempt'), (?, 'openai', 'hello world')").run(reel, reel);

    const doc = buildCompetitorExport(db, cid, { dataDir: dir, raw: true });
    assert.equal(doc.export.schema_version, 1);
    assert.deepEqual([doc.competitor.username, doc.competitor.display_name, doc.competitor.verified], ['brand', 'Brând ✨', true]);
    assert.deepEqual(doc.posts.map((p) => p.shortcode), ['Reel0000001', 'Image000001'], 'newest first');
    const [p, img] = doc.posts;
    assert.deepEqual(p.hashtags, ['drop', 'مغرب']);
    assert.deepEqual(p.metrics.history.map((h) => h.likes), [40, 50]);
    assert.equal(p.media[0].local_path, 'competitors/brand/posts/Reel0000001/media/001.mp4');
    assert.deepEqual(p.comments.map((c) => [c.id, c.parent_id]), [['1', null], ['2', '1']]);
    assert.deepEqual(p.frames, [{ timestamp_seconds: 0, path: 'f/frame_00001.jpg' }, { timestamp_seconds: 2, path: 'f/frame_00002.jpg' }]);
    assert.equal(p.transcript.text, 'hello world', 'latest transcript attempt');
    assert.deepEqual([p.reel.duration_seconds, p.reel.file.has_audio, p.reel.audio.title], [12.5, true, 'Original audio']);
    assert.deepEqual(p.raw, { code: 'Reel0000001' });
    assert.deepEqual([img.reel, img.transcript, img.media, img.comments], [null, null, [], []]);
    assert.equal('raw' in buildCompetitorExport(db, cid, { dataDir: dir, raw: false }).posts[0], false, '--no-raw');

    const out = join(dir, 'exports');
    const files = exportCompetitor(db, { id: cid, username: 'brand' }, ['json', 'csv'], out, { dataDir: dir, raw: false });
    assert.deepEqual(files.map((f) => f.slice(out.length + 1)), ['brand/brand.json', 'brand/posts.csv', 'brand/comments.csv', 'brand/metrics.csv']);
    const json = readFileSync(join(out, 'brand/brand.json'), 'utf8');
    assert.ok(json.includes('مرحبا 🔥'), 'UTF-8 written as-is, not escaped');
    assert.ok(!/base64|data:image/.test(json), 'no embedded binaries');

    const posts = parseCsv(readFileSync(join(out, 'brand/posts.csv'), 'utf8'));
    const col = (name) => posts[0].indexOf(name);
    assert.equal(posts.length, 3);
    assert.equal(posts[1][col('caption')], 'New drop, "limited"\nمرحبا 🔥');
    assert.equal(posts[1][col('hashtags')], 'drop مغرب');
    assert.equal(posts[1][col('transcript')], 'hello world');
    assert.equal(posts[1][col('media_paths')], 'competitors/brand/posts/Reel0000001/media/001.mp4');
    assert.ok(posts.every((row) => row.length === posts[0].length), 'every row has every column');
    const comments = parseCsv(readFileSync(join(out, 'brand/comments.csv'), 'utf8'));
    assert.deepEqual(comments[1], ['brand', 'Reel0000001', '1', '', 'fan', 'love it, "really"', '3', '2026-01-02T01:00:00Z']);
    const metrics = parseCsv(readFileSync(join(out, 'brand/metrics.csv'), 'utf8'));
    assert.deepEqual(metrics.map((r) => r[3]), ['likes', '40', '50']);

    // Rerun overwrites in place (no duplicates, no leftover temp files).
    exportCompetitor(db, { id: cid, username: 'brand' }, ['csv'], out, { dataDir: dir, raw: false });
    assert.equal(parseCsv(readFileSync(join(out, 'brand/comments.csv'), 'utf8')).length, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
