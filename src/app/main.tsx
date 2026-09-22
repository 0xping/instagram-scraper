#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from 'ink';
import { loadConfig } from '../config.js';
import { acquireDatasetLock, migrate, openDatabase, recoverInterruptedJobs } from '../db.js';
import { redactLog } from '../logger.js';
import { dataPaths, ensureDataDirs } from '../paths.js';
import { App } from './App.js';

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The dashboard needs an interactive terminal. Use npm run dev -- help for CLI commands.');
  }
  process.umask(0o077);
  const envPath = resolve('.env');
  const newEnv = !existsSync(envPath);
  if (newEnv) {
    copyFileSync(resolve('.env.example'), envPath);
    chmodSync(envPath, 0o600);
  }
  const config = loadConfig();
  const paths = dataPaths(config.dataDir);
  const firstRun = newEnv || !existsSync(paths.instagramState);
  const lock = acquireDatasetLock(config.dataDir);
  try {
    ensureDataDirs(config.dataDir);
    const db = openDatabase(paths.database);
    try {
      migrate(db);
      recoverInterruptedJobs(db);
      const app = render(<App db={db} dataDir={config.dataDir} envPath={envPath} firstRun={firstRun} />,
        { alternateScreen: true, exitOnCtrlC: false });
      await app.waitUntilExit();
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
