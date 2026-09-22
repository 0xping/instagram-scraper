import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { InstagramCookie } from './instagram-cookies.js';

/** Chrome counts cookie expiry in microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET = 11_644_473_600;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const IV = Buffer.alloc(16, ' ');
const PASTE_INSTEAD = "If this keeps failing, run it with --paste and copy the cookies across yourself.";

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer | null;
  path: string;
  is_secure: number;
  is_httponly: number;
  expires_utc: number;
}

export interface ChromeCookies {
  /** Which Chrome profile they came from, as Chrome's folder names it. */
  profile: string;
  cookies: InstagramCookie[];
}

/** Where Chrome keeps its profiles, per platform. */
function chromeDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin': return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'linux': return join(home, '.config', 'google-chrome');
    case 'win32': throw new Error(`Reading Chrome's cookies is not supported on Windows: it locks them to the browser itself. Run this with --paste instead.`);
    default: throw new Error(`Reading Chrome's cookies is not supported on this system. Run this with --paste instead.`);
  }
}

/**
 * The key Chrome encrypts cookie values with. On macOS it lives in the Keychain, so the first run shows
 * the system's "wants to use your keychain" box: that prompt is macOS asking, and Allow is the answer.
 */
function cookieKey(): Buffer {
  if (platform() === 'darwin') {
    let secret: string;
    try {
      secret = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(`macOS did not hand over Chrome's key. Click Allow on the keychain box when it appears, and make sure you are logged in to the same Mac user that runs Chrome. ${PASTE_INSTEAD}`);
    }
    return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
  }
  // Linux: the desktop keyring if it answers, otherwise Chrome's documented fallback password.
  for (const [command, args] of [['secret-tool', ['lookup', 'application', 'chrome']], ['secret-tool', ['lookup', 'application', 'chromium']]] as const) {
    try {
      const secret = execFileSync(command, [...args], { encoding: 'utf8' }).trim();
      if (secret) return pbkdf2Sync(secret, 'saltysalt', 1, 16, 'sha1');
    } catch { /* no keyring, or nothing stored: fall through */ }
  }
  return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

/** AES-128-CBC, with the two shapes Chrome has used for what sits inside. */
function decryptValue(encrypted: Buffer, key: Buffer, hostKey: string): string {
  const version = encrypted.subarray(0, 3).toString('ascii');
  if (version !== 'v10' && version !== 'v11') throw new Error(`unexpected cookie encryption (${version})`);
  const decipher = createDecipheriv('aes-128-cbc', key, IV);
  decipher.setAutoPadding(false);   // one unreadable row must not abort the whole read
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const padding = plain.at(-1) ?? 0;
  if (padding > 0 && padding <= 16 && padding <= plain.length) plain = plain.subarray(0, plain.length - padding);
  // Chrome 127 and newer put a hash of the cookie's domain in front of the value.
  const domainHash = createHash('sha256').update(hostKey).digest();
  if (plain.length >= 32 && plain.subarray(0, 32).equals(domainHash)) plain = plain.subarray(32);
  return plain.toString('utf8');
}

/** Every profile in the folder, newest layout first: Chrome moved Cookies into Network/ years ago. */
function cookieFiles(base: string): { profile: string; file: string }[] {
  if (!existsSync(base)) throw new Error(`Google Chrome was not found (looked in ${base}). Open Instagram in Chrome once, or run this with --paste.`);
  const profiles = readdirSync(base).filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
  const found: { profile: string; file: string }[] = [];
  for (const profile of profiles) {
    for (const file of [join(base, profile, 'Network', 'Cookies'), join(base, profile, 'Cookies')]) {
      if (existsSync(file)) { found.push({ profile, file }); break; }
    }
  }
  if (!found.length) throw new Error(`No Chrome profile in ${base} has any cookies yet.`);
  return found;
}

/** Reads a copy of the file: Chrome keeps the original open, and a copy is never at risk from this. */
function readProfile(file: string, key: Buffer): InstagramCookie[] {
  const scratch = mkdtempSync(join(tmpdir(), 'ig-chrome-'));
  try {
    const copy = join(scratch, 'Cookies');
    copyFileSync(file, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${file}${suffix}`)) copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
    }
    const db = new Database(copy);
    try {
      const rows = db.prepare<[], CookieRow>(
        `SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, expires_utc
           FROM cookies WHERE host_key LIKE '%instagram.com'`,
      ).all();
      const fallbackExpiry = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
      const cookies: InstagramCookie[] = [];
      for (const row of rows) {
        let value = row.value;
        if (!value && row.encrypted_value?.length) {
          try { value = decryptValue(row.encrypted_value, key, row.host_key); } catch { continue; }
        }
        if (!value) continue;
        const expires = row.expires_utc > 0 ? Math.floor(row.expires_utc / 1_000_000) - CHROME_EPOCH_OFFSET : fallbackExpiry;
        cookies.push({
          name: row.name,
          value,
          domain: row.host_key,
          path: row.path || '/',
          expires: expires > Date.now() / 1000 ? expires : fallbackExpiry,
          httpOnly: row.is_httponly === 1,
          secure: row.is_secure === 1,
          sameSite: 'Lax',
        });
      }
      return cookies;
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The Instagram cookies of the Chrome profile you are actually logged in with. Nothing is typed, copied
 * or pasted: the browser already has them, and this reads its own store the way Chrome itself does.
 */
export function readChromeInstagramCookies(baseDir = chromeDir(), key = cookieKey()): ChromeCookies {
  const problems: string[] = [];
  for (const { profile, file } of cookieFiles(baseDir)) {
    let cookies: InstagramCookie[];
    try { cookies = readProfile(file, key); } catch (error) {
      problems.push(`${profile}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (cookies.some((cookie) => cookie.name === 'sessionid' && cookie.value)) return { profile, cookies };
  }
  throw new Error(`No Chrome profile is logged in to Instagram. Open instagram.com in Chrome, check that you are logged in, then run this again.${problems.length ? ` (${problems.join('; ')})` : ''} ${PASTE_INSTEAD}`);
}
