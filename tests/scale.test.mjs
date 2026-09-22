import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { URL } from 'node:url';
import { migrate, openDatabase } from '../dist/db.js';

test('exports 2000 posts and 60000 comments with a 96 MiB JavaScript heap', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-scale-'));
  const db = openDatabase(join(dir, 'collector.sqlite'));
  try {
    migrate(db);
    db.exec("INSERT INTO competitors (id, username) VALUES (1, 'scale')");
    const post = db.prepare("INSERT INTO posts (competitor_id, shortcode, url, raw_json) VALUES (1, ?, 'u', ?)");
    const comment = db.prepare("INSERT INTO comments (post_id, instagram_comment_id, username, text) VALUES (?, ?, 'visitor', 'a comment')");
    const raw = JSON.stringify({ payload: 'x'.repeat(32 * 1024) });
    db.transaction(() => {
      for (let p = 0; p < 2000; p++) {
        const id = post.run(`Scale${p}`, raw).lastInsertRowid;
        for (let c = 0; c < 30; c++) comment.run(id, String(c));
      }
    })();
    db.close();
    const source = `
      import { openDatabase } from ${JSON.stringify(new URL('../dist/db.js', import.meta.url).href)};
      import { exportCompetitor } from ${JSON.stringify(new URL('../dist/export.js', import.meta.url).href)};
      const dir = process.argv[1];
      const db = openDatabase(dir + '/collector.sqlite');
      const started = Date.now();
      exportCompetitor(db, { id: 1, username: 'scale' }, ['json', 'csv'], dir + '/exports', { dataDir: dir, raw: true });
      db.close();
      console.log(JSON.stringify({ milliseconds: Date.now() - started, maxRssKiB: process.resourceUsage().maxRSS }));
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', source, dir], { encoding: 'utf8', timeout: 90_000 });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    t.diagnostic(child.stdout.trim());
    const out = join(dir, 'exports', 'scale');
    assert.ok(statSync(join(out, 'scale.json')).size > 64 * 1024 * 1024);
    for (const [file, expected] of [['posts.csv', 2001], ['comments.csv', 60001], ['metrics.csv', 1]]) {
      let lines = 0;
      for await (const line of createInterface({ input: createReadStream(join(out, file)), crlfDelay: Infinity })) { if (line.length) lines++; }
      assert.equal(lines, expected, file);
    }
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
