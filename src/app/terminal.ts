import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url);
/** Enough to redraw a reopened page; older output scrolls away. */
const KEEP = 400_000;

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; code: number };

/** The user's Claude Code: CLAUDE_BIN, then PATH, then where its installer puts it (a Mac app launched from Finder has a short PATH). */
export function findClaude(): string | null {
  const given = process.env.CLAUDE_BIN?.trim();
  if (given) return given;
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs.filter(Boolean)) {
    try { accessSync(join(dir, 'claude'), constants.X_OK); return join(dir, 'claude'); } catch { /* not here */ }
  }
  return null;
}

/** node-pty's macOS prebuild ships spawn-helper without its execute bit, and then every start fails with posix_spawnp. */
function fixSpawnHelper(): void {
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const dir of [join(root, 'prebuilds', `${process.platform}-${process.arch}`), join(root, 'build', 'Release')]) {
    const helper = join(dir, 'spawn-helper');
    try { if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755); } catch { /* read-only install: spawn reports it */ }
  }
}

/**
 * One interactive Claude Code, in the app folder, on a real terminal (node-pty) that the page shows with xterm.js.
 * It is the normal Claude Code: its own permission prompts, the project's settings, and Remote Control, so the same
 * session is also open at claude.ai/code. It keeps running when the page closes; reopening shows it again.
 */
export function createTerminal(options: { appDir: string; command?: () => { file: string; args: string[] } }) {
  let pty: IPty | null = null;
  let output = '';
  let exitCode: number | null = null;
  const listeners = new Set<(event: TerminalEvent) => void>();
  const emit = (event: TerminalEvent): void => { for (const listener of listeners) listener(event); };

  return {
    get running() { return pty !== null; },
    get exitCode() { return exitCode; },
    /** What the screen has shown so far, to replay to a page that opens later. */
    get output() { return output; },

    async start(cols: number, rows: number): Promise<void> {
      if (pty) return;
      const command = options.command?.() ?? (() => {
        const claude = findClaude();
        if (!claude) throw new Error('Claude Code was not found. Install it (claude.com/claude-code) and log in, or set CLAUDE_BIN in .env to where it is.');
        return { file: claude, args: ['--remote-control', 'Instagram research'] };
      })();
      fixSpawnHelper();
      // Optional and loaded on first use: the rest of the dashboard works where the native module could not be installed.
      const { spawn } = await import('node-pty').catch(() => {
        throw new Error('The terminal could not be installed on this computer. Run instagram-scraper claude in a terminal window instead.');
      });
      const proc = spawn(command.file, command.args, {
        name: 'xterm-256color', cols, rows, cwd: options.appDir,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      });
      pty = proc;
      output = '';
      exitCode = null;
      proc.onData((data) => {
        output = (output + data).slice(-KEEP);
        emit({ type: 'data', data });
      });
      proc.onExit(({ exitCode: code }) => {
        if (pty === proc) pty = null;
        exitCode = code;
        emit({ type: 'exit', code });
      });
    },
    write(data: string): void { pty?.write(data); },
    resize(cols: number, rows: number): void { try { pty?.resize(cols, rows); } catch { /* exited meanwhile */ } },
    stop(): void { pty?.kill(); },
    subscribe(listener: (event: TerminalEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
