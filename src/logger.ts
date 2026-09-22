import type { AppConfig } from './config.js';

const levels = ['debug', 'info', 'warn', 'error'] as const;
type Level = AppConfig['logLevel'];

export type Logger = ReturnType<typeof createLogger>;

/** Errors can contain signed URLs or a provider's echoed key. Keep those out of terminal and log files. */
export function redactLog(message: string): string {
  let text = message;
  for (const name of ['OPENAI_API_KEY', 'GROQ_API_KEY', 'TRANSCRIPTION_API_KEY']) {
    const key = process.env[name]?.trim();
    if (key) text = text.split(key).join('[redacted]');
  }
  return text.replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
    try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
    catch { return '[invalid URL]'; }
  }).replace(/\p{Cc}/gu, ' ');
}

export function createLogger(minimum: Level) {
  function write(level: Level, message: string): void {
    if (levels.indexOf(level) < levels.indexOf(minimum)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactLog(message)}`;
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  return {
    debug: (message: string) => write('debug', message),
    info: (message: string) => write('info', message),
    warn: (message: string) => write('warn', message),
    error: (message: string) => write('error', message),
  };
}
