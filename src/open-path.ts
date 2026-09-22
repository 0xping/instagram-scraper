import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Resolve an existing dataset file/folder, rejecting traversal and symlinks outside the dataset. */
export function resolveDataPath(dataDir: string, path: string): string {
  const root = realpathSync(dataDir);
  const target = realpathSync(isAbsolute(path) ? path : resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('Path is outside DATA_DIR');
  }
  return target;
}

const isWsl = (): boolean => process.platform === 'linux' && (
  Boolean(process.env.WSL_DISTRO_NAME) ||
  existsSync('/proc/sys/kernel/osrelease') && /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))
);

function launch(target: string): Promise<void> {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open'; args = [target];
  } else if (process.platform === 'win32') {
    command = 'explorer.exe'; args = [target];
  } else if (isWsl()) {
    command = 'explorer.exe';
    args = [target.startsWith('https://') ? target : execFileSync('wslpath', ['-w', target], { encoding: 'utf8' }).trim()];
  } else {
    command = 'xdg-open'; args = [target];
  }
  return new Promise((done, fail) => {
    execFile(command, args, { timeout: 15_000 }, (error) => error ? fail(error) : done());
  });
}

export async function openDataPath(dataDir: string, path: string): Promise<void> {
  return launch(resolveDataPath(dataDir, path));
}

export async function openInstagramUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(parsed.hostname)) {
    throw new Error('Only Instagram HTTPS links can be opened');
  }
  return launch(parsed.href);
}
