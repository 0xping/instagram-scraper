#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { saveSettings } from './env-file.js';
import { dataPaths, ensureDataDirs } from './paths.js';
import { createLogger, redactLog } from './logger.js';
import { acquireDatasetLock, migrate, openDatabase, recoverInterruptedJobs, registerCompetitors } from './db.js';
import { formatCompetitors, listCompetitors, parseCompetitorList } from './competitors.js';
import { BrowserManager } from './browser.js';
import { InstagramSessionManager } from './instagram-session.js';
import { collectProfiles } from './profile-scraper.js';
import { discoverBatch } from './discovery.js';
import { scrapePostsBatch } from './post-scraper.js';
import { formatMediaRun, processCompetitorMedia, type MediaOptions, type MediaRunSummary } from './media.js';
import { checkFfmpeg, formatFrameRun, processCompetitorFrames, type FrameRunSummary } from './frames.js';
import { DEFAULT_COMMENT_LIMIT, scrapeCommentsBatch } from './comments.js';
import { formatReelRun, processCompetitorReels, type ReelRunSummary } from './reels.js';
import { formatPipelineSummary, mediaWithRefresh, pipelineTotals, reelsWithRefresh } from './pipeline.js';
import { competitorStatus, formatRetry, formatStatus, RETRY_STAGES, type RetryStage } from './batch.js';
import { formatTable } from './competitors.js';
import { type ExportFormat } from './export.js';
import { createTranscriptionProvider } from './transcription-provider.js';
import { formatTranscriptRun, processCompetitorTranscripts } from './transcripts.js';
import { exportCompetitors, openCollector, resolveCompetitors, retryFailed, retryNeedsBrowser, scrapeCompetitors, type CollectorHandle } from './runner.js';

const usage = `Usage: npm run dev -- <command>

Commands:
  init      Create data directories and migrate SQLite
  competitors-import  Import usernames from competitors.txt into SQLite (safe to rerun)
  competitors-list    Show each competitor's status, post counts, and last scrape
  status    Per-competitor table: discovered, metadata, media, failed, last scrape
  instagram-login   Log in to Instagram manually in a browser and save the session
  instagram-status  Check that the saved Instagram session is still logged in
  scrape-profile <username...> | --all
                    Collect public profile fields for registered competitors
  discover <username...> | --all [--full]
                    Find post and Reel URLs on competitor profiles (resumable)
  scrape-posts <username...> | --all [--resume] [--force] [--limit N]
                    Extract fields from discovered posts (pending ones; --force refreshes complete ones)
  media <username...> | --all [--limit N] [--refresh-expired]
                    Download images/videos of extracted posts and write per-post folders
  reels <username...> | --all [--limit N] [--refresh]
                    Reel pipeline: thumbnail + video download, MP4 probe, per-Reel status
  frames <username...> | --all [--frame-interval SECONDS] [--max-frames N] [--force] [--limit N]
                    Extract JPEG frames from downloaded Reels with FFmpeg (default: one per second)
  transcripts <username...> | --all [--force]
                    Transcribe downloaded Reels with the configured provider
  scrape-comments <username...> | --all [--limit N|all] [--force]
                    Optional: collect publicly visible comments (default 100 per post; resumable)
  scrape <username...> | --all [--recent-hours N] [--skip-media] [--skip-frames] [--skip-transcripts] [--skip-comments]
         [--comment-limit N|all] [--force] [--resume] [--debug]
                    Full collector: session, profile, discovery, metadata, media, Reels, frames,
                    transcripts (if configured), comments. Resumes an unfinished run.
                    --all (npm run scrape:all): every competitor in turn; skips ones completed in the
                    last --recent-hours (default 24; 0 = none), continues past failures.
  retry-failed [<username...>] [--stage S[,S]] [--include-permanent] [--dry-run]
                    Retry failed posts (stages: metadata, media, reels, frames, transcripts, comments).
                    Retryable failures under the attempt cap only, unless --include-permanent.
  export <username...> | --all [--format json|csv|all] [--out DIR] [--no-raw]
                    Write competitor data for analysis to data/exports/<username>/ (default: both formats)
  settings-set KEY=value ...
                    Write settings to .env the way the dashboard does (used by setup)
  help      Show this message`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || ['help', '--help'].includes(args[0]!)) return runCommand(args);
  process.umask(0o077); // raw pages and browser state may contain session tokens
  const config = loadConfig();
  const lock = acquireDatasetLock(config.dataDir);
  try {
    const path = dataPaths(config.dataDir).database;
    if (existsSync(path)) {
      const db = openDatabase(path);
      try { migrate(db); recoverInterruptedJobs(db); } finally { db.close(); }
    }
    await runCommand(args);
  } finally {
    lock.close();
  }
}

