import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captionEntities, dashDuration, extractPost, fieldsFromMedia, findMediaObjects, mediaItems } from '../dist/post-extract.js';
import { MAX_FAILED_RUNS, saveExtracted, saveFailedAttempt, savePermanent, selectPosts } from '../dist/post-scraper.js';
import { migrate, openDatabase } from '../dist/db.js';

// Shapes trimmed from real xdt_api__v1__media__shortcode__web_info items.
const reel = {
  code: 'DNyT2xh2IOA', pk: '3707112770195981184', id: '3707112770195981184_75667380781', media_type: 2, product_type: 'clips',
  taken_at: 1756142502, like_count: 597, comment_count: 11, view_count: null, like_and_view_counts_disabled: false,
  original_width: 1080, original_height: 1920, user: { username: 'Wear212club' },
  caption: { text: 'Good vibes 🍃\n\n🎥 : @kreativeaub \n\n#212club #MoroccanCulture' },
  usertags: { in: [{ user: { username: 'mizeuz7' } }, { user: { username: 'kreativeaub' } }] },
  coauthor_producers: [{ username: 'kreativeaub' }], location: { name: 'Bariz Street Food ', pk: 1 },
  clips_metadata: { audio_type: 'original_sounds', music_info: null, original_sound_info: { original_audio_title: 'Original audio', ig_artist: { username: 'wear212club' } } },
  video_dash_manifest: '<MPD mediaPresentationDuration="PT24.427S" minBufferTime="PT1S">',
  image_versions2: { candidates: [{ url: 'https://cdn.example/thumb.jpg', width: 1080, height: 1920 }] },
  video_versions: [{ url: 'https://cdn.example/v.mp4', width: 720, height: 1280 }],
};
const carousel = {
  code: 'DcwFSjaDQ6y', pk: '3976701736169311922', media_type: 8, product_type: 'carousel_container', taken_at: 1788279810,
  like_count: 3, comment_count: 3, like_and_view_counts_disabled: true, carousel_media_count: 2, comments_disabled: false,
  caption: { text: 'CHAPTER05 🍽️' },
  carousel_media: [
    { pk: '1', media_type: 1, original_width: 1620, original_height: 2160, accessibility_caption: 'Photo of a hoodie',
      image_versions2: { candidates: [{ url: 'https://cdn.example/1.jpg' }] }, usertags: { in: [{ user: { username: 'model_a' } }] } },
    { pk: '2', media_type: 2, original_width: 720, original_height: 1280, video_versions: [{ url: 'https://cdn.example/2.mp4' }],
      video_dash_manifest: 'mediaPresentationDuration="PT1M4.5S"' },
  ],
};
const music = { code: 'Music00001', media_type: 2, product_type: 'clips', taken_at: 1,
  clips_metadata: { audio_type: 'licensed_music', music_info: { music_asset_info: { title: 'Song Name', display_artist: 'Artist' } } } };

const snapshot = (o = {}) => ({
  url: 'https://www.instagram.com/p/X/', httpStatus: 200, title: '(2) Instagram', meta: {}, jsonTexts: [],
  dom: { caption: null, datetime: null, likesText: null, videoDuration: null, hasVideo: false, bodyText: '' }, ...o,
});

