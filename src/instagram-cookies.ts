import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeStateFile, type StorageState } from './instagram-session.js';

export interface InstagramCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
}

/** Without this one nothing is logged in; the rest only help Instagram recognise the browser. */
const REQUIRED = 'sessionid';
const YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Reads cookies the way a browser hands them over: `sessionid=…; ds_user_id=…` on one line, one pair per
 * line, or the name and value in two columns as Chrome's Application panel copies them.
 */
export function parseInstagramCookies(text: string): InstagramCookie[] {
  const expires = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
  const found = new Map<string, string>();
  for (const chunk of text.replace(/^\s*cookie:\s*/i, '').split(/[;\r\n]+/)) {
    const line = chunk.trim();
    if (!line) continue;
    const pair = line.includes('=')
      ? [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]
      : /^([A-Za-z0-9_-]+)[ \t]+(\S+)$/.exec(line)?.slice(1);
    if (!pair) continue;
    const name = pair[0]?.trim() ?? '';
    const value = (pair[1]?.trim() ?? '').replace(/^"(.*)"$/, '$1');
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !value) continue;
    found.set(name, value);
  }
  if (!found.has(REQUIRED)) {
    // No URL in this message: the logger rewrites one, and a mangled address is worse than none.
    throw new Error(`No ${REQUIRED} cookie in what you pasted. In Chrome open instagram.com, press F12, then Application → Cookies → the instagram.com entry, and copy ${REQUIRED} (and ds_user_id and csrftoken).`);
  }
  return [...found].map(([name, value]) => ({
    name,
    value,
    domain: '.instagram.com',
    path: '/',
    expires,
    httpOnly: name === REQUIRED,
    secure: true,
    sameSite: 'Lax' as const,
  }));
}

/**
 * Saves pasted cookies as the session, keeping the previous one until the new cookies prove they work.
 * Returns a function that puts the old session back.
 */
export function saveCookieSession(statePath: string, cookies: InstagramCookie[]): () => void {
  const previous = existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined;
  writeStateFile(statePath, { cookies, origins: [] } satisfies StorageState);
  return () => {
    if (previous === undefined) rmSync(statePath, { force: true });
    else writeStateFile(statePath, JSON.parse(previous) as StorageState);
  };
}