/** `settings-set KEY=value ...`: what the installer and setup use, through the same writer as the dashboard. */
function settingsSetCommand(args: string[]): void {
  if (!args.length) throw new Error('Usage: settings-set KEY=value [KEY=value ...]');
  const changes: Record<string, string> = {};
  for (const pair of args) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`Expected KEY=value, got: ${pair}`);
    changes[pair.slice(0, at)] = pair.slice(at + 1);
  }
  saveSettings(resolve('.env'), changes);
  process.stdout.write(`Saved: ${Object.keys(changes).join(', ')}\n`);
}

async function runCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === 'help' || command === '--help' || command === undefined) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (command === 'scrape-profile') return scrapeProfiles(args.slice(1));
  if (command === 'discover') return discover(args.slice(1));
  if (command === 'scrape-posts') return scrapePostsCommand(args.slice(1));
  if (command === 'media') return mediaCommand(args.slice(1));
  if (command === 'reels') return reelsCommand(args.slice(1));
  if (command === 'scrape') return scrapeCommand(args.slice(1));
  if (command === 'export') return exportCommand(args.slice(1));
  if (command === 'retry-failed') return retryFailedCommand(args.slice(1));
  if (command === 'scrape-comments') return scrapeCommentsCommand(args.slice(1));
  if (command === 'frames') return framesCommand(args.slice(1));
  if (command === 'transcripts') return transcriptsCommand(args.slice(1));
  if (command === 'settings-set') return settingsSetCommand(args.slice(1));
  if (args.length !== 1 || !['init', 'status', 'competitors-import', 'competitors-list', 'instagram-login', 'instagram-status'].includes(command)) {
    throw new Error(`Unknown command.\n${usage}`);
  }

  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const paths = dataPaths(config.dataDir);

  if (command === 'instagram-login' || command === 'instagram-status') {
    // Login must be headed so a person can authenticate; status honors BROWSER_HEADED.
    const browser = new BrowserManager({
      headed: command === 'instagram-login' || config.browser.headed,
      navigationTimeoutMs: config.browser.navigationTimeoutMs,
    }, log);
    const session = new InstagramSessionManager(browser, paths.instagramState, config.browser.loginTimeoutMs, log);
    const onSignal = (): void => {
      void browser.close().finally(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      if (command === 'instagram-login') await session.login();
      else {
        await session.open();
        log.info('Saved Instagram session is still logged in.');
      }
    } finally {
      await browser.close();
    }
    return;
  }

  if (command === 'init' || command === 'competitors-import') ensureDataDirs(config.dataDir);
  if ((command === 'status' || command === 'competitors-list') && !existsSync(paths.database)) {
    throw new Error('Dataset not initialized. Run: npm run dev -- init');
  }

  const db = openDatabase(paths.database);
  try {
    if (command === 'init') {
      log.info(`Initialized ${paths.database}; applied ${migrate(db)} migration(s).`);
    } else if (command === 'competitors-import') {
      const file = resolve(process.cwd(), 'competitors.txt');
      if (!existsSync(file)) throw new Error('competitors.txt not found in the current directory.');
      const usernames = parseCompetitorList(readFileSync(file, 'utf8'));
      migrate(db);
      const added = registerCompetitors(db, usernames);
      log.info(`Read ${usernames.length} unique username(s) from competitors.txt: ${added} added, ${usernames.length - added} already saved.`);
    } else if (command === 'competitors-list') {
      const rows = listCompetitors(db);
      process.stdout.write(rows.length ? `${formatCompetitors(rows)}\n` : 'No competitors saved. Run: npm run competitors:import\n');
    } else {
      migrate(db);
      const rows = competitorStatus(db);
      process.stdout.write(rows.length ? `${formatStatus(rows)}\n` : 'No competitors saved. Run: npm run competitors:import\n');
    }
  } finally {
    db.close();
  }
}

