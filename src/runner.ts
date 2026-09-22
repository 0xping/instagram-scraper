import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { BrowserManager } from './browser.js';
import { BROWSER_STAGES, retryCandidates, retryCompetitor, type RetryRow, type RetryStage } from './batch.js';
import { normalizeUsername } from './competitors.js';
import { loadConfig, type AppConfig } from './config.js';
import { migrate, openDatabase, throwIfStorageError } from './db.js';
import { exportCompetitor, type ExportFormat } from './export.js';
import { InstagramSessionManager } from './instagram-session.js';
import type { Logger } from './logger.js';
import { collectorStages, recentlyCompleted, runPipeline, type CollectorFlags, type PipelineRun } from './pipeline.js';
import { dataPaths } from './paths.js';

export interface Competitor { id: number; username: string }

export function resolveCompetitors(db: Database.Database, targets: string[]): Competitor[] {
  const all = db.prepare('SELECT id, username FROM competitors WHERE archived_at IS NULL ORDER BY last_scraped_at IS NOT NULL, last_scraped_at, username').all() as Competitor[];
  if (targets.length === 1 && targets[0] === '--all') return all;
  if (targets.some((target) => target.startsWith('--'))) throw new Error('Use --all by itself, or supply competitor usernames.');
  const wanted = targets.map((target) => {
    const name = normalizeUsername(target);
    if (!name) throw new Error('Expected a competitor username.');
    return name;
  });
  const missing = wanted.filter((name) => !all.some((c) => c.username === name));
  if (missing.length) throw new Error(`Not registered: ${missing.join(', ')}. Add them to competitors.txt and run: npm run competitors:import`);
  return wanted.filter((name, i) => wanted.indexOf(name) === i).map((name) => all.find((c) => c.username === name)!);
}

export interface CollectorHandle {
  db: Database.Database;
  browser: BrowserManager;
  context: Awaited<ReturnType<InstagramSessionManager['open']>>;
  session: InstagramSessionManager;
  competitors: Competitor[];
  config: AppConfig;
  log: Logger;
  signal: AbortSignal;
  close(): Promise<void>;
}

/** The shared browser collector. The caller owns the dataset lock and abort controller. */
export async function openCollector(options: {
  log: Logger; signal: AbortSignal; config?: AppConfig; targets?: string[]; browser?: BrowserManager;
}): Promise<CollectorHandle> {
  const config = options.config ?? loadConfig();
  const path = dataPaths(config.dataDir);
  if (!existsSync(path.database)) throw new Error('Dataset not initialized. Run: npm run competitors:import');
  const db = openDatabase(path.database);
  const browser = options.browser ?? new BrowserManager({ ...config.browser }, options.log);
  try {
    migrate(db);
    const competitors = resolveCompetitors(db, options.targets ?? ['--all']);
    const session = new InstagramSessionManager(browser, path.instagramState, config.browser.loginTimeoutMs, options.log);
    const context = await session.open();
    return {
      db, browser, context, session, competitors, config, log: options.log, signal: options.signal,
      async close() {
        await session.saveState(context).catch(() => undefined);
        await browser.close();
        db.close();
      },
    };
  } catch (error) {
    await browser.close();
    db.close();
    throw error;
  }
}

export interface ScrapeResult {
  username: string;
  status: string;
  jobId: number | null;
  run?: PipelineRun;
}

export async function scrapeCompetitors(
  ctx: Pick<CollectorHandle, 'db' | 'context' | 'session' | 'config' | 'log' | 'signal'>,
  competitors: Competitor[],
  flags: CollectorFlags,
  options: { recentHours: number; batch: boolean; onSummary?: (result: ScrapeResult) => void },
): Promise<ScrapeResult[]> {
  const { db, context, session, config, log, signal } = ctx;
  const results: ScrapeResult[] = [];
  let blocked: string | null = null;
  for (const [index, competitor] of competitors.entries()) {
    if (signal.aborted) break;
    if (options.batch && !flags.force && recentlyCompleted(db, competitor.id, options.recentHours)) {
      log.info(`[${index + 1}/${competitors.length}] @${competitor.username}: completed in the last ${options.recentHours}h; skipped.`);
      const result = { username: competitor.username, status: 'skipped (recently completed)', jobId: null };
      results.push(result);
      options.onSummary?.(result);
      continue;
    }
    if (options.batch) log.info(`[${index + 1}/${competitors.length}] @${competitor.username}`);
    try {
      const stages = collectorStages({ db, context, session, competitor, config, log, signal, flags });
      const run = await runPipeline(db, competitor, stages, { force: flags.force, log, signal, browserBlocked: blocked });
      const result = { username: competitor.username, status: run.status, jobId: run.jobId, run };
      results.push(result);
      options.onSummary?.(result);
      blocked = run.browserBlocked;
      if (run.status === 'interrupted') break;
    } catch (error) {
      throwIfStorageError(error);
      const message = (error as Error).message.split('\n')[0] ?? String(error);
      log.error(`@${competitor.username}: pipeline error: ${message}`);
      const result = { username: competitor.username, status: `error: ${message}`, jobId: null };
      results.push(result);
      options.onSummary?.(result);
    }
  }
  if (blocked) log.warn(`Instagram stages were blocked (${blocked}). Fix that, then rerun: completed work is kept and resumed.`);
  return results;
}

export async function retryFailed(
  db: Database.Database,
  browser: { context: CollectorHandle['context']; session: InstagramSessionManager } | null,
  competitors: Competitor[],
  stages: readonly RetryStage[],
  options: { config: AppConfig; log: Logger; signal: AbortSignal; includePermanent: boolean; dryRun: boolean },
): Promise<{ rows: RetryRow[]; failed: boolean }> {
  const rows: RetryRow[] = [];
  let failed = false;
  let blocked: string | null = null;
  for (const competitor of competitors) {
    if (options.signal.aborted) break;
    try {
      const result = await retryCompetitor(db, browser, competitor, stages, options, blocked);
      rows.push(...result.rows);
      blocked = result.blocked;
    } catch (error) {
      throwIfStorageError(error);
      failed = true;
      options.log.error(`@${competitor.username}: retry error: ${(error as Error).message}`);
    }
  }
  return { rows, failed };
}

export function retryNeedsBrowser(db: Database.Database, competitors: Competitor[], stages: readonly RetryStage[], includePermanent: boolean): boolean {
  return competitors.some((c) => stages.some((stage) => {
    const picked = retryCandidates(db, c.id, stage).eligible.filter((x) => includePermanent || x.retryable);
    return BROWSER_STAGES.has(stage) ? picked.length > 0 : stage === 'media' && picked.some((x) => x.reason?.startsWith('url_expired'));
  }));
}

export function exportCompetitors(
  db: Database.Database, competitors: Competitor[], formats: ExportFormat[], config: AppConfig, log: Logger,
  options: { outDir?: string; raw?: boolean } = {},
): { files: string[]; failed: boolean } {
  const files: string[] = [];
  let failed = false;
  for (const competitor of competitors) {
    try {
      const written = exportCompetitor(db, competitor, formats, options.outDir ?? join(config.dataDir, 'exports'), {
        dataDir: config.dataDir, raw: options.raw ?? true,
      });
      files.push(...written);
      log.info(`@${competitor.username}: ${written.map((f) => f.startsWith(process.cwd()) ? relative(process.cwd(), f) : f).join(', ')}`);
    } catch (error) {
      throwIfStorageError(error);
      failed = true;
      log.error(`@${competitor.username}: export failed: ${(error as Error).message}`);
    }
  }
  return { files, failed };
}
