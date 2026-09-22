import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractProfile, parseCount, unwrapRedirect } from '../dist/profile-extract.js';
import { saveFailure, saveProfile, startJob } from '../dist/profile-scraper.js';
import { migrate, openDatabase } from '../dist/db.js';

// Trimmed from a real server-rendered profile page (xig_user_by_username), plus a decoy suggested account.
const inlineJson = JSON.stringify({ require: [['x', { __bbox: { result: { data: {
  xig_user_by_username: {
    pk: '4785887276', username: 'corteiz', profile_pic_url: 'https://cdn.example/pic150.jpg', is_private: false,
    biography: 'rulestheworld.', full_name: 'CORTEIZ', is_verified: false, follower_count: 1660019, following_count: 1,
    all_media_count: null, bio_links: [{ url: 'http://www.corteiz.com', lynx_url: 'https://l.instagram.com/?u=x' }],
    suggested: [{ username: 'other', full_name: 'Decoy', follower_count: 999999999, is_verified: true, biography: 'no' }],
  },
} } } }]] });

function snapshot(overrides = {}) {
  return {
    url: 'https://www.instagram.com/corteiz/', httpStatus: 200, title: 'CORTEIZ (@corteiz) • Instagram photos and videos',
    meta: {}, jsonTexts: [],
    dom: { followers: null, following: null, headerText: null, verified: false, externalHref: null, avatarSrc: null, headings: [], bodyText: '' },
    ...overrides,
  };
}

const ogMeta = {
  'og:type': 'profile',
  'og:image': 'https://cdn.example/pic100.jpg',
  'og:title': 'CORTEIZ (@corteiz) • Instagram photos and videos',
  'og:description': '2M Followers, 1 Following, 393 Posts - See Instagram photos and videos from CORTEIZ (@corteiz)',
  description: '2M Followers, 1 Following, 393 Posts - CORTEIZ (@corteiz) on Instagram: "rulestheworld."',
};

test('parseCount handles separators, suffixes and surrounding words', () => {
  const cases = [
    ['1,660,019', 1660019], ['1,660,019 followers', 1660019], ['1.6M', 1600000], ['2M Followers', 2000000],
    ['12,5 k', 12500], ['1.234', 1234], ['393 posts', 393], ['0', 0], ['1 234 567', 1234567], ['3.2B', 3200000000],
    [null, null], ['', null], ['followers', null],
  ];
  for (const [input, expected] of cases) assert.equal(parseCount(input), expected, String(input));
});

test('unwrapRedirect returns the outbound target and ignores Instagram links', () => {
  assert.equal(unwrapRedirect('https://l.instagram.com/?u=http%3A%2F%2Fwww.corteiz.com%2F&e=abc'), 'http://www.corteiz.com/');
  assert.equal(unwrapRedirect('https://shop.example/x'), 'https://shop.example/x');
  assert.equal(unwrapRedirect('/corteiz/followers/'), null);
  assert.equal(unwrapRedirect(null), null);
});

test('JSON is preferred, decoy users are ignored, missing fields fall back or become null', () => {
  const result = extractProfile(snapshot({ jsonTexts: [inlineJson], meta: ogMeta }), 'corteiz');
  assert.equal(result.status, 'active');
  assert.deepEqual(result.fields, {
    displayName: 'CORTEIZ', bio: 'rulestheworld.', profileImageUrl: 'https://cdn.example/pic150.jpg',
    externalUrl: 'http://www.corteiz.com', followersCount: 1660019, followingCount: 1,
    postsCount: 393, verified: false, category: null, isPrivate: false,
  });
  assert.equal(result.sources.followersCount, 'json');
  assert.equal(result.sources.postsCount, 'meta'); // all_media_count was null in JSON
  assert.equal(result.rawUser.pk, '4785887276');
});

test('older GraphQL user shape is mapped', () => {
  const legacy = JSON.stringify({ graphql: { user: {
    username: 'brand', full_name: 'Brand', edge_followed_by: { count: 50 }, edge_follow: { count: 7 },
    edge_owner_to_timeline_media: { count: 12 }, is_private: true, is_verified: true, category_name: 'Clothing (Brand)',
    external_url: 'https://brand.example', profile_pic_url_hd: 'https://cdn.example/hd.jpg', profile_pic_url: 'https://cdn.example/sd.jpg',
  } } });
  const result = extractProfile(snapshot({ jsonTexts: ['for (;;);' + legacy] }), 'Brand');
  assert.equal(result.status, 'private');
  assert.deepEqual([result.fields.followersCount, result.fields.followingCount, result.fields.postsCount], [50, 7, 12]);
  assert.equal(result.fields.category, 'Clothing (Brand)');
  assert.equal(result.fields.profileImageUrl, 'https://cdn.example/hd.jpg');
  assert.equal(result.fields.verified, true);
});

