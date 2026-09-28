import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { updateAvailable } from '../dist/update-check.js';

const A = 'a'.repeat(40);

test('the update check reads the installed commit and asks GitHub at most every 12 hours', async (t) => {
  const app = mkdtempSync(join(tmpdir(), 'update-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const previous = process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK;
  delete process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK;
  t.after(() => { if (previous !== undefined) process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK = previous; });

  assert.equal(await updateAvailable(app), false, 'no known commit: no notice, and no request');
  // A git checkout, on a branch whose ref is packed.
  mkdirSync(join(app, '.git'));
  writeFileSync(join(app, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(app, '.git', 'packed-refs'), `# pack-refs\n${A} refs/heads/main\n`);
  const now = Date.now();
  // A recent answer for this commit is reused: nothing goes to GitHub.
  writeFileSync(join(app, '.update-check'), JSON.stringify({ at: now - 3_600_000, commit: A, behind: true }));
  assert.equal(await updateAvailable(app, now), true);
  writeFileSync(join(app, '.update-check'), JSON.stringify({ at: now - 3_600_000, commit: A, behind: false }));
  assert.equal(await updateAvailable(app, now), false);
  // A download instead of a checkout: the installer's .version names the commit.
  rmSync(join(app, '.git'), { recursive: true });
  writeFileSync(join(app, '.version'), `${A}\n`);
  writeFileSync(join(app, '.update-check'), JSON.stringify({ at: now, commit: A, behind: true }));
  assert.equal(await updateAvailable(app, now), true);
  process.env.INSTAGRAM_SCRAPER_NO_UPDATE_CHECK = '1';
  assert.equal(await updateAvailable(app, now), false, 'it can be turned off');
});
