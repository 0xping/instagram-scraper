import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactLog } from '../logger.js';

export interface ChatMessage { role: 'user' | 'assistant' | 'tool' | 'error'; text: string }

/** Where Claude Code usually lives; a Mac app launched from Finder may not have these on its PATH. */
function claudeBin(): string {
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();
  return [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync) ?? 'claude';
}

const prompt = (dataDir: string): string => `You are the assistant inside the Instagram research dashboard. The user sees the dashboard next to this chat;
posts you collect appear there on their own as they are saved.
Read AGENTS.md in the working directory before your first command. Run the collector only as \`node dist/cli.js <command>\`
(for example \`node dist/cli.js scrape <username> --post-limit 2\`); no other shell command is allowed.
Always pass --post-limit when the user names a number of posts. The data folder is ${dataDir}; read posts from
competitors/<username>/posts.jsonl there. Ask before deleting anything. Answer in a few plain sentences.`;

/**
 * A chat with the Claude Code the user already has, run headless (`claude -p`) on their own plan: no API key.
 * Claude may read files and run the collector CLI, nothing else. Each message resumes the same conversation.
 */
export function createChat(options: { appDir: string; dataDir: string }) {
  const messages: ChatMessage[] = [];
  let session: string | null = null;
  let child: ChildProcess | null = null;
  const push = (message: ChatMessage): void => {
    messages.push(message);
    messages.splice(0, Math.max(0, messages.length - 200));
  };

  /** One line of Claude Code's stream-json output. */
  function read(line: string): void {
    let event: { type?: string; session_id?: string; is_error?: boolean; result?: string; message?: { content?: Array<Record<string, unknown>> } };
    try { event = JSON.parse(line) as typeof event; } catch { return; }
    if (event.session_id) session = event.session_id;
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) push({ role: 'assistant', text: block.text.trim() });
        if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          push({ role: 'tool', text: String(input.command ?? input.file_path ?? input.pattern ?? block.name) });
        }
      }
    }
    if (event.type === 'result' && event.is_error) push({ role: 'error', text: redactLog(event.result ?? 'Claude stopped with an error.') });
  }

  function send(text: string): void {
    if (child) throw new Error('Claude is still answering. Wait, or press Stop.');
    push({ role: 'user', text });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--tools', 'Bash,Read,Grep,Glob', '--allowedTools', 'Bash(node dist/cli.js *)', 'Read', 'Grep', 'Glob',
      '--add-dir', options.dataDir, '--append-system-prompt', prompt(options.dataDir), ...(session ? ['--resume', session] : [])];
    // A collection outlasts Bash's default two minutes.
    const proc = spawn(claudeBin(), args, { cwd: options.appDir, env: { ...process.env, BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '3600000' } });
    child = proc;
    let buffer = '';
    let stderr = '';
    proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      lines.forEach(read);
    });
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    proc.on('error', (error: NodeJS.ErrnoException) => {
      push({ role: 'error', text: error.code === 'ENOENT'
        ? 'Claude Code was not found. Install it (claude.com/claude-code) and log in, or set CLAUDE_BIN in .env to where it is.'
        : error.message });
    });
    proc.on('close', (code, signal) => {
      if (buffer) read(buffer);
      if (signal) push({ role: 'error', text: 'Stopped.' });
      else if (code && messages.at(-1)?.role !== 'error') push({ role: 'error', text: redactLog(stderr.trim() || `Claude Code exited with code ${code}.`) });
      child = null;
    });
    // The message goes on stdin: a prompt after --allowedTools would be read as one more tool name.
    proc.stdin!.end(text);
  }

  return {
    send,
    stop(): void { child?.kill('SIGTERM'); },
    /** Forgets the conversation; the next message starts a new one. */
    reset(): void {
      if (child) throw new Error('Claude is still answering. Press Stop first.');
      messages.length = 0;
      session = null;
    },
    state: () => ({ messages, running: child !== null }),
  };
}
