#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { acquireDatasetLock, migrate, openDatabase, recoverInterruptedJobs } from '../db.js';
import { redactLog } from '../logger.js';
import { openAppUrl } from '../open-path.js';
import { dataPaths, ensureDataDirs } from '../paths.js';
import { startDashboard } from './server.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const envPath = resolve('.env');
  if (!existsSync(envPath)) {
    copyFileSync(resolve('.env.example'), envPath);
    chmodSync(envPath, 0o600);
  }
  const config = loadConfig();
  // The running dashboard's address, so launching again reopens it instead of starting a second one.
  const urlFile = join(config.dataDir, 'browser', 'dashboard-url');
  const running = existsSync(urlFile) ? readFileSync(urlFile, 'utf8').trim() : '';
  if (running && (await fetch(running).then((r) => r.ok, () => false))) {
    process.stdout.write(`The dashboard is already open: ${running}\n`);
    await openAppUrl(running).catch(() => undefined);
    return;
  }
  // The dataset lock is held only to set up, then only while a task runs, so CLI commands work beside the page.
  // A CLI collecting right now keeps its lock: its jobs are its own, and the page shows them as it saves.
  ensureDataDirs(config.dataDir);
  const db = openDatabase(dataPaths(config.dataDir).database);
  try {
    let lock = null;
    try { lock = acquireDatasetLock(config.dataDir); } catch (error) { if (!/Another collector command/.test((error as Error).message)) throw error; }
    try {
      if (lock) { migrate(db); recoverInterruptedJobs(db); }
    } finally {
      lock?.close();
    }
    const dashboard = await startDashboard({ db, dataDir: config.dataDir, envPath });
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileSync(urlFile, `${dashboard.url}\n`, { mode: 0o600 });
    process.stdout.write(`\nDashboard: ${dashboard.url}\n\nIt opens in your browser. Keep this window open while you use it; Ctrl+C quits.\n\n`);
    await openAppUrl(dashboard.url).catch(() => process.stdout.write('Open the address above in your browser.\n'));
    await new Promise<void>((done) => {
      const quit = (): void => {
        process.stdout.write('Stopping… (press Ctrl+C again to force)\n');
        process.once('SIGINT', () => process.exit(130));
        done();
      };
      process.once('SIGINT', quit);
      process.once('SIGTERM', quit);
    });
    rmSync(urlFile, { force: true });
    await dashboard.close();
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${new Date().toISOString()} ERROR ${redactLog((error as Error).message)}\n`);
  process.exitCode = 1;
});