type BrowserRun = Pick<CollectorHandle, 'db' | 'context' | 'session' | 'competitors' | 'config' | 'log' | 'signal'>;

/**
 * Shared setup for commands that browse competitor profiles: resolves `<username...>` or `--all`, opens the saved
 * session, turns Ctrl-C into a graceful stop, and always closes the browser and database.
 */
async function withCompetitorBrowser(command: string, targets: string[], run: (ctx: BrowserRun) => Promise<boolean>): Promise<void> {
  if (targets.length === 0) throw new Error(`Usage: npm run ${command} -- <username...>  or  npm run ${command} -- --all`);
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const paths = dataPaths(config.dataDir);
  if (!existsSync(paths.database)) throw new Error('Dataset not initialized. Run: npm run competitors:import');

  const browser = new BrowserManager({ headed: config.browser.headed, navigationTimeoutMs: config.browser.navigationTimeoutMs }, log);
  const abort = new AbortController();
  const onSignal = (): void => {
    if (abort.signal.aborted) process.exit(130); // second Ctrl-C: stop now
    log.warn('Stopping after cleanup (press Ctrl-C again to force)...');
    abort.abort();
    void browser.close();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let collector: CollectorHandle | undefined;
  try {
    collector = await openCollector({ config, log, signal: abort.signal, targets, browser });
    const ok = await run(collector);
    if (abort.signal.aborted) process.exitCode = 130;
    else if (!ok) process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (collector) await collector.close();
    else await browser.close();
  }
}

function scrapeProfiles(targets: string[]): Promise<void> {
  return withCompetitorBrowser('scrape:profile', targets, async ({ db, context, session, competitors, config, log, signal }) => {
    const summary = await collectProfiles(db, context, session, competitors, { dataDir: config.dataDir, log, signal });
    log.info(`Profiles: ${summary.succeeded.length} saved, ${summary.failed.length} failed, ${summary.skipped.length} not attempted.`);
    if (summary.stoppedBy) log.warn(`Batch stopped early: ${summary.stoppedBy}.`);
    return summary.failed.length === 0 && !summary.stoppedBy;
  });
}

function scrapePostsCommand(args: string[]): Promise<void> {
  const rest = [...args];
  const take = (flag: string): boolean => {
    const i = rest.indexOf(flag);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  const force = take('--force');
  take('--resume'); // resuming is always on: interrupted and pending posts are picked up automatically
  let limit: number | null = null;
  const li = rest.indexOf('--limit');
  if (li >= 0) {
    limit = Number(rest[li + 1]);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit needs a positive whole number');
    rest.splice(li, 2);
  }
  const unknown = rest.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --resume, --force, --limit N, or --all.`);
  return withCompetitorBrowser('scrape:posts', rest, async ({ db, context, session, competitors, config, log, signal }) => {
    const { summaries, stoppedBy } = await scrapePostsBatch(db, context, session, competitors, { dataDir: config.dataDir, log, signal, force, limit });
    const total = (key: 'extracted' | 'unavailable' | 'restricted' | 'failed'): number => summaries.reduce((n, s) => n + s[key], 0);
    log.info(`Posts: ${total('extracted')} extracted, ${total('unavailable')} unavailable, ${total('restricted')} restricted, ${total('failed')} failed across ${summaries.length} competitor(s).`);
    if (stoppedBy) log.warn(`Stopped early: ${stoppedBy}. Rerun the same command to continue.`);
    return total('failed') === 0 && !stoppedBy;
  });
}

/** Removes `flag` (and its value when `withValue`) from args; returns the value, true, or undefined. */
function takeFlag(args: string[], flag: string, withValue = false): string | true | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = withValue ? args[i + 1] : true;
  args.splice(i, withValue ? 2 : 1);
  if (withValue && value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

async function mediaCommand(input: string[]): Promise<void> {
  const args = [...input];
  const refresh = takeFlag(args, '--refresh-expired') === true;
  const limitArg = takeFlag(args, '--limit', true);
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit needs a positive whole number');
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --limit N, --refresh-expired, or --all.`);

  const report = (summaries: MediaRunSummary[], log: ReturnType<typeof createLogger>): boolean => {
    for (const s of summaries) if (s.posts) process.stdout.write(`\n${formatMediaRun(s)}\n\n`);
    const failed = summaries.reduce((n, s) => n + s.failed, 0);
    const stopped = summaries.find((s) => s.stoppedBy)?.stoppedBy;
    if (stopped) log.warn(`Stopped early: ${stopped}. Rerun the same command to continue; finished files are kept.`);
    return failed === 0 && !stopped;
  };

  if (refresh) {
    // Refreshing expired links re-opens those posts on instagram.com, so it needs the logged-in browser.
    return withCompetitorBrowser('media', args, async ({ db, context, session, competitors, config, log, signal }) => {
      const options: MediaOptions = { dataDir: config.dataDir, log, signal, limit };
      const summaries: MediaRunSummary[] = [];
      for (const competitor of competitors) {
        if (signal.aborted) break;
        const summary = await mediaWithRefresh(db, { context, session }, competitor, options);
        summaries.push(summary);
        if (summary.stoppedBy) break;
      }
      return report(summaries, log);
    });
  }

  // Default: CDN downloads only. No browser, no instagram.com page loads.
  return withCompetitorsOnly('media', args, async ({ db, competitors, config, log, signal }) => {
    const summaries: MediaRunSummary[] = [];
    for (const competitor of competitors) {
      if (signal.aborted) break;
      const summary = await processCompetitorMedia(db, competitor, { dataDir: config.dataDir, log, signal, limit });
      summaries.push(summary);
      if (summary.stoppedBy) break;
    }
    return report(summaries, log);
  });
}

/** Like withCompetitorBrowser, but for work that needs no browser: database, targets and Ctrl-C handling only. */
async function withCompetitorsOnly(command: string, targets: string[], run: (ctx: Omit<BrowserRun, 'context' | 'session'>) => Promise<boolean>): Promise<void> {
  if (targets.length === 0) throw new Error(`Usage: npm run ${command} -- <username...>  or  npm run ${command} -- --all`);
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const paths = dataPaths(config.dataDir);
  if (!existsSync(paths.database)) throw new Error('Dataset not initialized. Run: npm run competitors:import');
  const db = openDatabase(paths.database);
  const abort = new AbortController();
  const onSignal = (): void => {
    if (abort.signal.aborted) process.exit(130);
    log.warn('Stopping after the current file (press Ctrl-C again to force)...');
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    migrate(db);
    const ok = await run({ db, competitors: resolveCompetitors(db, targets), config, log, signal: abort.signal });
    if (abort.signal.aborted) process.exitCode = 130;
    else if (!ok) process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    db.close();
  }
}

async function reelsCommand(input: string[]): Promise<void> {
  const args = [...input];
  const refresh = takeFlag(args, '--refresh') === true;
  const limitArg = takeFlag(args, '--limit', true);
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit needs a positive whole number');
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --limit N, --refresh, or --all.`);

  const finish = (summaries: ReelRunSummary[], log: ReturnType<typeof createLogger>): boolean => {
    for (const s of summaries) process.stdout.write(`\n${formatReelRun(s)}\n\n`);
    const stopped = summaries.find((s) => s.stoppedBy)?.stoppedBy;
    if (stopped) log.warn(`Stopped early: ${stopped}. Rerun the same command to continue.`);
    return !stopped && summaries.every((s) => s.counts.failed === 0);
  };

  if (!refresh) {
    // No browser: only CDN downloads and local processing.
    return withCompetitorsOnly('reels', args, async ({ db, competitors, config, log, signal }) => {
      const summaries: ReelRunSummary[] = [];
      for (const competitor of competitors) {
        if (signal.aborted) break;
        const summary = await processCompetitorReels(db, competitor, { dataDir: config.dataDir, log, signal, limit });
        summaries.push(summary);
        if (summary.stoppedBy) break;
      }
      return finish(summaries, log);
    });
  }

  // --refresh: Reels waiting for metadata or a fresh link are re-extracted from their post pages (the
  // extraction layer, with the saved session), then run through acquisition and processing again.
  return withCompetitorBrowser('reels', args, async ({ db, context, session, competitors, config, log, signal }) => {
    const options: MediaOptions = { dataDir: config.dataDir, log, signal, limit };
    const summaries: ReelRunSummary[] = [];
    for (const competitor of competitors) {
      if (signal.aborted) break;
      const summary = await reelsWithRefresh(db, { context, session }, competitor, options);
      summaries.push(summary);
      if (summary.stoppedBy) break;
    }
    return finish(summaries, log);
  });
}

function scrapeCommand(input: string[]): Promise<void> {
  const args = [...input];
  const flag = (name: string): boolean => takeFlag(args, name) === true;
  const flags = {
    force: flag('--force'),
    skipMedia: flag('--skip-media'),
    skipFrames: flag('--skip-frames'),
    skipTranscripts: flag('--skip-transcripts'),
    skipComments: flag('--skip-comments'),
    commentLimit: DEFAULT_COMMENT_LIMIT as number | null,
  };
  flag('--resume'); // always on: an unfinished run is continued unless --force
  if (flag('--debug')) process.env.LOG_LEVEL = 'debug';
  const limitArg = takeFlag(args, '--comment-limit', true);
  if (limitArg !== undefined) flags.commentLimit = limitArg === 'all' ? null : Number(limitArg);
  if (flags.commentLimit !== null && (!Number.isSafeInteger(flags.commentLimit) || flags.commentLimit < 1)) throw new Error('--comment-limit needs a positive whole number or "all"');
  const recentArg = takeFlag(args, '--recent-hours', true);
  const recentHours = recentArg === undefined ? 24 : Number(recentArg);
  if (!Number.isFinite(recentHours) || recentHours < 0) throw new Error('--recent-hours needs a number of hours (0 = rerun every competitor)');
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --skip-media, --skip-frames, --skip-transcripts, --skip-comments, --comment-limit N|all, --recent-hours N, --force, --resume, --debug, or --all.`);
  const batch = args.includes('--all');
  return withCompetitorBrowser('scrape', args, async ({ db, context, session, competitors, config, log, signal }) => {
    const results = await scrapeCompetitors({ db, context, session, config, log, signal }, competitors, flags, {
      batch, recentHours,
      onSummary: (result) => {
        if (result.run) {
          const id = competitors.find((c) => c.username === result.username)!.id;
          process.stdout.write(`\n${formatPipelineSummary(result.username, result.run, pipelineTotals(db, id))}\n\n`);
        }
      },
    });
    if (batch && results.length) process.stdout.write(`${formatTable([['Competitor', 'Result', 'Job'], ...results.map((r) =>
      [r.username, r.status, r.jobId === null ? '' : String(r.jobId)])])}\n\n`);
    return results.every((r) => r.status === 'complete' || r.status.startsWith('skipped'));
  });
}

