import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(path: string): Database.Database {
  const db = new Database(path, { timeout: 5_000 });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL'); // preserve committed observations across power loss, not just process crashes
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Serializes CLI commands, including their filesystem writes. The OS releases this lock after a hard kill. */
export function acquireDatasetLock(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // ponytail: one command per dataset; use per-post locking only if concurrent collection becomes necessary.
  const lock = new Database(join(dataDir, 'collector.lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return lock;
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new Error('Another collector command is using this DATA_DIR. Wait for it to finish; do not delete the lock file.', { cause: error });
    }
    throw error;
  }
}

/** Only call after acquiring the dataset lock: no other CLI can still own a running job. */
export function recoverInterruptedJobs(db: Database.Database): void {
  db.prepare(`UPDATE scrape_jobs SET status = 'failed', error = 'interrupted',
    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'running'`).run();
}

/** A local storage failure affects every remaining item. Stop before consuming retries or moving good files. */
export function throwIfStorageError(error: unknown): void {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (/^(ENOSPC|EDQUOT|EIO|EROFS|EACCES|SQLITE_(FULL|IOERR|CORRUPT|NOTADB|READONLY|BUSY|LOCKED))/.test(code)
    || /no space left on device|disk quota exceeded|disk is full/i.test(message)) throw error;
}

export function migrate(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = readdirSync(migrationsDir).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  let count = 0;

  for (const name of files) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    db.transaction(() => {
      if (applied.get(name)) return;
      db.exec(sql);
      record.run(name);
      count += 1;
    }).immediate();
  }
  return count;
}

export function registerCompetitors(db: Database.Database, usernames: string[]): number {
  const insert = db.prepare('INSERT OR IGNORE INTO competitors (username) VALUES (?)');
  const restore = db.prepare('UPDATE competitors SET archived_at = NULL WHERE username = ? AND archived_at IS NOT NULL');
  let added = 0;
  db.transaction(() => {
    for (const username of usernames) {
      added += insert.run(username).changes;
      restore.run(username);
    }
  })();
  return added;
}

export function hideCompetitor(db: Database.Database, id: number): void {
  db.prepare("UPDATE competitors SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND archived_at IS NULL").run(id);
}
