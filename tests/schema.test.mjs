import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { migrate, openDatabase } from '../dist/db.js';

test('schema migrates and preserves one sample collection across retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-schema-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    assert.equal(migrate(db), 15);
    assert.equal(migrate(db), 0);
    db.prepare("INSERT INTO competitors (username, display_name) VALUES ('brand', 'Brand')").run();
    assert.throws(() => db.prepare("INSERT INTO competitors (username) VALUES ('BRAND')").run(), /UNIQUE/);

    const competitorId = db.prepare("SELECT id FROM competitors WHERE username = 'brand'").get().id;
    assert.throws(() => db.prepare("INSERT INTO posts (shortcode, url) VALUES ('orphan', 'https://example.test/p/orphan')").run(), /competitor_id/);
    assert.throws(() => db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (999, 'missing', 'https://example.test/p/missing')").run(), /FOREIGN KEY/);
    const postId = db.prepare("INSERT INTO posts (competitor_id, shortcode, url, instagram_post_id, type, raw_json, discovery_status) VALUES (?, 'abc', 'https://example.test/p/abc', 'ig-1', 'carousel', '{\"version\":1}', 'complete')").run(competitorId).lastInsertRowid;
    assert.match(db.prepare('SELECT created_at FROM posts WHERE id = ?').get(postId).created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.throws(() => db.prepare("INSERT INTO posts (competitor_id, shortcode, url) VALUES (?, 'abc', 'https://example.test/p/abc')").run(competitorId), /UNIQUE/);
    assert.throws(() => db.prepare("INSERT INTO posts (competitor_id, shortcode, url, instagram_post_id) VALUES (?, 'other', 'https://example.test/p/other', 'ig-1')").run(competitorId), /UNIQUE/);
    db.prepare('UPDATE posts SET raw_json = ? WHERE id = ?').run('{"version":2}', postId);
    assert.deepEqual(db.prepare('SELECT raw_json FROM raw_post_snapshots WHERE post_id = ? ORDER BY id').all(postId).map((row) => JSON.parse(row.raw_json).version), [1, 2]);
    assert.throws(() => db.prepare('DELETE FROM raw_post_snapshots WHERE post_id = ?').run(postId), /append-only/);

    db.prepare("INSERT INTO media (post_id, position, media_type, source_url) VALUES (?, 0, 'image', 'https://example.test/image.jpg')").run(postId);
    assert.throws(() => db.prepare("INSERT INTO media (post_id, position) VALUES (?, 0)").run(postId), /UNIQUE/);
    db.prepare("INSERT INTO comments (post_id, instagram_comment_id, username, text) VALUES (?, 'c-1', 'visitor', 'Nice')").run(postId);
    assert.throws(() => db.prepare("INSERT INTO comments (post_id, instagram_comment_id, username, text) VALUES (?, 'c-1', 'visitor', 'Nice')").run(postId), /UNIQUE/);
    db.prepare("INSERT INTO reel_frames (post_id, timestamp_seconds, image_path) VALUES (?, 1.5, 'frame.jpg')").run(postId);
    db.prepare("INSERT INTO transcripts (post_id, provider, transcript) VALUES (?, 'manual', 'Hello')").run(postId);
    db.prepare("INSERT INTO scrape_jobs (competitor_id, job_type, status) VALUES (?, 'refresh', 'running')").run(competitorId);
    const jobId = db.prepare('SELECT id FROM scrape_jobs').get().id;
    db.prepare('INSERT INTO post_metrics_history (post_id, scrape_job_id, likes_count, views_count) VALUES (?, ?, 10, 100)').run(postId, jobId);
    assert.throws(() => db.prepare('INSERT INTO post_metrics_history (post_id, scrape_job_id, likes_count) VALUES (?, ?, 11)').run(postId, jobId), /UNIQUE/);
    db.prepare('INSERT INTO post_metrics_history (post_id, likes_count, views_count) VALUES (?, 15, 120)').run(postId);
    db.prepare('UPDATE posts SET likes_count = 15, views_count = 120 WHERE id = ?').run(postId);
    db.prepare("INSERT INTO scrape_errors (competitor_id, post_id, stage, error_type, error_message, retryable) VALUES (?, ?, 'comments', 'timeout', 'Timed out', 1)").run(competitorId, postId);
    db.prepare("INSERT INTO analysis (post_id, analysis_type, model, prompt_version, result_json) VALUES (?, 'summary', 'example', 'v1', '{}')").run(postId);
    assert.equal(db.prepare('SELECT count(*) AS count FROM post_metrics_history WHERE post_id = ?').get(postId).count, 2);
    assert.throws(() => db.prepare('UPDATE post_metrics_history SET likes_count = 99 WHERE post_id = ?').run(postId), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM posts WHERE id = ?').run(postId), /FOREIGN KEY/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing post and media records survive the upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-upgrade-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))");
    db.prepare("INSERT INTO schema_migrations (name) VALUES ('001_initial.sql')").run();
    db.prepare("INSERT INTO competitors (id, username) VALUES (1, 'brand')").run();
    db.prepare("INSERT INTO posts (id, shortcode, url, kind, status, collected_at) VALUES (1, 'legacy', 'https://example.test/p/legacy', 'reel', 'complete', '2024-01-01T00:00:00.000Z')").run();
    db.prepare('INSERT INTO competitor_posts (competitor_id, post_id) VALUES (1, 1)').run();
    db.prepare("INSERT INTO raw_post_snapshots (post_id, raw_json) VALUES (1, '{\"legacy\":true}')").run();
    db.prepare("INSERT INTO media_assets (post_id, ordinal, source_url, status) VALUES (1, 0, 'https://example.test/video.mp4', 'complete')").run();
    assert.equal(migrate(db), 14);
    const post = db.prepare('SELECT competitor_id, type, extraction_status, first_scraped_at, created_at FROM posts WHERE id = 1').get();
    assert.equal(post.competitor_id, 1);
    assert.equal(post.type, 'reel');
    assert.equal(post.extraction_status, 'complete');
    assert.equal(post.first_scraped_at, '2024-01-01T00:00:00.000Z');
    assert.ok(post.created_at);
    assert.equal(db.prepare('SELECT count(*) AS count FROM raw_post_snapshots WHERE post_id = 1').get().count, 1);
    assert.equal(db.prepare('SELECT download_status FROM media WHERE post_id = 1 AND position = 0').get().download_status, 'complete');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