test('DOM beats meta; meta alone still yields a profile when JSON is gone', () => {
  const dom = { ...snapshot().dom, followers: '1,660,019', following: '1', headerText: 'corteiz 393 posts 1.6M followers', verified: true,
    externalHref: 'https://l.instagram.com/?u=https%3A%2F%2Fshop.example%2F' };
  const withDom = extractProfile(snapshot({ meta: ogMeta, dom }), 'corteiz');
  assert.equal(withDom.fields.followersCount, 1660019);
  assert.equal(withDom.sources.followersCount, 'dom');
  assert.equal(withDom.fields.externalUrl, 'https://shop.example/');
  assert.equal(withDom.fields.verified, true);

  const metaOnly = extractProfile(snapshot({ meta: ogMeta }), 'corteiz');
  assert.equal(metaOnly.status, 'active');
  assert.equal(metaOnly.fields.displayName, 'CORTEIZ');
  assert.equal(metaOnly.fields.bio, 'rulestheworld.');
  assert.equal(metaOnly.fields.followersCount, 2000000);
  assert.equal(metaOnly.fields.verified, null);
  assert.equal(metaOnly.fields.isPrivate, null);
});

test('private text is a fallback when JSON has no is_private', () => {
  const dom = { ...snapshot().dom, headings: ['This account is private'] };
  assert.equal(extractProfile(snapshot({ meta: ogMeta, dom }), 'corteiz').status, 'private');
});

test('unavailable needs a positive signal; an unrecognized page is an error, not a deletion', () => {
  const gone = snapshot({ title: "Profile isn't available • Instagram" });
  assert.equal(extractProfile(gone, 'corteiz').status, 'unavailable');
  assert.equal(extractProfile(snapshot({ title: 'x', httpStatus: 404 }), 'corteiz').status, 'unavailable');
  // Logged-in variant: generic title, message in body text rather than a heading.
  const loggedIn = snapshot({ title: '(2) Instagram', dom: { ...snapshot().dom, bodyText: "Home\nSorry, this page isn't available.\nThe link you followed may be broken" } });
  assert.equal(extractProfile(loggedIn, 'corteiz').status, 'unavailable');
  assert.throws(() => extractProfile(snapshot({ title: 'Instagram' }), 'corteiz'), (error) => error.type === 'unrecognized_page' && error.retryable);
});

test('saveProfile appends a snapshot and updates latest fields; failures leave fields alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-profile-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const id = Number(db.prepare("INSERT INTO competitors (username) VALUES ('corteiz')").run().lastInsertRowid);
    const extraction = extractProfile(snapshot({ jsonTexts: [inlineJson], meta: ogMeta }), 'corteiz');
    const result = { ...extraction, username: 'corteiz', profileUrl: 'https://www.instagram.com/corteiz/', profileImagePath: 'raw/media/profiles/corteiz/a.jpg',
      collectedAt: '2026-01-01T00:00:00.000Z', finalUrl: 'https://www.instagram.com/corteiz/', httpStatus: 200, attempts: 1 };

    const failedJob = startJob(db, id);
    saveFailure(db, id, failedJob, { type: 'timeout', message: 'slow', retryable: true, attempts: 3, url: result.profileUrl, debugFiles: ['debug/profile/x.png'] }, false);
    let row = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
    assert.equal(row.account_status, 'unknown');
    assert.equal(row.last_scraped_at, null);
    assert.match(db.prepare('SELECT error_message FROM scrape_errors').get().error_message, /debug\/profile\/x\.png/);
    assert.equal(db.prepare('SELECT status FROM scrape_jobs WHERE id = ?').get(failedJob).status, 'failed');

    saveProfile(db, id, startJob(db, id), result);
    row = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
    assert.equal(row.account_status, 'active');
    assert.equal(row.followers_count, 1660019);
    assert.equal(row.verified, 0);
    assert.equal(row.category, null);
    assert.equal(row.first_scraped_at, '2026-01-01T00:00:00.000Z');
    assert.equal(db.prepare('SELECT count(*) AS n FROM scrape_errors WHERE resolved_at IS NULL').get().n, 0);

    saveProfile(db, id, startJob(db, id), { ...result, status: 'unavailable', collectedAt: '2026-02-01T00:00:00.000Z' });
    row = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
    assert.equal(row.account_status, 'unavailable');
    assert.equal(row.followers_count, 1660019, 'last known fields are kept');
    assert.equal(row.first_scraped_at, '2026-01-01T00:00:00.000Z');
    assert.equal(row.last_scraped_at, '2026-02-01T00:00:00.000Z');
    const snapshots = db.prepare('SELECT raw_json FROM raw_profile_snapshots WHERE competitor_id = ? ORDER BY id').all(id).map((r) => JSON.parse(r.raw_json));
    assert.deepEqual(snapshots.map((s) => s.account_status), ['active', 'unavailable']);
    assert.equal(snapshots[0].user.pk, '4785887276');
    const fallback = extractProfile(snapshot({ meta: ogMeta }), 'corteiz');
    saveProfile(db, id, startJob(db, id), { ...result, ...fallback, collectedAt: '2026-03-01T00:00:00.000Z' });
    row = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
    assert.equal(row.followers_count, 1660019, 'rounded fallback counts do not replace exact counts');
    assert.equal(row.bio, extraction.fields.bio, 'missing fallback fields do not erase observed fields');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
