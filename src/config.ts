import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { dataPaths } from './paths.js';

export interface AppConfig {
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  frameInterval: number;
  commentLimit: number | null;
  browser: {
    headed: boolean;
    navigationTimeoutMs: number;
    loginTimeoutMs: number;
    /** Installed browser to drive; '' uses Playwright's bundled Chromium. */
    channel: string;
    /** Profile kept between runs; '' opens a throwaway one. */
    profileDir: string;
  };
  discovery: {
    scrollDelayMs: number;
    maxIdleScrolls: number;
  };
  /** Safety limits for `scrape:comments`, per post. They apply even with `--limit all`. */
  comments: {
    maxRounds: number;
    maxIdleRounds: number;
    maxSeconds: number;
    roundDelayMs: number;
  };
}

export function loadConfig(projectDir = process.cwd()): AppConfig {
  loadEnv({ path: resolve(projectDir, '.env'), quiet: true });

  const logLevel = process.env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, or error');
  }

  const dataDir = process.env.DATA_DIR ?? './data';
  if (!dataDir.trim()) throw new Error('DATA_DIR must be a nonempty path');

  return {
    browser: {
      // Instagram serves logged-in headless browsers a degraded page, so headed is the default.
      headed: envBoolean('BROWSER_HEADED', true),
      navigationTimeoutMs: envPositiveInt('NAVIGATION_TIMEOUT_MS', 30_000),
      loginTimeoutMs: envPositiveInt('LOGIN_TIMEOUT_MS', 600_000),
      // Instagram's security check will not accept a correct answer in the bundled Chromium on macOS,
      // and it distrusts a device it has never seen, so real Chrome and one lasting profile are the defaults.
      channel: process.env.BROWSER_CHANNEL?.trim() ?? 'chrome',
      profileDir: envBoolean('BROWSER_KEEP_PROFILE', true) ? dataPaths(resolve(projectDir, dataDir)).browserProfile : '',
    },
    discovery: {
      scrollDelayMs: envPositiveInt('DISCOVERY_SCROLL_DELAY_MS', 2_500),
      maxIdleScrolls: envPositiveInt('DISCOVERY_MAX_IDLE_SCROLLS', 5),
    },
    comments: {
      maxRounds: envPositiveInt('COMMENTS_MAX_ROUNDS', 60),
      maxIdleRounds: envPositiveInt('COMMENTS_MAX_IDLE_ROUNDS', 3),
      maxSeconds: envPositiveInt('COMMENTS_MAX_SECONDS', 300),
      roundDelayMs: envPositiveInt('COMMENTS_ROUND_DELAY_MS', 2_500),
    },
    frameInterval: envPositiveNumber('FRAME_INTERVAL', 1),
    commentLimit: process.env.COMMENT_LIMIT?.trim() === 'all' ? null : envPositiveInt('COMMENT_LIMIT', 100),
    dataDir: resolve(projectDir, dataDir),
    logLevel: logLevel as AppConfig['logLevel'],
  };
}

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function envPositiveInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647`);
  }
  return Number(value);
}