function exportCommand(input: string[]): Promise<void> {
  const args = [...input];
  const noRaw = takeFlag(args, '--no-raw') === true;
  // `npm run export:all --format json` (without --) reaches us as npm config, in npm_config_format.
  const format = takeFlag(args, '--format', true) ?? process.env.npm_config_format ?? 'all';
  if (format !== 'json' && format !== 'csv' && format !== 'all') throw new Error('--format must be json, csv, or all');
  const formats: ExportFormat[] = format === 'all' ? ['json', 'csv'] : [format];
  const out = takeFlag(args, '--out', true);
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --format json|csv|all, --out DIR, --no-raw, or --all.`);
  return withCompetitorsOnly('export', args, async ({ db, competitors, config, log }) => {
    const outDir = typeof out === 'string' ? resolve(out) : join(config.dataDir, 'exports');
    return !exportCompetitors(db, competitors, formats, config, log, { outDir, raw: !noRaw }).failed;
  });
}

async function retryFailedCommand(input: string[]): Promise<void> {
  const args = [...input];
  const includePermanent = takeFlag(args, '--include-permanent') === true;
  const dryRun = takeFlag(args, '--dry-run') === true;
  if (takeFlag(args, '--debug') === true) process.env.LOG_LEVEL = 'debug';
  // `npm run retry:failed --stage media` (without --) reaches us as npm config, in npm_config_stage.
  const stageArg = takeFlag(args, '--stage', true) ?? process.env.npm_config_stage;
  const stages = typeof stageArg === 'string' ? stageArg.split(',').map((s) => s.trim()).filter(Boolean) : [...RETRY_STAGES];
  const bad = stages.filter((s) => !(RETRY_STAGES as readonly string[]).includes(s));
  if (bad.length || !stages.length) throw new Error(`Unknown stage ${bad.join(', ') || '(empty)'}. Stages: ${RETRY_STAGES.join(', ')}.`);
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --stage S[,S], --include-permanent, --dry-run, --debug, or --all.`);
  const targets = args.length ? args : ['--all'];
  const chosen = stages as RetryStage[];

  const run = async (db: ReturnType<typeof openDatabase>, browser: { context: BrowserRun['context']; session: BrowserRun['session'] } | null,
    competitors: Array<{ id: number; username: string }>, config: ReturnType<typeof loadConfig>, log: ReturnType<typeof createLogger>, signal: AbortSignal): Promise<boolean> => {
    const { rows, failed } = await retryFailed(db, browser, competitors, chosen, { config, log, signal, includePermanent, dryRun });
    process.stdout.write(`\n${formatRetry(rows, dryRun)}\n\n`);
    if (dryRun) return !failed;
    return !failed && rows.every((r) => r.retried === r.fixed && !r.note && !r.exhausted && !r.permanent);
  };

  // Open the browser only when a stage that loads instagram.com has something to retry (or media has expired links).
  const needsBrowser = !dryRun && (() => {
    const config = loadConfig();
    const paths = dataPaths(config.dataDir);
    if (!existsSync(paths.database)) return false; // withCompetitorsOnly reports the missing dataset
    const db = openDatabase(paths.database);
    try {
      migrate(db);
      return retryNeedsBrowser(db, resolveCompetitors(db, targets), chosen, includePermanent);
    } finally {
      db.close();
    }
  })();
  if (needsBrowser) {
    return withCompetitorBrowser('retry:failed', targets, ({ db, context, session, competitors, config, log, signal }) => run(db, { context, session }, competitors, config, log, signal));
  }
  return withCompetitorsOnly('retry:failed', targets, ({ db, competitors, config, log, signal }) => run(db, null, competitors, config, log, signal));
}