test('reel: identity, content, metrics, audio, duration from the DASH manifest', () => {
  const f = fieldsFromMedia(reel);
  assert.equal(f.instagramPostId, '3707112770195981184');
  assert.equal(f.type, 'reel');
  assert.equal(f.ownerUsername, 'wear212club');
  assert.equal(f.publishedAt, '2025-08-25T17:21:42.000Z');
  assert.deepEqual(f.taggedUsers, ['mizeuz7', 'kreativeaub']);
  assert.deepEqual(f.coauthors, ['kreativeaub']);
  assert.equal(f.location, 'Bariz Street Food ');
  assert.deepEqual([f.likesCount, f.likesHidden, f.commentsCount, f.viewsCount, f.playsCount], [597, false, 11, null, null]);
  assert.deepEqual([f.audioTitle, f.audioArtist, f.audioType], ['Original audio', 'wear212club', 'original_sounds']);
  assert.equal(f.durationSeconds, 24.427);
  assert.equal(f.thumbnailUrl, 'https://cdn.example/thumb.jpg');
  assert.deepEqual([f.width, f.height, f.carouselCount], [1080, 1920, null]);
  const [item] = mediaItems(reel);
  assert.deepEqual([item.mediaType, item.sourceUrl, item.durationSeconds, item.raw, item.width, item.height], ['video', 'https://cdn.example/v.mp4', 24.427, null, 720, 1280]);
  assert.deepEqual([fieldsFromMedia(music).audioTitle, fieldsFromMedia(music).audioArtist], ['Song Name', 'Artist']);
});

test('carousel: hidden likes become null, per-item media with alt text, tags merged from slides', () => {
  const f = fieldsFromMedia(carousel);
  assert.equal(f.type, 'carousel');
  assert.equal(f.likesCount, null, 'hidden counts are not published even though the JSON has one');
  assert.equal(f.likesHidden, true);
  assert.equal(f.commentsCount, 3);
  assert.equal(f.carouselCount, 2);
  assert.deepEqual(f.taggedUsers, ['model_a']);
  const items = mediaItems(carousel);
  assert.deepEqual(items.map((i) => [i.position, i.mediaType, i.width, i.altText, i.durationSeconds]), [
    [0, 'image', 1620, 'Photo of a hoodie', null], [1, 'video', 720, null, 64.5],
  ]);
  assert.equal(items[0].raw.pk, '1');
});

test('image posts and unknown shapes', () => {
  assert.equal(fieldsFromMedia({ code: 'x', media_type: 1, taken_at: 1 }).type, 'image');
  const empty = fieldsFromMedia({ code: 'x' });
  assert.equal(empty.type, 'unknown');
  assert.equal(empty.caption, null);
  assert.deepEqual(empty.taggedUsers, []);
});

test('captionEntities: any script, case-folded, deduped; emails, URLs and numbers are not entities', () => {
  const caption = 'Drop #1 is live 🔥 #Streetwear #streetwear #مغرب #東京 #café_paris\nPhoto @kreativeaub. with @Brand.Name_ and @brand.name_\n' +
    'mail me at shop@example.com or see https://x.com/#anchor #123 &#39;';
  assert.deepEqual(captionEntities(caption), {
    hashtags: ['streetwear', 'مغرب', '東京', 'café_paris'],
    mentions: ['kreativeaub', 'brand.name_'],
  });
  assert.deepEqual(captionEntities(null), { hashtags: [], mentions: [] });
});

test('extremely long captions are kept whole and still parsed', () => {
  const long = ('ligne ✨ ' .repeat(20_000)) + ' #fin @auteur';
  const m = { ...reel, caption: { text: long } };
  const result = extractPost(snapshot({ jsonTexts: [JSON.stringify({ items: [m] })] }), 'DNyT2xh2IOA');
  assert.equal(result.fields.caption.length, long.length);
  assert.deepEqual(result.fields.hashtags, ['fin']);
  assert.deepEqual(result.fields.mentions, ['auteur']);
});

test('dashDuration parses hours, minutes, seconds and rejects junk', () => {
  assert.equal(dashDuration('x mediaPresentationDuration="PT1H2M3.5S" y'), 3723.5);
  assert.equal(dashDuration('mediaPresentationDuration="PT8.458S"'), 8.458);
  assert.equal(dashDuration('mediaPresentationDuration="PT"'), null);
  assert.equal(dashDuration(null), null);
});

