import { normalizeUsername } from '../competitors.js';

export function parseCompetitorInput(text: string): string[] {
  const names = new Set<string>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const name = normalizeUsername(token);
    if (name) names.add(name);
  }
  if (!names.size) throw new Error('Enter at least one Instagram username or profile link');
  return [...names];
}
