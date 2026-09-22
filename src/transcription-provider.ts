import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

export interface TimedSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  transcript: string;
  language: string | null;
  segments: TimedSegment[] | null;
  raw: unknown;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  transcribe(filePath: string, signal?: AbortSignal): Promise<TranscriptionResult>;
}

export class TranscriptionServiceError extends Error {
  constructor(provider: string, readonly status: number) {
    super(`${provider} transcription HTTP ${status}`);
  }
  get stopsBatch(): boolean { return [401, 403, 429].includes(this.status) || this.status >= 500; }
}

/**
 * Every supported service speaks the OpenAI `/audio/transcriptions` API, so a provider is only a base URL,
 * a key and a default model. `custom` is any other compatible server (a local Whisper server needs no key).
 */
const PRESETS: Record<string, { baseUrl: string | null; keyEnv: string | null; model: string | null }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', model: 'whisper-large-v3-turbo' },
  custom: { baseUrl: null, keyEnv: null, model: null },
};

export function createTranscriptionProvider(): TranscriptionProvider {
  const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
  const name = env('TRANSCRIPTION_PROVIDER')?.toLowerCase();
  if (!name) throw new Error(`Set TRANSCRIPTION_PROVIDER in .env (${Object.keys(PRESETS).join(', ')}).`);
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unsupported TRANSCRIPTION_PROVIDER: ${name} (use ${Object.keys(PRESETS).join(', ')})`);
  const baseUrl = (env('TRANSCRIPTION_BASE_URL') ?? preset.baseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('TRANSCRIPTION_BASE_URL is required for TRANSCRIPTION_PROVIDER=custom (e.g. http://localhost:8000/v1).');
  const key = env('TRANSCRIPTION_API_KEY') ?? (preset.keyEnv ? env(preset.keyEnv) : undefined);
  if (!key && preset.keyEnv) throw new Error(`${preset.keyEnv} (or TRANSCRIPTION_API_KEY) is required for TRANSCRIPTION_PROVIDER=${name}.`);
  const model = env('TRANSCRIPTION_MODEL') ?? preset.model;
  if (!model) throw new Error('TRANSCRIPTION_MODEL is required for TRANSCRIPTION_PROVIDER=custom.');
  // Whisper models return language and timed segments with verbose_json; OpenAI's gpt-4o transcribe models only plain json.
  const verbose = !/gpt-4o/i.test(model);
  return {
    name,
    model,
    async transcribe(filePath, signal) {
      if ((await stat(filePath)).size > 25 * 1024 * 1024) throw new Error('Audio exceeds the 25 MB upload limit');
      const audio = await readFile(filePath);
      if (audio.length > 25 * 1024 * 1024) throw new Error('Audio exceeds the 25 MB upload limit');
      const form = new FormData();
      form.set('file', new Blob([audio], { type: 'audio/mpeg' }), basename(filePath));
      form.set('model', model);
      form.set('response_format', verbose ? 'verbose_json' : 'json');
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {}, body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TranscriptionServiceError(name, response.status);
      }
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== 'object' || !('text' in raw) || typeof raw.text !== 'string') {
        throw new Error(`${name} transcription returned an invalid response`);
      }
      const value = raw as { text: string; language?: unknown; segments?: unknown };
      const segments = Array.isArray(value.segments) && value.segments.every((part: unknown) =>
        part !== null && typeof part === 'object' &&
        Number.isFinite((part as TimedSegment).start) && Number.isFinite((part as TimedSegment).end) &&
        (part as TimedSegment).start >= 0 && (part as TimedSegment).end >= (part as TimedSegment).start &&
        typeof (part as TimedSegment).text === 'string')
        ? value.segments.map((part: TimedSegment) => ({ start: part.start, end: part.end, text: part.text })) : null;
      return { transcript: value.text, language: typeof value.language === 'string' ? value.language : null, segments, raw };
    },
  };
}