test('findMediaObjects matches the shortcode and prefers the richest object', () => {
  const feed = { edges: [{ node: { media: { code: 'OTHERREEL1', taken_at: 1, like_count: 999 } } }, { node: { media: { code: 'DNyT2xh2IOA', taken_at: 1 } } }] };
  const found = findMediaObjects([JSON.stringify(feed), 'for (;;);' + JSON.stringify({ items: [reel] }), 'not json'], 'DNyT2xh2IOA');
  assert.equal(found.length, 2);
  assert.equal(found[0].pk, reel.pk);
});

test('extractPost: JSON wins; DOM and meta fill gaps and are labelled', () => {
  const r = extractPost(snapshot({ jsonTexts: [JSON.stringify({ items: [reel] })], dom: { ...snapshot().dom, caption: 'other', likesText: '5 likes' } }), 'DNyT2xh2IOA');
  assert.equal(r.availability, 'available');
  assert.equal(r.sources.caption, 'json');
  assert.equal(r.fields.likesCount, 597);
  assert.deepEqual(r.fields.hashtags, ['212club', 'moroccanculture']);
  assert.equal(r.raw.pk, reel.pk);

  const meta = { 'og:type': 'article', 'og:url': 'https://www.instagram.com/brand/reel/Fallback01/', 'og:image': 'https://cdn.example/og.jpg',
    'og:title': 'Brand on Instagram: "Hello #world"' };
  const fb = extractPost(snapshot({ meta, dom: { ...snapshot().dom, datetime: '2026-01-02T03:04:05.000Z', likesText: '1,234 likes', videoDuration: 12.5, hasVideo: true } }), 'Fallback01');
  assert.equal(fb.availability, 'available');
  assert.deepEqual([fb.fields.type, fb.fields.ownerUsername, fb.fields.caption, fb.fields.likesCount, fb.fields.durationSeconds, fb.fields.publishedAt],
    ['reel', 'brand', 'Hello #world', 1234, 12.5, '2026-01-02T03:04:05.000Z']);
  assert.deepEqual([fb.sources.caption, fb.sources.likesCount, fb.sources.hashtags], ['meta', 'dom', 'caption']);
  assert.equal(fb.raw, null);
  assert.deepEqual(fb.items, []);
});

test('extractPost: deleted, restricted and unrecognized pages', () => {
  assert.equal(extractPost(snapshot({ dom: { ...snapshot().dom, bodyText: "Sorry, this page isn't available." } }), 'X').availability, 'unavailable');
  assert.equal(extractPost(snapshot({ httpStatus: 404 }), 'X').availability, 'unavailable');
  assert.equal(extractPost(snapshot({ dom: { ...snapshot().dom, bodyText: 'This account is private\nFollow to see their photos' } }), 'X').availability, 'restricted');
  assert.throws(() => extractPost(snapshot(), 'X'), (e) => e.type === 'unrecognized_page' && e.retryable === true);
});

