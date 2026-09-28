# Instagram research collector: guide for AI agents

This tool collects public posts from Instagram accounts (captions, metrics, photos, videos, video frames, transcripts, comments) into one SQLite database and plain files on this computer. It stores and describes; it does no analysis. The first part of this guide covers using it, the second covers changing its code.

## Using the product

### Pick the way in

Use the CLI to collect, whether or not the dashboard is open. The user may keep the dashboard open to browse what you collect, and it shows your posts as they're saved. Only one collection runs at a time. If the dashboard is collecting, a CLI command fails with `Another collector command is using this DATA_DIR`: wait for it to finish, or use the local API below to watch it. To read data, read the files directly (see *Reading the data*).

To collect exactly N posts, pass `--post-limit N`: `instagram-scraper cli scrape <username> --post-limit 2`. Without it, the whole profile is collected, or `POST_LIMIT` from `.env` if that's set. Pinned posts come first on a profile and count toward N.

### Local API (while the dashboard is open)

The address, key included, is in `<data dir>/browser/dashboard-url`, for example `http://127.0.0.1:53121/?t=KEY`. Send `KEY` as the `x-token` header on every `/api/*` call, and send JSON bodies with `content-type: application/json`. The server listens on 127.0.0.1 only and refuses any other `Host`. Errors come back as `{"error": "plain sentence"}` with a 4xx status.

| Call | Body or query | Returns |
| --- | --- | --- |
| `GET /api/state` | | `session` (`connected`, `checking`, `missing` or `expired`), `accounts[]` (`username`, `saved`, `postsCount`, `failed`, `lastAt`, `text`), `task` (the running or last task, with per-account `status` and `stage`), `logs[]` |
| `GET /api/posts` | `account`, optional `type` (`reel`, `carousel` or `image`), `q` (caption contains, any case), `sort` (`newest`, `oldest`, `likes`, `comments` or `views`), `offset`, `limit` (≤200) | `total` (posts matching), `posts[]` (`id`, `shortcode`, `type`, `publishedAt`, `likes`, `comments`, `views`), `more` |
| `GET /api/post` | `id` | the full post: caption, media paths, transcript, top comments, frames |
| `POST /api/accounts` | `{"text": "@a, https://instagram.com/b/"}` | `usernames`, `added`, `skipped` |
| `POST /api/collect` | `{"accounts": ["a"] or "all", "maxPosts": 20 or null}` | starts in the background; poll `/api/state` until `task.running` is false |
| `POST /api/stop` | | stops the running task after its current item |
| `POST /api/retry` | `{"account": "a"}` | retries that account's failed posts |
| `POST /api/delete-posts` | `{"ids": [12, 13]}` | `{"deleted": n}`. **Permanent**; refused (409) while a task runs |
| `POST /api/hide` | `{"account": "a"}` | removes the account from the list and keeps its data; adding it again restores it |
| `POST /api/export` | `{"account": "a"}` or `{}` for all | writes JSON and CSV to `<data dir>/exports/` |

Only one task runs at a time; starting another returns 409. Collecting needs `session: "connected"`. Connecting may open a login window that a person has to complete, so ask the user to press **Connect Instagram** instead of calling `/api/connect` yourself.

### CLI

Run `instagram-scraper cli <command>` on an installed copy, `node dist/cli.js <command>` inside the app folder (this is what `instagram-scraper claude` sessions use), or `npm run dev -- <command>` in a checkout. `help` lists every command. Errors go to stderr with a non-zero exit code.

- `status --json`: every account as a JSON array (`username`, `discovered`, `metadata`, `media`, `failed`, `postsCount`, `lastScrapedAt`, `jobStatus`).
- `scrape <username...> [--post-limit N]`, or `scrape --all`: the full collection. It resumes unfinished runs and skips completed work.
- `retry-failed [<username...>]`: retries posts that failed.
- `delete-post <shortcode|post URL...>`: **permanent**. If any name does not match a saved post, nothing is deleted.
- `export <username...> | --all [--format json|csv|all]`

### Reading the data

After every collection, each account has an up-to-date folder at `<data dir>/competitors/<username>/`. Read its `README.md` first: it defines every file and field. `posts.jsonl` holds one complete post per line, and `posts/<shortcode>/` holds that post's `post.json`, media and frames. The shortcode is a post's stable identifier: it appears in the post URL and is what `delete-post` takes. The data dir defaults to `~/instagram-scraper-data`, or to `DATA_DIR` in `.env`.

### Boundaries

- Deleting a post removes its files and collected rows, and later collects skip it. Confirm with the user before deleting.
- Collecting stops at the daily limit of Instagram pages (`DAILY_PAGE_LIMIT`, 300 by default), and won't start for 24 hours after Instagram pushed back. Both protect the user's Instagram account: tell the user, and never add `--ignore-limits` unless they explicitly ask for it.
- Never try to get past an Instagram login, CAPTCHA or security challenge. Stop and tell the user.
- Collect only what the logged-in browser session can see.

## Working on the code

### Layout

- `src/cli.ts`: the CLI commands.
- `src/app/terminal.ts`: the dashboard's **Claude** panel. The user's own interactive Claude Code runs on a pseudo-terminal (node-pty, an optional dependency) in the app folder, and the page shows it with xterm.js (served from `/vendor/`). Output streams over Server-Sent Events, and keystrokes are POSTed.
- `src/instagram-limits.ts`: the daily page limit and the pause after Instagram pushes back, enforced in `openCollector`, which every collection goes through.
- `src/update-check.ts`: the new-version notice in the CLI and the dashboard.
- `src/app/server.ts`, `src/app/page.html` and `src/app/main.ts`: the dashboard. It's one HTML page with inline script, served with the JSON API above; `main.ts` launches it.
- `src/runner.ts`: shared operations for both front ends (open a collector, collect, retry, export, delete posts).
- `src/pipeline.ts`: the collection stages. Each stage lives in its own module: `discovery.ts`, `post-scraper.ts`, `media.ts`, `reels.ts`, `frames.ts`, `transcripts.ts` and `comments.ts`.
- `src/browser.ts`: launches Chrome. Headless browsers get a degraded page from Instagram, so a hidden browser stays headed and goes off screen and minimized.
- `migrations/NNN_name.sql`: the schema. Add a new file for each change, and never edit one that has already been applied. `raw_*_snapshots` and `post_metrics_history` are append-only (enforced by triggers).
- A post belongs to an account through `posts.competitor_id` or a `competitor_posts` link. Every stage selects posts through that ownership check, so detaching a post from both hides it everywhere.

### Commands

Use Node.js 22.13 or newer. Before committing, run `npm test` (it builds, then runs `node --test tests/*.test.mjs`), `npm run typecheck` and `npm run lint`. `npm run validate:e2e` drives a real browser against Instagram, so run it only when the user asks. Add tests to the matching `tests/<area>.test.mjs`; `tests/app.test.mjs` covers the dashboard API and the CLI.

### Style

Use two-space indentation, strict TypeScript, and explicit `.js` suffixes in relative imports. TypeScript names are camelCase and SQL names are snake_case. User-facing text is plain and says what to do next. Commit subjects are short imperative sentences, such as "Replace the terminal app with a local web page".

### Collection boundaries

Keep browser extraction separate from AI analysis. Keep source observations and collection timestamps under the data dir's `raw/`, and write derived results only under `derived/`.
