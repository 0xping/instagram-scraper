import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { BrowserManager } from '../browser.js';
import { competitorStatus, type StatusRow } from '../batch.js';
import { loadConfig, type AppConfig } from '../config.js';
import { hideCompetitor, registerCompetitors } from '../db.js';
import { exportCompetitors, openCollector, resolveCompetitors, retryFailed, retryNeedsBrowser, scrapeCompetitors } from '../runner.js';
import { InstagramSessionManager } from '../instagram-session.js';
import { ManualInterventionError, SessionExpiredError } from '../instagram-session.js';
import { redactLog, type Logger } from '../logger.js';
import { formatPipelineSummary, pipelineTotals, type PipelineTotals } from '../pipeline.js';
import { parseCompetitorInput } from './model.js';

interface Job {
  competitor_id: number;
  status: string;
  current_stage: string | null;
  processed_items: number;
  total_items: number | null;
  stages_json: string | null;
}

export interface DashboardState {
  competitors: StatusRow[];
  job: Job | null;
  subJob: Job | null;
  totals: PipelineTotals | null;
}

export function useCollector(db: Database.Database, dataDir: string, selected: string | null) {
  const [state, setState] = useState<DashboardState>({ competitors: [], job: null, subJob: null, totals: null });
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'missing' | 'checking' | 'valid' | 'expired'>(
    existsSync(join(dataDir, 'browser', 'instagram-state.json')) ? 'checking' : 'missing',
  );
  const abortRef = useRef<AbortController | null>(null);
  const browserRef = useRef<BrowserManager | null>(null);
  const busyRef = useRef(false);
  const log = useMemo<Logger>(() => {
    const write = (level: string, message: string): void => {
      const entries = message.split(/\r?\n/).map((part) => `${new Date().toLocaleTimeString()} ${level} ${redactLog(part)}`);
      setLogs((lines) => [...lines, ...entries].slice(-300));
    };
    return { debug: (s) => write('DEBUG', s), info: (s) => write('INFO', s),
      warn: (s) => write('WARN', s), error: (s) => write('ERROR', s) };
  }, []);

  // Settings are re-read on every action so a change takes effect at once, but the dataset stays the one the
  // dashboard opened: `.env` or the environment must never redirect a running dashboard to another folder.
  const config = useCallback((): AppConfig => ({ ...loadConfig(), dataDir }), [dataDir]);

  const refresh = useCallback((): void => {
    try {
      const competitors = competitorStatus(db);
      const id = selected === null ? null : (db.prepare('SELECT id FROM competitors WHERE username = ?').get(selected) as { id: number } | undefined)?.id;
      const job = id ? db.prepare("SELECT competitor_id, status, current_stage, processed_items, total_items, stages_json FROM scrape_jobs WHERE competitor_id = ? AND job_type = 'pipeline' ORDER BY id DESC LIMIT 1").get(id) as Job | undefined : undefined;
      const subJob = id ? db.prepare("SELECT competitor_id, status, current_stage, processed_items, total_items, stages_json FROM scrape_jobs WHERE competitor_id = ? AND job_type IN ('discovery', 'posts', 'comments') ORDER BY id DESC LIMIT 1").get(id) as Job | undefined : undefined;
      setState({ competitors, job: job ?? null, subJob: subJob ?? null, totals: id ? pipelineTotals(db, id) : null });
    } catch (error) {
      log.error(`Dashboard refresh: ${(error as Error).message}`);
    }
  }, [db, selected, log]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const work = useCallback(async (label: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (busyRef.current) { log.warn('A dashboard task is already running.'); return; }
    busyRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(label);
    try {
      await action(abort.signal);
    } catch (error) {
      if (abort.signal.aborted) log.warn(`${label} interrupted.`);
      else log.error(`${label}: ${(error as Error).message}`);
      if (label === 'Session check' || error instanceof SessionExpiredError || error instanceof ManualInterventionError) setSessionStatus('expired');
    } finally {
      browserRef.current = null;
      abortRef.current = null;
      busyRef.current = false;
      setRunning(null);
      refresh();
    }
  }, [log, refresh]);

  const stop = useCallback((): void => {
    if (!abortRef.current || abortRef.current.signal.aborted) return;
    log.warn('Stopping after the current item...');
    abortRef.current.abort();
    void browserRef.current?.close();
  }, [log]);

  const scrape = useCallback((targets: string[], batch: boolean): Promise<void> => work('Scrape', async (signal) => {
    const settings = config();
    const browser = new BrowserManager({ ...settings.browser }, log);
    browserRef.current = browser;
    const handle = await openCollector({ log, signal, config: settings, targets, browser });
    browserRef.current = handle.browser;
    setSessionStatus('valid');
    try {
      const results = await scrapeCompetitors(handle, handle.competitors, {
        force: false, skipMedia: false, skipFrames: false, skipTranscripts: false, skipComments: false,
        commentLimit: settings.commentLimit,
      }, {
        batch, recentHours: 24,
        onSummary: (result) => {
          if (result.run) {
            const id = handle.competitors.find((c) => c.username === result.username)!.id;
            log.info(formatPipelineSummary(result.username, result.run, pipelineTotals(handle.db, id)));
          } else log.info(`@${result.username}: ${result.status}`);
          refresh();
        },
      });
      const failed = results.filter((r) => r.status !== 'complete' && !r.status.startsWith('skipped'));
      log.info(`Scrape finished: ${results.length - failed.length} complete/skipped, ${failed.length} needing attention.`);
    } finally {
      await handle.close();
    }
  }), [work, log, refresh, config]);

  const retry = useCallback((target: string): Promise<void> => work('Retry', async (signal) => {
    const settings = config();
    const competitors = resolveCompetitors(db, [target]);
    const stages = ['metadata', 'media', 'reels', 'frames', 'transcripts', 'comments'] as const;
    const needsBrowser = retryNeedsBrowser(db, competitors, stages, false);
    const browser = needsBrowser ? new BrowserManager({ ...settings.browser }, log) : null;
    browserRef.current = browser;
    const handle = browser ? await openCollector({ log, signal, config: settings, targets: [target], browser }) : null;
    try {
      const result = await retryFailed(handle?.db ?? db, handle ? { context: handle.context, session: handle.session } : null,
        competitors, stages, { config: settings, log, signal, includePermanent: false, dryRun: false });
      log.info(`Retry: ${result.rows.reduce((n, r) => n + r.fixed, 0)} fixed; ${result.failed ? 'errors remain' : 'done'}.`);
    } finally {
      await handle?.close();
    }
  }), [work, db, log, config]);

  const login = useCallback((): Promise<void> => work('Instagram login', async () => {
    const settings = config();
    const browser = new BrowserManager({ ...settings.browser, headed: true }, log);
    browserRef.current = browser;
    try {
      const session = new InstagramSessionManager(browser, join(dataDir, 'browser', 'instagram-state.json'), settings.browser.loginTimeoutMs, log);
      await session.login();
      setSessionStatus('valid');
    } finally {
      await browser.close();
    }
  }), [work, log, dataDir, config]);

  const verifySession = useCallback((): Promise<void> => work('Session check', async (signal) => {
    const settings = config();
    const browser = new BrowserManager({ ...settings.browser }, log);
    browserRef.current = browser;
    const handle = await openCollector({ log, signal, config: settings, targets: ['--all'], browser });
    setSessionStatus('valid');
    await handle.close();
  }), [work, log, config]);

  const add = useCallback((input: string): void => {
    const names = parseCompetitorInput(input);
    const added = registerCompetitors(db, names);
    log.info(`${added} new competitor(s); ${names.length - added} already registered or restored.`);
    refresh();
  }, [db, log, refresh, config]);

  const hide = useCallback((username: string): void => {
    const row = db.prepare('SELECT id FROM competitors WHERE username = ?').get(username) as { id: number } | undefined;
    if (!row) return;
    hideCompetitor(db, row.id);
    log.info(`@${username} hidden. Add the same name to restore it.`);
    refresh();
  }, [db, log, refresh, config]);

  const exportData = useCallback((targets: string[]): void => {
    const settings = config();
    const competitors = resolveCompetitors(db, targets);
    const result = exportCompetitors(db, competitors, ['json', 'csv'], settings, log);
    if (!result.failed) {
      setLastExport(join(settings.dataDir, 'exports'));
      log.info(`Exported ${competitors.length} competitor(s).`);
    }
    refresh();
  }, [db, log, refresh, config]);

  return { state, logs, running, log, sessionStatus, lastExport, refresh, stop, scrape, retry, login, verifySession, add, hide, exportData };
}