function scrapeCommentsCommand(input: string[]): Promise<void> {
  const args = [...input];
  const force = takeFlag(args, '--force') === true;
  const limitArg = takeFlag(args, '--limit', true);
  const limit = limitArg === undefined ? DEFAULT_COMMENT_LIMIT : limitArg === 'all' ? null : Number(limitArg);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit needs a positive whole number or "all"');
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --limit N|all, --force, or --all.`);
  return withCompetitorBrowser('scrape:comments', args, async ({ db, context, session, competitors, config, log, signal }) => {
    const { summaries, stoppedBy } = await scrapeCommentsBatch(db, context, session, competitors, { dataDir: config.dataDir, log, signal, limit, force, limits: config.comments });
    if (stoppedBy) log.warn(`Stopped early: ${stoppedBy}. Rerun the same command to continue; saved comments are kept.`);
    return !stoppedBy && summaries.every((s) => s.failed === 0);
  });
}

async function framesCommand(input: string[]): Promise<void> {
  const args = [...input];
  const force = takeFlag(args, '--force') === true;
  const positive = (flag: string, whole: boolean): number | null => {
    const raw = takeFlag(args, flag, true);
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isSafeInteger(n))) throw new Error(`${flag} needs a positive ${whole ? 'whole ' : ''}number`);
    return n;
  };
  const interval = positive('--frame-interval', false);
  const maxFrames = positive('--max-frames', true);
  const limit = positive('--limit', true);
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --frame-interval SECONDS, --max-frames N, --force, --limit N, or --all.`);
  if (args.length === 0) throw new Error('Usage: npm run process:frames -- <username...>  or  npm run process:frames -- --all');

  return withCompetitorsOnly('process:frames', args, async ({ db, competitors, config, log, signal }) => {
    const version = checkFfmpeg();
    const chosenInterval = interval ?? config.frameInterval;
    log.info(`${version}; one frame every ${chosenInterval}s${maxFrames ? `, at most ${maxFrames} per Reel` : ''}.`);
    const summaries: FrameRunSummary[] = [];
    for (const competitor of competitors) {
      if (signal.aborted) break;
      summaries.push(await processCompetitorFrames(db, competitor, { dataDir: config.dataDir, log, signal, limit, interval: chosenInterval, maxFrames, force }));
    }
    for (const s of summaries) process.stdout.write(`\n${formatFrameRun(s)}\n\n`);
    if (signal.aborted) log.warn('Stopped early: interrupted. Rerun the same command to continue.');
    return !signal.aborted && summaries.every((s) => s.counts.failed === 0);
  });
}