test('selection, saving and the retry cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-posts-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const cid = Number(db.prepare("INSERT INTO competitors (username) VALUES ('brand')").run().lastInsertRowid);
    const add = (code) => Number(db.prepare("INSERT INTO posts (competitor_id, shortcode, url, discovery_status) VALUES (?, ?, ?, 'complete')").run(cid, code, `https://www.instagram.com/p/${code}/`).lastInsertRowid);
    const [a, b, c] = [add('AAAAA1'), add('BBBBB1'), add('CCCCC1')];
    const job = Number(db.prepare("INSERT INTO scrape_jobs (competitor_id, job_type, status) VALUES (?, 'posts', 'running')").run(cid).lastInsertRowid);

    saveExtracted(db, a, job, fieldsFromMedia(carousel), mediaItems(carousel), carousel, '2026-01-01T00:00:00.000Z');
    saveExtracted(db, a, job, fieldsFromMedia(carousel), mediaItems(carousel), carousel, '2026-01-01T00:00:01.000Z'); // same-job retry
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(a);
    assert.deepEqual([row.extraction_status, row.discovery_status, row.availability, row.type, row.likes_count, row.likes_hidden, row.carousel_count],
      ['complete', 'complete', 'available', 'carousel', null, 1, 2]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM post_metrics_history WHERE post_id = ?').get(a).n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM media WHERE post_id = ?').get(a).n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw_post_snapshots WHERE post_id = ?').get(a).n, 1, 'unchanged raw_json adds no snapshot');
    assert.equal(JSON.parse(row.raw_json).pk, carousel.pk);

    const sel = (force = false) => selectPosts(db, cid, force, null).map((p) => p.shortcode);
    assert.deepEqual(sel(), ['BBBBB1', 'CCCCC1'], 'complete posts are skipped');
    assert.deepEqual(sel(true), ['AAAAA1', 'BBBBB1', 'CCCCC1'], '--force includes them');

    const postB = { id: b, shortcode: 'BBBBB1', url: 'u', status: 'pending' };
    savePermanent(db, postB, cid, 'unavailable', 'gone', '2026-01-01T00:00:00.000Z');
    assert.deepEqual(sel(), ['CCCCC1'], 'deleted posts are not retried');

    const postC = { id: c, shortcode: 'CCCCC1', url: 'u', status: 'pending' };
    const failure = { type: 'timeout', message: 'slow', retryable: true, attempts: 3, url: 'u', debugFiles: [] };
    saveFailedAttempt(db, postC, cid, { ...failure, type: 'session_expired' }, false);
    assert.equal(db.prepare('SELECT extraction_status AS s, extraction_attempts AS n FROM posts WHERE id = ?').get(c).s, 'pending', 'batch-stopping errors do not blame the post');
    for (let i = 0; i < MAX_FAILED_RUNS; i += 1) {
      assert.deepEqual(sel(), ['CCCCC1']);
      saveFailedAttempt(db, postC, cid, failure, true);
    }
    assert.deepEqual(sel(), [], `given up after ${MAX_FAILED_RUNS} failed runs`);
    assert.deepEqual(sel(true), ['AAAAA1', 'BBBBB1', 'CCCCC1']);
    saveExtracted(db, c, job, fieldsFromMedia(reel), mediaItems(reel), reel, '2026-01-02T00:00:00.000Z');
    assert.equal(db.prepare('SELECT extraction_attempts AS n FROM posts WHERE id = ?').get(c).n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM scrape_errors WHERE post_id = ? AND resolved_at IS NULL").get(c).n, 0, 'success resolves old errors');

    // A later refresh that only sees page fallbacks (no media object) fills gaps but never erases or downgrades.
    const full = db.prepare('SELECT * FROM posts WHERE id = ?').get(c);
    const job2 = Number(db.prepare("INSERT INTO scrape_jobs (competitor_id, job_type, status) VALUES (?, 'posts', 'running')").run(cid).lastInsertRowid);
    const degraded = extractPost(snapshot({ meta: { 'og:type': 'video', 'og:url': 'https://www.instagram.com/wear212club/reel/DNyT2xh2IOA/', 'og:title': 'x on Instagram: "Good vibes"' } }), 'DNyT2xh2IOA');
    saveExtracted(db, c, job2, degraded.fields, degraded.items, degraded.raw, '2026-01-03T00:00:00.000Z');
    const after = db.prepare('SELECT * FROM posts WHERE id = ?').get(c);
    for (const key of ['caption', 'published_at', 'location', 'tagged_users_json', 'likes_count', 'duration_seconds', 'audio_title', 'width', 'raw_json']) {
      assert.deepEqual(after[key], full[key], `${key} kept`);
    }
    assert.equal(after.last_scraped_at, '2026-01-03T00:00:00.000Z');
    assert.equal(db.prepare('SELECT count(*) AS n FROM post_metrics_history WHERE post_id = ? AND scrape_job_id = ?').get(c, job2).n, 0, 'no empty metrics observation');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
