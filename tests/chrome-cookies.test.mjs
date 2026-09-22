import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { readChromeInstagramCookies } from '../dist/chrome-cookies.js';

const KEY = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');   // Chrome's fallback key, no keyring involved

/** Encrypts the way Chrome 127+ does: v10, AES-128-CBC, and the domain's hash in front of the value. */
function chromeEncrypt(value, hostKey) {
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

function writeProfile(base, profile, rows) {
  const dir = join(base, profile, 'Network');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'Cookies'));
  db.exec(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
           path TEXT, is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER)`);
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.host, row.name, row.plain ?? '', row.encrypted ?? null, '/', 1, row.httpOnly ? 1 : 0, row.expires ?? 0);
  db.close();
}

test('reads the Instagram session out of the Chrome profile that has one', () => {
  const base = mkdtempSync(join(tmpdir(), 'chrome-'));
  try {
    writeProfile(base, 'Default', [{ host: '.instagram.com', name: 'mid', plain: 'not-logged-in' }]);
    writeProfile(base, 'Profile 1', [
      { host: '.instagram.com', name: 'sessionid', encrypted: chromeEncrypt('70%3Asecret', '.instagram.com'), httpOnly: true },
      { host: '.instagram.com', name: 'csrftoken', plain: 'tok' },
      { host: '.facebook.com', name: 'ignored', plain: 'other-site' },
    ]);

    const { profile, cookies } = readChromeInstagramCookies(base, KEY);
    assert.equal(profile, 'Profile 1', 'the profile without a session is passed over');
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['csrftoken', 'sessionid'], 'only instagram.com cookies come back');
    assert.equal(byName.sessionid.value, '70%3Asecret', 'decrypted, with the domain hash stripped');
    assert.equal(byName.sessionid.httpOnly, true);
    assert.ok(byName.sessionid.expires > Date.now() / 1000, 'a session cookie still gets a usable expiry');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('says so when no Chrome profile is logged in', () => {
  const base = mkdtempSync(join(tmpdir(), 'chrome-'));
  try {
    writeProfile(base, 'Default', [{ host: '.instagram.com', name: 'mid', plain: 'anonymous' }]);
    assert.throws(() => readChromeInstagramCookies(base, KEY), /No Chrome profile is logged in/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
