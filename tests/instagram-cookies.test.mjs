import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInstagramCookies, saveCookieSession } from '../dist/instagram-cookies.js';

test('reads cookies however the browser hands them over', () => {
  const byName = (text) => Object.fromEntries(parseInstagramCookies(text).map((c) => [c.name, c]));

  const oneLine = byName('Cookie: sessionid="70%3Aabc"; ds_user_id=42; csrftoken=tok');
  assert.deepEqual(Object.keys(oneLine).sort(), ['csrftoken', 'ds_user_id', 'sessionid']);
  assert.equal(oneLine.sessionid.value, '70%3Aabc', 'the value stays encoded, and quotes are dropped');
  assert.equal(oneLine.sessionid.domain, '.instagram.com');
  assert.equal(oneLine.sessionid.httpOnly, true);
  assert.equal(oneLine.sessionid.secure, true);
  assert.ok(oneLine.sessionid.expires > Date.now() / 1000);

  const columns = byName('sessionid\t70%3Aabc\nds_user_id\t42\n');
  assert.equal(columns.sessionid.value, '70%3Aabc');
  assert.equal(columns.ds_user_id.value, '42');
});

test('refuses anything without a session cookie', () => {
  assert.throws(() => parseInstagramCookies('csrftoken=tok; mid=xyz'), /sessionid/);
  assert.throws(() => parseInstagramCookies(''), /sessionid/);
});

test('keeps the old session until the new cookies are proven', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-cookies-'));
  const statePath = join(dir, 'browser', 'instagram-state.json');
  try {
    const first = saveCookieSession(statePath, parseInstagramCookies('sessionid=one'));
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).cookies[0].value, 'one');

    const restore = saveCookieSession(statePath, parseInstagramCookies('sessionid=two'));
    restore();
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).cookies[0].value, 'one', 'a failed paste puts the working session back');

    first();  // there was nothing before the first one: rolling it back leaves no session
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
