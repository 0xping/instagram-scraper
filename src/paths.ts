import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function dataPaths(dataDir: string) {
  const rawDir = join(dataDir, 'raw');
  return {
    rawDir,
    mediaDir: join(rawDir, 'media'),
    derivedDir: join(dataDir, 'derived'),
    database: join(rawDir, 'collector.sqlite'),
    instagramState: join(dataDir, 'browser', 'instagram-state.json'),
  };
}

export function ensureDataDirs(dataDir: string): void {
  const paths = dataPaths(dataDir);
  for (const dir of [paths.rawDir, paths.mediaDir, paths.derivedDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
