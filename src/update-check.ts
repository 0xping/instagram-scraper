import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = (process.env.INSTAGRAM_SCRAPER_REPO ?? 'https://github.com/0xping/instagram-scraper.git')
  .replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const BRANCH = process.env.INSTAGRAM_SCRAPER_BRANCH ?? 'main';
const EVERY_MS = 12 * 3_600_000;

/** The commit this copy runs: from .git in a checkout, or .version, which the installer writes for a download. */
function installedCommit(appDir: string): string | null {
  try {
    const git = join(appDir, '.git');
    if (existsSync(git)) {
      const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
      if (!head.startsWith('ref: ')) return head;
      const ref = head.slice(5);
      if (existsSync(join(git, ref))) return readFileSync(join(git, ref), 'utf8').trim();
      return /^(\w{40}) (.+)$/m.exec(readFileSync(join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`)) ?? '')?.[1] ?? null;
    }
    return readFileSync(join(appDir, '.version'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether GitHub has a newer version than this copy. Asked at most every 12 hours (the answer is kept in
 * .update-check), with a short timeout; offline, unknown or local-only commits all answer false.
 */
export async function updateAvailable(appDir: string, now = Date.now()): Promise<boolean> {
  if (process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK) return false;
  const commit = installedCommit(appDir);
  if (!commit) return false;
  const cache = join(appDir, '.update-check');
  try {
    const saved = JSON.parse(readFileSync(cache, 'utf8')) as { at: number; commit: string; behind: boolean };
    if (saved.commit === commit && now - saved.at < EVERY_MS) return saved.behind;
  } catch { /* first check, or an unreadable cache */ }
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/compare/${commit}...${BRANCH}`,
      { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return false;
    const { status } = await response.json() as { status: string };
    // "ahead": the branch has commits this copy lacks. A copy with its own commits is left alone.
    const behind = status === 'ahead';
    writeFileSync(cache, JSON.stringify({ at: now, commit, behind }));
    return behind;
  } catch {
    return false;
  }
}
