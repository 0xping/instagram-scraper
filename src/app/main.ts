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
  // The running dashboard's address, so launching again reopens it instead of failing on the dataset lock.
  const urlFile = join(config.dataDir, 'browser', 'dashboard-url');
  let lock;
  try {
    lock = acquireDatasetLock(config.dataDir);
  } catch (error) {
    const url = existsSync(urlFile) ? readFileSync(urlFile, 'utf8').trim() : '';
    if (url && (await fetch(url).then((r) => r.ok, () => false))) {
      process.stdout.write(`The dashboard is already open: ${url}\n`);
      await openAppUrl(url).catch(() => undefined);
      return;
    }
    throw error;
  }
  try {
    ensureDataDirs(config.dataDir);
    const db = openDatabase(dataPaths(config.dataDir).database);
    try {
      migrate(db);
      recoverInterruptedJobs(db);
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
  } finally {
    lock.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${new Date().toISOString()} ERROR ${redactLog((error as Error).message)}\n`);
  process.exitCode = 1;
});