async function transcriptsCommand(input: string[]): Promise<void> {
  const args = [...input];
  const force = takeFlag(args, '--force') === true;
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--all');
  if (unknown) throw new Error(`Unknown option ${unknown}. Use --force or --all.`);
  return withCompetitorsOnly('process:transcripts', args, async ({ db, competitors, config, log, signal }) => {
    checkFfmpeg();
    const provider = createTranscriptionProvider();
    let failed = 0;
    for (const competitor of competitors) {
      if (signal.aborted) break;
      const summary = await processCompetitorTranscripts(db, competitor, { dataDir: config.dataDir, log, signal, force, provider });
      process.stdout.write(`${formatTranscriptRun(summary)}\n`);
      failed += summary.counts.failed;
    }
    return !signal.aborted && failed === 0;
  });
}

function discover(args: string[]): Promise<void> {
  const full = args.includes('--full');
  const targets = args.filter((arg) => arg !== '--full');
  return withCompetitorBrowser('discover', targets, async ({ db, context, session, competitors, config, log, signal }) => {
    const summary = await discoverBatch(db, context, session, competitors, {
      dataDir: config.dataDir, log, signal, full, ...config.discovery,
    });
    const incomplete = summary.results.filter((r) => r.status === 'incomplete').map((r) => r.username);
    log.info(`Discovery: ${summary.results.length - incomplete.length} finished, ${incomplete.length} incomplete, ${summary.failed.length} failed, ${summary.skipped.length} not attempted.`);
    if (incomplete.length) log.warn(`Incomplete (rerun to continue): ${incomplete.join(', ')}`);
    if (summary.stoppedBy) log.warn(`Batch stopped early: ${summary.stoppedBy}.`);
    return summary.failed.length === 0 && incomplete.length === 0 && !summary.stoppedBy;
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${new Date().toISOString()} ERROR ${redactLog(message)}\n`);
  process.exitCode = 1;
});
