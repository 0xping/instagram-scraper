import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatCompetitors, listCompetitors, normalizeUsername, parseCompetitorList } from '../dist/competitors.js';
import { migrate, openDatabase, registerCompetitors } from '../dist/db.js';

test('normalizeUsername accepts every supported form', () => {
  const cases = {
    'competitor1': 'competitor1',
    '@competitor1': 'competitor1',
    '  @Competitor1  \t': 'competitor1',
    'https://instagram.com/competitor3/': 'competitor3',
    'https://www.instagram.com/competitor4': 'competitor4',
    'http://instagram.com/Competitor5?igsh=abc&utm=1': 'competitor5',
    'https://www.instagram.com/competitor6/?hl=en#top': 'competitor6',
    'instagram.com/competitor7': 'competitor7',
    'www.instagram.com/competitor8/': 'competitor8',
    'https://www.instagram.com/competitor9/reels/': 'competitor9',
    'https://www.instagram.com/@competitor10/': 'competitor10',
    'https://m.instagram.com/some.name_1': 'some.name_1',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeUsername(input), expected, input);
});

test('normalizeUsername skips blank and comment lines', () => {
  for (const line of ['', '   ', '\t', '# comment', '   # indented comment', '#@user']) {
    assert.equal(normalizeUsername(line), null, JSON.stringify(line));
  }
});

test('normalizeUsername rejects things that are not profiles', () => {
  const bad = [
    'two words', '@@double', 'bad!name', 'a'.repeat(31), '@',
    'https://www.instagram.com/', 'https://www.instagram.com/p/Cabc123/',
    'https://www.instagram.com/reel/Cabc123/', 'https://www.instagram.com/explore/',
    'https://example.com/competitor', 'https://notinstagram.com/user',
  ];
  for (const line of bad) assert.throws(() => normalizeUsername(line), /Invalid|Not a profile/, line);
});

test('parseCompetitorList dedupes in first-seen order and handles CRLF and BOM', () => {
  const text = String.fromCharCode(0xfeff) + '# my list\r\n@Competitor1\r\n\r\ncompetitor2\r\nhttps://instagram.com/competitor1/\r\nhttps://www.instagram.com/competitor4\r\n COMPETITOR2 \r\n';
  assert.deepEqual(parseCompetitorList(text), ['competitor1', 'competitor2', 'competitor4']);
  assert.deepEqual(parseCompetitorList(''), []);
});

test('parseCompetitorList reports every bad line with its line number', () => {
  assert.throws(
    () => parseCompetitorList('good\nbad name\n# ok\nhttps://www.instagram.com/p/xyz/\n'),
    (error) => /line 2:/.test(error.message) && /line 4:/.test(error.message) && !/line 1:/.test(error.message),
  );
});

test('import is idempotent and list reports counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instagram-competitors-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    const usernames = parseCompetitorList('@alpha\nBeta\nhttps://instagram.com/gamma/\n');
    assert.equal(registerCompetitors(db, usernames), 3);
    assert.equal(registerCompetitors(db, usernames), 0);
    assert.equal(registerCompetitors(db, parseCompetitorList('ALPHA\n@beta\ndelta')), 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM competitors').get().count, 4);

    const alpha = db.prepare("SELECT id FROM competitors WHERE username = 'alpha'").get().id;
    const add = db.prepare("INSERT INTO posts (competitor_id, shortcode, url, extraction_status) VALUES (?, ?, 'https://example.test', ?)");
    add.run(alpha, 'a1', 'complete');
    add.run(alpha, 'a2', 'complete');
    add.run(alpha, 'a3', 'pending');
    db.prepare("UPDATE competitors SET account_status = 'active', last_scraped_at = '2026-01-02T03:04:05.000Z' WHERE id = ?").run(alpha);

    const rows = listCompetitors(db);
    assert.deepEqual(rows.map((r) => r.username), ['alpha', 'beta', 'delta', 'gamma']);
    assert.deepEqual(rows[0], { username: 'alpha', status: 'active', discovered: 3, processed: 2, lastScrapedAt: '2026-01-02T03:04:05.000Z' });
    assert.deepEqual(rows[1], { username: 'beta', status: 'unknown', discovered: 0, processed: 0, lastScrapedAt: null });
    const table = formatCompetitors(rows).split('\n');
    assert.match(table[0], /^USERNAME\s+STATUS\s+DISCOVERED\s+PROCESSED\s+LAST SCRAPE$/);
    assert.match(table[1], /^alpha\s+active\s+3\s+2\s+2026-01-02T03:04:05.000Z$/);
    assert.match(table[2], /^beta\s+unknown\s+0\s+0\s+never$/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
