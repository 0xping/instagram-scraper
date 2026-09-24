import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { createTranscriptionProvider } from './transcription-provider.js';

const SETTINGS = new Set(['DATA_DIR', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'TRANSCRIPTION_PROVIDER', 'TRANSCRIPTION_BASE_URL',
  'TRANSCRIPTION_MODEL', 'TRANSCRIPTION_API_KEY', 'COMMENT_LIMIT', 'FRAME_INTERVAL', 'BROWSER_HEADED', 'BROWSER_SHOW']);

/** Save dashboard settings without discarding other environment entries or comments. */
export function saveSettings(path: string, changes: Record<string, string>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (!SETTINGS.has(key)) throw new Error(`Unsupported setting: ${key}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} must be one line`);
  }
  const before = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  const restore = (): void => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    for (const [key, value] of Object.entries(changes)) process.env[key] = value;
    const config = loadConfig(dirname(path));
    if (process.env.TRANSCRIPTION_PROVIDER?.trim()) createTranscriptionProvider();
    if (config.commentLimit !== null && config.commentLimit < 1) throw new Error('COMMENT_LIMIT must be positive or all');
    const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const pending = new Set(Object.keys(changes));
    const lines = original.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '').flatMap((line) => {
      const key = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      if (!key || !(key in changes)) return [line];
      if (!pending.has(key)) return [];
      pending.delete(key);
      return [`${key}=${JSON.stringify(changes[key])}`];
    });
    for (const key of pending) lines.push(`${key}=${JSON.stringify(changes[key])}`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600, flush: true });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    restore();
    rmSync(temp, { force: true });
    throw error;
  }
}
