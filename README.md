# instagram-scraper

**Archive any public Instagram account — posts, Reels, video frames, speech transcripts and comments — onto your own computer, from one terminal dashboard.**

Made for competitor research: point it at the accounts you track, let it run, then browse or export everything as CSV, JSON and files you own. No API keys, no monthly fee, no data leaving your machine.

```sh
curl -fsSL https://raw.githubusercontent.com/0xping/instagram-scraper/main/install.sh | bash
instagram-scraper
```

```text
┌ What would you like to do? ─────┐┌ Accounts (12) ───────────────────────┐
│ › Collect posts and media       ││ @competitor1 · 437 posts saved        │
│   Review saved posts            ││ @competitor2 · 2 need attention       │
│   Export data                   ││ @competitor3 · 612 posts saved        │
│   Fix failed items              ││                                       │
│   Settings                      ││ Latest activity · @competitor1        │
│   Quit                          ││ Collecting · Post details             │
│                                 ││ ████████████████░░░░░░░░ 8/13 items   │
└─────────────────────────────────┘└───────────────────────────────────────┘
```

## What it collects

| | |
| --- | --- |
| **Profile** | Name, bio, link, followers, following, post count, avatar |
| **Every post** | Caption, hashtags, mentions, tagged users, location, publish time, likes, comments and views — with each number kept over time, so you can see what grew |
| **Photos and carousels** | Every slide, in order, verified byte for byte |
| **Reels** | The video file, thumbnail, duration, audio track name |
| **Video frames** | One JPEG per second of every Reel, ready for review or vision models |
| **Speech** | Transcripts with timestamps, from a free Groq account, a paid OpenAI key, or Whisper running on your own machine |
| **Comments** | Text, author, likes, replies, timestamps |

Everything lands in plain files and one SQLite database you can query, plus CSV and JSON exports for spreadsheets or an LLM.

## Why it is different

- **It resumes.** Stop it any time, close your laptop, lose the connection. The next run continues exactly where it stopped and never recollects what it already has.
- **It never duplicates.** Rerun it daily: metrics update, content stays, nothing is written twice.
- **It respects what it sees.** No login bypassing, no CAPTCHA solving, no private content. It stops and tells you when Instagram asks for a challenge.
- **It is honest about failure.** Every failed item is recorded with a reason, and `Fix failed items` retries only what can be fixed.
- **It is tested.** 83 unit tests plus an end-to-end validation that runs the whole pipeline against a local fake Instagram, including interruptions, restarts and a hard kill.

## Install

**macOS, Linux, WSL**

```sh
curl -fsSL https://raw.githubusercontent.com/0xping/instagram-scraper/main/install.sh | bash
```

Installs Node.js if missing, downloads the browser it drives and FFmpeg, and puts `instagram-scraper` (short: `igscrape`) on your PATH. Update later with `instagram-scraper update`.

**Windows**: download the repository, then double-click `Install.bat` once and `Start.bat` to run it.

Requires Node.js 22.13+, about 1 GB of disk for the browser and FFmpeg, and an Instagram account you log into yourself, in a browser window the tool opens.

## Using it

1. `instagram-scraper`
2. **Connect Instagram** — a browser window opens; log in as you normally would. The session is saved locally, and your password is never seen or stored by the tool.
3. **Add accounts to track** — paste usernames or profile links.
4. **Collect posts and media** — pick one account or all of them, then leave it running.
5. **Review saved posts** — browse what was collected; photos, videos and frame folders open in your normal viewer.
6. **Export data** — CSV and JSON in `exports/`.

Data is stored in `~/instagram-scraper-data` by default. Set `INSTAGRAM_SCRAPER_DATA` to keep separate datasets.

### Transcripts

Open **Settings → Video speech transcription** and pick one:

| Choice | Cost | Notes |
| --- | --- | --- |
| Groq | Free tier | Create a key at console.groq.com; fastest to set up |
| Whisper on this computer | Free | Needs [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running; nothing leaves your machine |
| OpenAI | Paid per minute | Standard `whisper-1` |
| Another Whisper server | — | Any server speaking the same API |

The dashboard saves everything the choice needs, so you never edit a config file.

## Please use it responsibly

This collects content that is already visible to your own logged-in browser, for research you are allowed to do. It does not bypass logins, private accounts, age gates or CAPTCHAs, and it paces its requests. You are responsible for following Instagram's terms and the privacy laws that apply to you, especially when you store other people's comments. MIT licensed, no warranty.

## For developers

The dashboard is one front end; every step is also a CLI command (`instagram-scraper cli help`), and the collector is plain TypeScript over SQLite and Playwright. Architecture, the full command and environment reference, and the operating guide are in [PRODUCTION_REVIEW.md](PRODUCTION_REVIEW.md).

---

# Developer documentation

## Setup

Requires Node.js 22.13 or newer.

```sh
npm install
npx playwright install chromium
cp .env.example .env
```

`.env` accepts `DATA_DIR` (default `./data`) and `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`; default `info`). Browser settings are `BROWSER_HEADED` (default `true`; `false` runs headless, see profile collection below), `NAVIGATION_TIMEOUT_MS` (default `30000`) and `LOGIN_TIMEOUT_MS` (how long `instagram:login` waits for you; default `600000`). Discovery settings are `DISCOVERY_SCROLL_DELAY_MS` (base pause after each scroll; default `2500`) and `DISCOVERY_MAX_IDLE_SCROLLS` (scrolls in a row with nothing new before the end is checked; default `5`). Relative data paths resolve from the directory where you run the CLI, and so does `competitors.txt`.

```sh
npm run dev -- init
npm run dev -- status
npm run typecheck
npm run lint
npm run build
npm test
npm run cli -- status
```

`init` can run repeatedly. It creates the data directories and applies unapplied migrations. `status` reports saved counts and requires `init` first. Neither launches a browser.

Only one command may use a dataset at a time, including status, exports, and login. A second command fails with a clear message. The operating system releases the SQLite lock after a crash or reboot; never delete `collector.lock.sqlite` while a command is running. Storage failures stop the command without spending the remaining posts' retry budgets.

## Competitor list

Keep the competitors you track in `competitors.txt`, one per line:

```text
# comments start with #
@competitor1
competitor2
https://instagram.com/competitor3/
https://www.instagram.com/competitor4?hl=en
```

```sh
npm run competitors:import
npm run competitors:list
```

`import` normalizes each line (trim, drop `@`, take the username from a profile URL, ignore query strings and trailing slashes, lowercase), skips blank and `#` lines, and merges duplicates. It is safe to rerun: usernames already in SQLite are left alone, and only new ones are added. If any line is invalid (for example a post URL like `/p/abc/` or a name with spaces), nothing is imported and every bad line is reported with its line number. Removing a line from the file does not delete the competitor or its saved data.

`list` prints one row per competitor: username, account status (`unknown` until a scrape sets it), discovered posts (all saved posts for that competitor), processed posts (those whose extraction status is `complete`), and the last scrape time (`never` if none). Neither command visits Instagram.

## Full collection (one command)

```sh
npm run scrape -- competitor1                      # everything, with sensible defaults
npm run scrape -- competitor1 --skip-comments --skip-transcripts
npm run scrape -- competitor1 --comment-limit all --debug
npm run scrape -- --all
```

Runs sequentially: session check, profile, discovery, post metadata, image/carousel media, Reel media, frames, transcripts, comments. Each stage is the same code as its own command, so each one is resumable and idempotent on its own and keeps its own status columns and jobs.

| Flag | Effect |
| --- | --- |
| `--skip-media` | Skip image/carousel and Reel downloads (frames and transcripts still use videos already on disk) |
| `--skip-frames`, `--skip-transcripts`, `--skip-comments` | Skip that stage |
| `--comment-limit N\|all` | Comments per post (default 100) |
| `--force` | New job; full discovery walk; re-extract, re-frame, re-transcribe and revisit comments for every post (many page loads) |
| `--resume` | Accepted for clarity; resuming is always on |
| `--debug` | Debug logging |

Optional stages skip themselves rather than fail: frames and transcripts when FFmpeg cannot run, transcripts without `TRANSCRIPTION_PROVIDER`.

**Tracking and resume.** Each run is one `scrape_jobs` row (`job_type = 'pipeline'`). `stages_json` records each stage's status (`ok`, `partial`, `failed`, `blocked`, `skipped`, `interrupted`), detail and counts, rewritten after every stage. If the latest pipeline job is unfinished and under 24 hours old, a rerun continues it: stages already `ok` are skipped (the session check always reruns) up to the first unfinished one, which runs again and picks up from its own saved state. Every stage after it runs too, because the rerun can give it new work (a post that now has metadata still needs media and comments); a stage with nothing left to do finishes without loading any page. `--force` or a finished job starts a new one.

**Failure isolation.** A stage that throws is recorded and the next stage runs. An expired session, security challenge or rate limit marks that stage `blocked` and skips the remaining instagram.com stages (profile, discovery, metadata, comments, and link refreshes). CDN downloads, frames and transcripts still run. Ctrl-C stops after the current item's cleanup and marks the stage `interrupted`.

The summary mixes run and dataset numbers. *Previously processed*, *New posts* and *Metadata* describe this run's extraction. *Posts discovered*, *Media*, *Reels*, *Frames*, *Transcripts* and *Comments* are the competitor's totals so far. *Errors* is failed items plus failed or blocked stages.

## Every competitor, status, and retries

```sh
npm run scrape:all                               # the full pipeline for every competitor, one at a time
npm run scrape:all -- --recent-hours 0           # also rerun competitors that finished recently
npm run status                                   # per-competitor progress table
npm run retry:failed                             # retry failed posts, every competitor, every stage
npm run retry:failed -- competitor1 --stage media
npm run retry:failed -- --stage frames,transcripts --dry-run
```

### `scrape:all`

Runs `npm run scrape` for each registered competitor, sequentially, oldest-scraped first. Each competitor's pipeline job is saved before the next competitor starts. Everything in *Full collection* applies per competitor: resume, stage tracking, and `--skip-*`, `--comment-limit`, `--force`, `--debug`.

- **Already done.** A competitor whose last pipeline job completed within `--recent-hours` (default 24) is skipped. `0` reruns everyone. `--force` also reruns everyone, and forces every stage.
- **Unfinished.** A competitor with an unfinished job continues it.
- **Failures.** A competitor that fails is recorded (its job and `scrape_errors`) and the batch moves on.
- **Blocks.** If Instagram blocks the session (expired session, challenge, rate limit), later competitors still get their local stages: downloads, frames, transcripts. Their instagram.com stages are recorded `blocked` and run on the next `scrape:all`.
- **Ctrl-C.** Stops after the current item's cleanup. The rerun picks up the same competitor and stage.

A result table (competitor, job status, job id) is printed at the end. The exit code is non-zero unless every competitor completed or was skipped.

### `status`

```text
Competitor    Discovered  Metadata  Media  Failed  Last scrape
competitor_a  437         432       420    5       2026-09-21
competitor_c  612         101       92     3       In progress
```

| Column | Meaning |
| --- | --- |
| Discovered | Posts saved |
| Metadata | Posts with extraction complete |
| Media | Posts with every media file downloaded |
| Failed | Posts with a failure in any stage (extraction, media, Reel, frames, transcript, comments). Deleted or restricted posts are not failures. |
| Last scrape | Date of the latest `npm run scrape` job; `In progress`, or `(interrupted)`, `(blocked)`, `(incomplete)` when it did not finish. Competitors never run through the pipeline show the last profile scrape. |

On the next command, jobs left `running` by a killed process are marked interrupted while keeping their progress. The next `scrape` resumes eligible unfinished work.

### `retry:failed`

Retries only failed posts, reusing each stage's own code on just those posts. With no username it covers every competitor. `--stage` takes one or more of `metadata`, `media`, `reels`, `frames`, `transcripts`, `comments`, comma-separated. `npm run retry:failed --stage media` (without `--`) also works.

- **Retryable only, by default.** Permanent failures are left alone unless you pass `--include-permanent`:
  - extraction or comment errors recorded as non-retryable;
  - the CDN refusing a file (`not_retrievable`), or no URL served;
  - an unreadable video (`unsupported_video`);
  - audio over the API's 25 MB limit, or HTTP 400/413 from the transcription API.
- **Bounded.** Each stage has an attempt counter, and posts at the cap are never retried here: 5 failed runs for extraction, frames, transcripts and comments, 5 failed runs per media item. They show as *Gave up*. Metadata, frames, transcripts, and comments support `--force` on their own commands. Media attempts reset when metadata extraction supplies a different source URL.
- **Browser only when needed.** It is opened only if metadata or comments have something to retry, or media has expired links to refresh. Otherwise nothing loads instagram.com.
- **Isolated.** A stage that errors is noted on its row, and the other stages and competitors continue. A session block skips the remaining instagram.com retries.
- **`--dry-run`** prints the table without retrying.

```text
Competitor  Stage   Retryable  Permanent  Gave up  Retried  Fixed  Note
brand       media   4          1          0        4        3
brand       frames  1          0          2        1        1
```

## Export

```sh
npm run export -- competitor1                    # JSON and CSV
npm run export -- competitor1 --format json
npm run export -- competitor1 --format csv
npm run export:all -- --format json              # every competitor (`npm run export:all --format json` also works)
npm run export -- competitor1 --no-raw --out ~/analysis
```

SQLite stays the source of truth. Export writes read-only copies to `data/exports/<username>/` (or `--out DIR`), replacing the previous export each run. Nothing is requested from Instagram. Images, videos and frames are never embedded: every file is a path relative to `DATA_DIR`, and the JSON records that directory in `export.data_dir`.

**`<username>.json`** is one normalized document (`export.schema_version` is 1):

```text
export       schema_version, exported_at, data_dir
competitor   username, display_name, bio, followers/following/posts counts, verified, category, profile_image_path, …
posts[]      newest first
  shortcode, url, type, product_type, owner_username, published_at, caption, accessibility_caption, location
  hashtags[], mentions[], tagged_users[], coauthors[]
  metrics      likes, likes_hidden, comments, comments_disabled, views, plays, history[] (every observation)
  reel         Reels only: duration_seconds, file {duration, width, height, has_audio}, audio {title, artist, type}, status
  thumbnail_path
  media[]      position, type, local_path, file_format, bytes, sha256, width, height, duration_seconds, alt_text
  comments[]   id, parent_id (replies), username, text, likes, published_at
  transcript   latest attempt: text, language, has_speech, provider, model, segments, created_at (or null)
  frames[]     timestamp_seconds, path
  status       availability and each stage's status
  raw          Instagram's original post payload (omit with --no-raw; it is most of the file's size)
```

**CSV** (UTF-8, no byte-order mark; RFC 4180: comma-separated, CRLF rows, fields quoted when they hold a comma, quote or newline, quotes doubled). Every file starts with a `competitor` column, so exports can be concatenated.

| File | One row per | Columns |
| --- | --- | --- |
| `posts.csv` | post | Post fields, latest metrics, Reel duration and audio, media count and paths, comment and frame counts, transcript text. List fields are space-separated. |
| `comments.csv` | comment | `post_shortcode`, `comment_id`, `parent_comment_id`, `username`, `text`, `likes`, `published_at` |
| `metrics.csv` | metrics observation | `post_shortcode`, `observed_at`, `likes`, `comments`, `views`, `plays` (engagement over time) |

JSON preserves collected text. CSV prefixes formula-like text with an apostrophe to keep spreadsheet applications from executing captions or comments as formulas. Numeric fields retain their numeric form. Exports stream one post at a time, including its comments and history, so memory does not grow with the entire competitor's raw payloads. Each output file is replaced atomically; an interrupted multi-file export should be rerun before using the set.

## End-to-end validation

```sh
npm run validate:e2e                  # about 3 minutes
E2E_KEEP=1 E2E_VERBOSE=1 npm run validate:e2e
```

Runs the real CLI against a local fake Instagram, CDN and transcription endpoint (`tests/e2e/`), on one fixture competitor with image, carousel, Reel, deleted, comments-off and failing posts. No request reaches the internet, and your `data/` and `.env` are not used. It sends Ctrl-C during metadata and a hard kill during downloads, then reruns. It also retries failures, rescrapes to check for duplicates, refreshes changed metrics with `--force` (including a degraded page that must not erase content) and exports. It prints PASS/FAIL per subsystem and exits non-zero on any failure.

## Profile collection

```sh
npm run scrape:profile -- corteiz               # one competitor
npm run scrape:profile -- corteiz @wishoodie    # several; same forms as competitors.txt
npm run scrape:profile -- --all                 # every competitor, never-scraped and oldest first
```

Usernames must be in SQLite already (`npm run competitors:import`). The command first checks the saved session (see Instagram login below), then opens each profile in turn, 6 to 12 seconds apart. A browser window stays open while it runs.

For each profile it saves:

- `competitors` (latest values): display name, bio, profile URL, external link, follower/following/post counts, verified, category, profile image path, `account_status` and `first_scraped_at`/`last_scraped_at`.
- `raw_profile_snapshots` (append-only): the collection timestamp, every extracted field, which source each field came from, the HTTP status, and Instagram's own user object as the raw observation.
- The profile image under `data/raw/media/profiles/<username>/<hash>.jpg`. It is named by content hash, so an unchanged avatar is stored once.
- A `scrape_jobs` row (`job_type = 'profile'`).

`account_status` is one of:

- `active`: public profile, data collected.
- `private`: the profile exists but its posts are hidden. Header fields (name, bio, counts) are still saved.
- `unavailable`: Instagram says the page isn't available. It shows the same page for deleted, renamed, banned and never-existing accounts, and for accounts that blocked you, so this tool cannot tell them apart. Previously saved fields are kept; only the status and scrape time change.
- `unknown`: never collected successfully.

A field that cannot be found is null in the observation and is listed as `missing:` in the log. A degraded DOM/meta-only response preserves existing latest values instead of replacing exact counts or content with rounded or missing fields. Source JSON observations can update the latest values, including nulls; earlier observations stay in the snapshots.

### Failures

| Situation | What happens |
| --- | --- |
| Timeout, network error, HTTP 5xx, unrecognized page | Retried twice (after 5 s, then 15 s). If it still fails: error recorded, debug files written, next competitor. |
| Session expired | Batch stops with `Run: npm run instagram:login`. |
| CAPTCHA, 2FA, checkpoint, other security challenge | Batch stops; manual intervention required. Nothing is bypassed. |
| Rate limiting (HTTP 429 or "please wait a few minutes") | Batch stops; continuing would make it worse. |
| Ctrl-C | The current job is recorded as `interrupted`, the browser closes, the rest are skipped. Press twice to force. |

Every failure adds a `scrape_errors` row (`stage = 'profile'`) with the type, message, attempt count, whether it is retryable, and the debug file paths. A later successful scrape of that competitor marks its open profile errors resolved. The competitor's saved fields and status are not changed by a failure.

Debug files go to `data/debug/profile/<username>-<time>.{png,html,json}`: a full-page screenshot, the page HTML, and a JSON summary of the failure. The HTML can contain session tokens. It is under `data/`, which Git ignores; don't share it.

The exit code is 1 if any profile failed or the batch stopped early, and 130 after Ctrl-C.

### Headed versus headless

Instagram sends a logged-in headless Chromium a "Page couldn't load" page instead of the rendered profile. This includes Playwright's full Chromium in new headless mode, not just the headless shell. The scraper does not disguise the browser to avoid this. With `BROWSER_HEADED=false` it still works from the page meta tags, but counts become rounded (`2M` rather than `1,660,019`), and the log says so. Keep the default, headed, for exact numbers.

### Extraction strategy

Each field is taken from the first source that has it, in this order. The snapshot records which source was used (`sources`).

1. **Instagram's own JSON.** This is the server-rendered `<script type="application/json">` data plus the GraphQL (`/api/graphql`, `/graphql/query`) responses the page loads. The scraper looks for any object whose `username` equals the target and that has profile keys, and uses the most complete one. Objects for other users (suggested accounts, tagged users) are ignored. Both current and older key names are read:

   | Field | Keys |
   | --- | --- |
   | display name | `full_name` |
   | bio | `biography` |
   | followers | `follower_count`, `edge_followed_by.count` |
   | following | `following_count`, `edge_follow.count` |
   | posts | `media_count`, `all_media_count`, `edge_owner_to_timeline_media.count` |
   | verified, private | `is_verified`, `is_private` |
   | category | `category`, `category_name`, `business_category_name` |
   | external link | `external_url`, then `bio_links[0].url` |
   | profile image | `hd_profile_pic_url_info.url`, `profile_pic_url_hd`, `profile_pic_url` |

2. **Page structure.** No generated CSS class names are used.
   - Followers and following: the link whose `href` starts with `/<username>/followers/` or `/<username>/following/`, preferring the exact number in a `title` attribute over the visible text.
   - Post count, and following when not linked: a `<number> posts` / `<number> following` pattern in the `main header` text.
   - Verified: `svg[aria-label="Verified"]` in the header.
   - External link: a header link to `l.instagram.com/?u=…`, unwrapped to the real target.
   - Profile image: the header `img` whose `alt` names the user or says "profile picture".
3. **OpenGraph meta.** `og:title` gives the display name, `og:description` the counts (rounded), the `description` tag the bio, and `og:image` a small profile image.

Account status:

1. **Profile exists:** there is user JSON, `og:type=profile`, or a followers link.
2. **Private:** `is_private` in the JSON, or the text "This account is private" as a fallback.
3. **Unavailable:** needs a positive signal: HTTP 404 or the "page isn't available" text. A page with no profile data and no such signal is recorded as `unrecognized_page`, with debug files, and is never marked unavailable. A layout change therefore shows up as errors, not as deleted accounts.
4. **Session state:** checked with the same URL and element checks as login (login redirect, `/challenge/`, CAPTCHA iframes, verification code inputs).

Text patterns are the last resort and are English only. If your Instagram account uses another language, the JSON path still works; only the private and unavailable text fallbacks would miss.

## Post discovery

```sh
npm run discover -- wishoodie          # one competitor
npm run discover -- --all              # every competitor
npm run discover -- wishoodie --full   # walk the whole grid even if an earlier run already did
```

Discovery scrolls a competitor's profile grid the way a person would and saves every post and Reel URL it finds. It does not open posts or read their contents. Example output:

```text
Competitor: wishoodie

Discovered total: 144
New: 84
Previously known: 60

Saved for this competitor: 144 (profile shows 172; Instagram's grid ended first, the count includes posts the grid does not show)
Run: full, complete (Instagram reported no more posts)
```

"Discovered total" is what this run saw on the grid. "New" were not yet saved for this competitor, and "Previously known" were. Progress is logged after every scroll that finds something.

Each run also refreshes the profile (the same work as `scrape:profile`). A private or unavailable profile is reported and skipped.

### What is saved, and when

After every scroll, the newly seen posts are written in one short transaction before the next scroll starts:

- `posts`: one row per shortcode, with `url` in canonical form (`https://www.instagram.com/reel/<code>/` for Reels, `https://www.instagram.com/p/<code>/` otherwise) and `type` (`image`, `carousel`, `reel`, or `unknown`) from Instagram's grid data. `discovery_status` becomes `complete`. `extraction_status` stays `pending` for the later extraction stage; discovery never changes it.
- `competitor_posts`: links the post to the competitor. A collab post found on two competitors' grids is one `posts` row with two links, and counts for both in `competitors:list`.
- `collection_checkpoints` (`stage = 'discovery'`): the resume state, rewritten after every productive scroll.
- `scrape_jobs` (`job_type = 'discovery'`): `processed_items` is posts seen so far and `total_items` the profile's post count, updated as the run goes.

URLs are normalized from every link shape the grid uses (`/<user>/p/<code>/`, `/<user>/reel/<code>/`, `/p/…`, `/reels/…`, `/tv/…`, with or without query strings). The shortcode is the unique key, so the same post seen as `/p/` and `/reel/`, or seen twice in one run, is one row.

### End-of-profile detection

Instagram's grid is infinite scroll with a virtualized DOM: only about 40 posts are in the page at once, and older rows are removed as new ones load. Discovery therefore collects from two sources on every scroll and remembers the shortcodes it has seen this run (a set of short strings, so memory stays small even for thousands of posts):

- the links currently in `main` (`a[href]` matching a post path), and
- Instagram's own grid responses (`xdt_api__v1__feed__user_timeline_graphql_connection`), 12 posts each, with the shortcode, media type and `page_info.has_next_page`. The home-feed response that also arrives on profile pages is ignored.

After each scroll, the run stops at the first of these:

1. **Instagram says the grid is finished** (`has_next_page: false`). This is definitive and ends the run as complete. It holds even when the profile's post count is higher: that count includes posts the grid doesn't show. On wishoodie the grid ends at 144 while the profile says 172; a manual scroll to the bottom confirmed the same 144.
2. **Caught up** (incremental runs only, see resume below).
3. **No new content**: `DISCOVERY_MAX_IDLE_SCROLLS` scrolls in a row reveal nothing unseen. One quiet scroll is normal; Instagram often loads the next 12 only on the scroll after. To keep a slow or failed load from ending the run early:
   - After each scroll, the pause is `DISCOVERY_SCROLL_DELAY_MS` plus up to 50% jitter. It grows with each idle scroll, and the loop also waits (up to 15 s) for grid requests started by that scroll to finish.
   - From the second idle scroll on, it scrolls up half a screen before scrolling down, which retriggers Instagram's load-more.
   - Every scroll checks for a logout, a security challenge or a rate-limit page, and stops the batch if it finds one.
   - When the limit is reached, only unique posts seen in this walk count toward completion, compared with the exact count from profile JSON. Rounded DOM/meta counts and posts saved in earlier walks cannot prove completion. There is no missing-post tolerance. If Instagram last said more pages exist, or posts are missing, it pauses 30 s and tries one more round. If that also finds nothing, the run ends as incomplete (`loading_stalled`, `posts_missing`, or `end_unverified` when the exact count is unknown), and the next run continues it.
4. **Safety ceiling**: 2,000 scrolls (about 24,000 posts). The run is recorded as incomplete (`scroll_limit`).

An incomplete run is never recorded as complete, so the next run walks the grid again rather than switching to incremental mode.

### Resume

Instagram's grid always starts at the newest post, and normal browsing can't jump into the middle of it. Resuming therefore means scrolling back down past what's already saved. What makes it cheap is that nothing already saved is written or processed again:

- **Nothing is lost when a run stops.** Posts are saved as they are found, and the checkpoint is updated after every productive scroll. An interrupted, crashed or killed run loses at most one scroll's findings. Ctrl-C records the run as incomplete; a hard kill leaves the job `running`, and the next run marks it abandoned.
- **Choosing a mode.** The checkpoint's `completedAt` records when a run last reached the end of the grid.
  - **No completed walk yet** (first run, or every earlier run stopped early): full mode. The run walks the grid from the top. Posts already saved count as "Previously known" and don't reset the no-new-content counter, because that counter tracks what this run has seen, not what the database lacks. The log says when the run passes the previous stopping point (`deepestShortcode`) and starts finding new posts.
  - **A completed walk exists**: incremental mode. New posts appear at the top, so the run stops once it sees 24 posts in a row that were already saved before that walk. Pinned posts (up to 3, often old) are too few to trigger this. Posts saved by an interrupted incremental run don't count toward the 24, since older unsaved posts may still lie beyond them. On wishoodie, an incremental run took 2 scrolls instead of 14.
  - **`--full`** forces a complete walk, for example to catch posts an earlier run missed.
- **`--all` order.** Batches run competitors in `last_scraped_at` order, never-scraped first, so a batch cut short continues with the most out-of-date profiles.

Failures follow the profile collection rules above. One competitor failing is recorded with debug files, and the batch moves on. Session expiry, security challenges and rate limiting stop the batch.

The exit code is 1 if any competitor failed, stayed incomplete, or the batch stopped early; 130 after Ctrl-C.

## Post extraction

```sh
npm run scrape:posts -- competitor1            # pending posts of one competitor
npm run scrape:posts -- --all                  # every competitor
npm run scrape:posts -- wishoodie --limit 20   # at most 20 posts this run
npm run scrape:posts -- wishoodie --force      # also refresh posts already extracted
```

Each post is opened at `https://www.instagram.com/p/<shortcode>/`. That address works for Reels too, and unlike `/reel/<shortcode>/` it serves the full media object. Posts are processed in discovery order, 4 to 9 seconds apart. Each finished post is saved at once, in its own transaction.

`--resume` is accepted but changes nothing, because every run already resumes. By default a run takes:

- posts still `pending`,
- posts left `in_progress` by an interrupted or killed run, and
- `failed` posts that have failed fewer than 5 runs.

Posts marked deleted or restricted are skipped. `--force` also takes `complete` and permanently failed posts.

### What is saved

| Field | Column | Source |
| --- | --- | --- |
| Instagram media ID | `instagram_post_id` | `pk` |
| Type | `type` (`image`, `carousel`, `reel`), `product_type` | `media_type` (1, 8, 2) and `product_type` (`clips`) |
| Owner | `owner_username` | `user.username` |
| Caption | `caption` | `caption.text`, stored exactly as sent (emoji, any language, any length) |
| Hashtags, mentions | `hashtags_json`, `mentions_json` | parsed from the caption, lowercased and de-duplicated |
| Tagged accounts | `tagged_users_json` | `usertags.in[].user.username`, merged across carousel slides |
| Collaborators | `coauthors_json` | `coauthor_producers[].username` |
| Location | `location` | `location.name` (full object in raw JSON) |
| Published | `published_at` | `taken_at` as UTC ISO 8601 |
| Alt text | `accessibility_caption`; `media.alt_text` per slide | `accessibility_caption` |
| Likes, comments | `likes_count`, `comments_count` | `like_count`, `comment_count` |
| Hidden likes | `likes_hidden` | `like_and_view_counts_disabled` |
| Views, plays | `views_count`, `plays_count` | `view_count` or `video_view_count`; `ig_play_count` or `play_count` |
| Comments turned off | `comments_disabled` | `comments_disabled` |
| Duration | `duration_seconds` | `video_duration`, else `mediaPresentationDuration` in `video_dash_manifest` |
| Audio | `audio_title`, `audio_artist`, `audio_type` | `clips_metadata.music_info.music_asset_info`, else `original_sound_info` |
| Thumbnail | `thumbnail_url` | largest `image_versions2` candidate |
| Size, slide count | `width`, `height`, `carousel_count` | `original_width`, `original_height`, `carousel_media_count` |
| Raw | `raw_json` | Instagram's media object, unmodified |

Also:

- **`media`**: one row per item (the single image or video, or each carousel slide) with type, source URL, size, duration and alt text; each slide's raw object goes in `media.raw_json`. `download_status` stays `pending` for a later media stage, since CDN URLs expire. Thumbnails aren't downloaded yet for the same reason.
- **`post_metrics_history`**: one row per post per run, so `--force` builds a metrics history. A retry within the same run can't add a second row.
- **`raw_post_snapshots`**: gets a row whenever `raw_json` changes (existing trigger).

Missing fields are null (empty JSON arrays for the lists) and never fail a post. Known gaps:

- **Hidden likes:** when the owner hides like counts, Instagram's JSON may still include a number, but the page doesn't show it. The scraper stores `likes_count = null` with `likes_hidden = 1`. The untouched number is still in `raw_json`.
- **Reel play and view counts:** post pages currently don't expose them (`view_count` is null, and there's no `play_count`), so they're usually null. They are visible on a profile's Reels tab, which a later stage could read.

### Extraction strategy

1. **Instagram's media object.** The page embeds it as `xdt_api__v1__media__shortcode__web_info.items[0]`, and GraphQL responses can carry it too. The scraper takes every JSON object whose `code` equals the shortcode and that has `taken_at` or `media_type`, and uses the richest. A Reels feed on the page also contains other Reels; matching on the shortcode ignores them. No CSS classes are used.
2. **Page structure**, only for fields the JSON didn't provide:
   - caption: the `h1` in `main`,
   - publish time: the first `time[datetime]`,
   - likes: a `<number> likes` text pattern,
   - duration: the `<video>` element's `duration`,
   - type: whether a video is present.
3. **OpenGraph meta**, last:
   - owner and Reel/post type: the `og:url` path,
   - caption: `og:title`, which may be truncated,
   - thumbnail: `og:image`.

The log names any field that came from steps 2 or 3. A post extracted with no JSON at all has `raw_json` null, which makes a changed JSON layout easy to spot.

### Failures: retryable or not

| Outcome | Classified as | What happens |
| --- | --- | --- |
| "Page isn't available", HTTP 404/410 | permanent (`post_unavailable`) | `extraction_status = 'failed'`, `availability = 'unavailable'`. Not retried without `--force`. |
| "This account is private" and similar | permanent (`post_restricted`) | `extraction_status = 'blocked'`, `availability = 'restricted'`. Not retried without `--force`. |
| Timeout, network error, HTTP 5xx | retryable | Up to 3 tries in the run (waits of 5 s, then 15 s). Then `failed`, `extraction_attempts + 1`, retried next run. |
| No post data and no unavailable/private signal (layout change, half-loaded page) | retryable (`unrecognized_page`) | Same as above. Debug files show what the page looked like. Never recorded as deleted. |
| Any other error | not retried within the run (`unexpected`) | `failed` and counted. Retried next run, like other failures, up to the cap. |
| Session expired, security challenge, rate limit (HTTP 429 or "please wait") | stops the batch | The post goes back to its previous status, and its attempt count is unchanged, because the problem isn't the post. The error is recorded; later posts are left for the next run. |
| Ctrl-C | stops the batch | The current post goes back to `pending`. |

After 5 failed runs a post is left alone until `--force`, so a broken post can't be retried forever. Every failure adds a `scrape_errors` row (`stage = 'extraction'`) with the post, type, message, retryability and attempt count, plus debug files under `data/debug/posts/`. A later success marks that post's errors resolved and resets its attempt count.

`extraction_status` is separate from `discovery_status`; extraction never changes discovery's state. A post left `in_progress` by a killed run is picked up again on the next run.

## Media download

```sh
npm run media -- competitor1                # every extracted post of one competitor
npm run media -- --all --limit 50           # at most 50 posts per competitor this run
npm run media -- competitor1 --refresh-expired
```

`media` works on posts that `scrape:posts` has extracted, using the image and video URLs saved then. It downloads them from Instagram's CDN with plain HTTPS requests. It sends no Instagram cookies, doesn't open a browser, and loads no instagram.com pages. Files are fetched 0.3 to 0.9 seconds apart.

### Layout

```text
data/competitors/<username>/posts/<SHORTCODE>/
  metadata.json      post fields, media file list (size, SHA-256, dimensions, source URL, status), Instagram's raw media object
  caption.txt        the caption exactly as posted, UTF-8 (empty if there is none)
  media/
    001.jpg          carousel slide 1 (or the post's only image/video)
    002.mp4          slide 2, a video: the extension comes from the file's own bytes, not the URL
    thumbnail.jpg    cover image, for posts with video
```

Folder names come only from the competitor's username and the post's shortcode, both checked against Instagram's own character sets (never caption text). Paths are checked to stay inside `DATA_DIR`. A collab post found on two competitors is stored once, under its primary competitor (`posts.competitor_id`). Shortcodes are case-sensitive, so `DATA_DIR` should be on a case-sensitive filesystem; on Windows drives mounted in WSL it isn't. If two shortcodes differing only in case ever map to the same folder, the second post fails with an error instead of mixing files.

For each item, the best version Instagram offered is used: the largest image by pixel count (candidate lists include smaller square crops), or the largest progressive MP4 for videos. `media.width` and `media.height` describe that downloaded file; `posts.width` and `posts.height` keep the original upload size.

### Safety of files

- **Reused:** a file already recorded as complete, whose size and format checks still pass, is kept without a request. SHA-256 is recorded at acquisition; reruns do not rehash every completed file.
- **Adopted:** a valid file already on disk but not in the database (for example after restoring the database) is recorded instead of downloaded again.
- **Moved aside, never overwritten:** an invalid file in an item's place is renamed to `<name>.corrupt-<time>`.
- **Downloads are atomic:** each goes to a hidden `.part` file in the same folder and is flushed to disk. Only after the checks below pass is it renamed to its final name, so `001.jpg` only ever holds a verified file. A crash leaves just a `.part` file, which the next run deletes.
- **Checks before the rename:**
  - HTTP status, and a `content-type` of image or video (a login page or an error page is rejected);
  - bytes received equal the declared `content-length`;
  - the format is identified from its first bytes, and the file is complete: a JPEG ends with its end-of-image marker, a PNG with `IEND`, a WebP's RIFF size matches, and an MP4's top-level boxes add up to exactly the file size and include `moov` and `mdat`;
  - the format matches the item (a "video" item must be a video).
- **`caption.txt` and `metadata.json`** are written through a temporary file and only when their content changed.
- **Size and hash** are stored for each file, in `media.bytes` and `media.sha256`.

### Failures

Media failures never change `extraction_status`. Each item's `download_status`, `last_error` and `download_attempts` record what happened, `posts.media_status` becomes `complete` or `failed`, and every failure adds a `scrape_errors` row (`stage = 'media'`).

| Situation | Handling |
| --- | --- |
| Timeout, dropped connection, HTTP 5xx, partial or corrupt file | Retried up to 3 times in the run (waits of 2 s, 6 s). Then recorded; retried on later runs, up to 5 failed attempts. |
| HTTP 403/404 (not expired), or a page instead of media | Not retried in the run; counted. Nothing is done to work around it. |
| Signed URL expired | Detected from the URL's `oe` expiry before any request, or from the CDN's "expired" answer. Not counted as a failed attempt. Needs a fresh URL. |
| HTTP 429 from the CDN | The run stops. |
| Post extracted without any media items | Recorded as `no_media_items`. |

**Expired links.** Instagram's media URLs are signed and expire, usually within a few days of extraction (`oe` in the URL). The tool never alters a signature. `--refresh-expired` re-extracts only the posts with expired links, by opening their post pages with your saved session (an instagram.com page load per post, like `scrape:posts`), then downloads again with the new URLs. Without that flag, `media` makes no instagram.com requests. Running `media` soon after `scrape:posts` avoids expired links entirely.

Ctrl-C stops after the current file; finished files are kept and the next run continues.

## Comments (optional)

```sh
npm run scrape:comments -- competitor1                  # up to 100 comments per post
npm run scrape:comments -- competitor1 --limit 250
npm run scrape:comments -- competitor1 --limit all      # no comment cap; the safety limits below still apply
npm run scrape:comments -- --all --force                # revisit posts that are already done
```

Not part of the metadata path: it runs only on posts whose extraction is complete, has its own status columns, and never changes `extraction_status`. A failed comment run records `posts.comments_status = 'failed'` plus a `scrape_errors` row (`stage = 'comments'`), and is retried on later runs (up to 5).

**What is saved** (`comments`): username, text, Instagram's comment id when exposed, like count, publish time, `parent_comment_id` for replies, and `raw_json`. `raw_json` holds only those public fields and the verified flag, not the API's full user object. Comments are saved after every load-more round, so an interrupted run keeps everything so far.

**Where comments come from.** The tool opens `/p/<shortcode>/` with your saved session and reads the comment data Instagram's own page requests return (and any inline data). If none arrives, it falls back to the visible top-level list (no ids; the caption row is skipped). Instagram's page structure is not a stable API, so if a layout change stops collection, the run ends as `partial` with a reason instead of saving guesses.

**Replies.** "View replies" controls are never clicked. Replies are saved only when Instagram already sent them, linked through `parent_comment_id`. Comments and replies together count toward `--limit`.

**Deduplication.** One row per Instagram comment id per post. Without an id, per user + text + time. A comment first read from the page without an id is upgraded in place when the data later supplies the id. Reruns refresh like counts.

**Per-post tracking** (`posts`): `comments_status` (`pending`, `in_progress`, `complete`, `failed`), `comments_completion` (`complete` = collection reached the visible end, `partial` = a cap, stall, unknown end, or count mismatch), `comments_stop_reason`, `comments_collected`, `comments_last_collected_at`. Stop reasons: `end_of_comments`, `limit_reached`, `stalled`, `max_rounds`, `time_limit`, `comments_disabled`, `no_comments`, `none_visible`, `count_mismatch`. Exhausted replies cannot end pagination of top-level comments, and duplicate comments do not consume an increased limit.

**Resume.** A rerun visits pending, interrupted and failed posts, and partial posts only when the new `--limit` is above what is saved (or is `all`). Earlier comments count toward the limit and are not saved twice. Posts with comments turned off or a comment count of 0 are marked complete from saved metadata, with no page load.

**Safety limits** (apply to `--limit all` too; set in `.env`, see `.env.example`):

| Variable | Default | Ends a post when |
| --- | --- | --- |
| `COMMENTS_MAX_ROUNDS` | 60 | this many load-more steps were taken (`max_rounds`) |
| `COMMENTS_MAX_IDLE_ROUNDS` | 3 | this many steps in a row showed nothing new (`stalled`) |
| `COMMENTS_MAX_SECONDS` | 300 | the post has taken this long (`time_limit`) |
| `COMMENTS_ROUND_DELAY_MS` | 2500 | pause between steps (jittered ±25%) |

Posts are opened 6 to 12 seconds apart. HTTP 429, a security challenge or an expired session stops the whole run without counting against the post.

## Frame extraction

```sh
npm run process:frames -- competitor1                       # one frame per second
npm run process:frames -- competitor1 --frame-interval 5
npm run process:frames -- competitor1 --max-frames 120      # long Reels: widen the interval to stay under 120 frames
npm run process:frames -- --all --force                     # redo Reels that are already done
```

Uses the FFmpeg that `npm install` downloads (or `FFMPEG_PATH` in `.env`); the command checks this first. Runs on downloaded Reels only (`npm run reels` first), one at a time, with no instagram.com requests. ffmpeg is started with an argument list, never a shell string.

Frames go next to the video: `<post dir>/frames/<generation>/frame_00001.jpg, …`. Extraction happens in a new `<generation>.partial/` directory. After success it is renamed, SQLite switches to that generation in a transaction, and old generations are removed. Failed replacements preserve the previous frames; a hard kill can leave an extra generation for later cleanup. Each frame is recorded in `reel_frames` (`timestamp_seconds` = index × interval, first frame at 0; unique per post). Even a Reel shorter than the interval yields a frame. `posts.frames_status` is `complete` or `failed` (reason in `frames_status_reason`; interval and count in `frames_interval_seconds`, `frames_count`). Completed Reels are skipped while their frames exist on disk, even with a different `--frame-interval`; `--force` replaces the rows and files. Files that are not a valid MP4, or that FFmpeg cannot decode, are marked `failed` and retried next run.

## Reel transcription

Pick a provider in `.env`. All three use the same OpenAI-style transcription API, so switching is only configuration:

| `TRANSCRIPTION_PROVIDER` | Key | Default `TRANSCRIPTION_MODEL` | Cost |
| --- | --- | --- | --- |
| `groq` | `GROQ_API_KEY` (console.groq.com) | `whisper-large-v3-turbo` | Free tier with rate limits |
| `openai` | `OPENAI_API_KEY` | `whisper-1` | Paid per audio minute |
| `custom` | `TRANSCRIPTION_API_KEY`, if the server needs one | set `TRANSCRIPTION_MODEL` | Free when self-hosted |

**Local Whisper (free, private).** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) serves the same API. On a Mac (Apple Silicon uses the GPU, so `large-v3-turbo` runs many times faster than real time):

```sh
brew install whisper-cpp ffmpeg
curl -L -o ~/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
whisper-server -m ~/ggml-large-v3-turbo.bin -l auto --convert --inference-path /v1/audio/transcriptions --port 8080
```

```env
TRANSCRIPTION_PROVIDER=custom
TRANSCRIPTION_BASE_URL=http://127.0.0.1:8080/v1
TRANSCRIPTION_MODEL=large-v3-turbo
```

Keep `-l auto`: whisper.cpp otherwise assumes English. Leave the server running while the collector transcribes. On a CPU-only laptop the turbo model is slow; use a smaller model (`ggml-small.bin`) or `groq`.

`custom` needs `TRANSCRIPTION_BASE_URL`, the server's `/v1` URL (e.g. a local Whisper server at `http://localhost:8000/v1`). `TRANSCRIPTION_MODEL` overrides any default and `TRANSCRIPTION_API_KEY` overrides any key variable. Whisper models report the detected language and timed segments; OpenAI's `gpt-4o` transcribe models return text only. FFmpeg comes with `npm install` (`ffmpeg-static`); `FFMPEG_PATH` selects another binary. No language is forced, so multilingual audio stays in its spoken languages.

```sh
npm run process:transcripts -- competitor1
npm run process:transcripts -- competitor1 --force
npm run process:transcripts -- --all
```

The command uses downloaded Reel files only and makes no Instagram requests. It extracts temporary MP3 audio before sending it to the configured provider. Reels without an audio track get an empty, completed transcript; an empty provider transcript is also recorded as no speech. Results, detected language, segments, provider, model, and raw provider JSON are saved in `transcripts`. Completed Reels are skipped unless `--force`; a forced run adds a new result without deleting the previous one. Failures set `posts.transcript_status` and `posts.transcript_error` independently of scraping and Reel status. A failed forced retry leaves the previous transcript and completed status intact.

The direct command checks FFmpeg before processing posts. Provider HTTP 401/403/429/5xx stops that transcript stage without consuming each post's retry budget. Audio uploads are capped at 25 MiB and requests at 120 seconds; there is no audio chunking. If a process dies after the provider accepted a request but before SQLite records it, the retry can send the audio again.

## Reel pipeline

```sh
npm run reels -- competitor1                  # CDN downloads and local processing only
npm run reels -- wishoodie --refresh --limit 10
npm run reels -- --all
```

The Reel pipeline is a separate layer over the other two:

```text
Instagram extraction layer   scrape:posts (post-scraper.ts)  post pages -> metadata + signed media URLs
        ↓
Media acquisition layer      media (media.ts)                signed URLs -> verified files on disk
        ↓
Reel processing layer        reels (reels.ts)                per-Reel status, access decision, MP4 probe
```

The processing layer never loads instagram.com. It reads what extraction stored and asks the acquisition layer for files. Metadata is the primary dataset: a Reel whose video can't be saved keeps every extracted field, and a video problem never changes `extraction_status`.

### Lifecycle

Each Reel (`posts.type = 'reel'`) has `reel_status`, with the reason in `reel_status_reason` and the time in `reel_updated_at`:

```text
            ┌──────────── metadata missing / link expired ─────────────┐
            ▼                                                          │
         pending ──access OK──▶ download ──verified──▶ downloaded ──probe OK──▶ processed
            │                      │                        │
            │                      └─failed─▶ failed ◀──────┘ probe failed (file set aside, re-downloaded next run)
            │                                   │
            └── deleted / restricted / no video served ──▶ unavailable
```

| Status | Meaning | Next run |
| --- | --- | --- |
| `pending` | Waiting on something: metadata not collected yet, the signed link expired, or not tried yet. The reason says which. | Tries again. With `--refresh`, missing metadata and expired links are fetched first. |
| `downloaded` | Video saved and verified, not probed yet. A run only stops here if interrupted. | Probes it. |
| `processed` | Video saved, verified and probed. `video_probe_duration`, `video_width`, `video_height` and `video_has_audio` come from the MP4 itself. | Nothing, as long as the file is still there with the recorded size. No request is made. |
| `unavailable` | No legitimate access: the Reel was deleted, the account is restricted for this session, Instagram served no video URL, or the CDN refuses the file (HTTP 403/404 with no expiry). | Stays until extraction reports otherwise. |
| `failed` | Download or probe failed. | Retried, up to 5 failed downloads per media link; a fresh link resets the count. |

**Access decision.** Before any download, the Reel layer decides from what Instagram already served to this session, without a request. The Reel must have been extracted and be available (not deleted or restricted), extraction must have received a video URL, and that signed URL must not have expired. If any check fails, the Reel is recorded as `pending` or `unavailable` with the reason, and nothing is requested. The tool never builds, alters or re-signs media URLs.

**Processing.** The probe reads the MP4's own boxes: duration from `mvhd`, frame size from the video track's `tkhd`, and audio presence from the track handlers (`hdlr`). No ffmpeg is needed. Durations within 1.5 s or 5% of Instagram's metadata are normal: the file and Instagram's streaming manifest round differently, about 0.1 s here. A larger difference is noted in `reel_status_reason`, as is a missing audio track.

**Where things are in SQLite.**

- The video file: `media.local_path` (`media_type = 'video'`), with `bytes`, `sha256` and `download_status`.
- The thumbnail: `posts.thumbnail_path`.
- Both paths are relative to `DATA_DIR`.
- Files live in the post folder described under Media download (`media/001.mp4`, `media/thumbnail.jpg`).

### Edge cases

| Case | Handling |
| --- | --- |
| Metadata missing | `pending` ("metadata not collected yet"). `--refresh` extracts it from the Reel page (a page load with your session), then continues. |
| Expired media URL | Detected from the URL's `oe` value before any request: `pending`. `--refresh` re-extracts the Reel page for a new link. Expiry doesn't count as a failed attempt. |
| Failed download | Retried within the run (2 s, 6 s), then `failed`; retried on later runs up to the limit. |
| Interrupted download | Ctrl-C stops after the current file and marks the Reel `pending` ("interrupted"). The unfinished `.part` file never takes the real name and is deleted on the next run. |
| Corrupt file | A download that fails the format checks is never renamed into place. A file that passes them but can't be probed is moved to `001.mp4.corrupt-<time>`, and the Reel goes to `failed`; the next run downloads a fresh copy. |
| Media already present | A recorded file with the right size is kept, and a valid unrecorded file is adopted. A processed Reel whose file is intact is skipped with no request. |
| Deleted Reel | Before download: `unavailable`. After download: stays `processed`, keeps the local copy and all metadata, and the reason notes it was deleted on Instagram. |
| Session expired | Only `--refresh` uses the session. It checks the session before starting, and extraction stops the run if the session expires or a challenge appears. Those Reels stay `pending`, and nothing is bypassed. |
| Rate limiting by the CDN | The run stops. |

Rerunning is idempotent: each Reel's status is recomputed from the database and the files on disk, and finished work makes no network requests.

## Instagram login

One-time setup: install the Chromium build that matches the Playwright version.

```sh
npx playwright install chromium
```

Then log in:

```sh
npm run instagram:login
```

This opens a visible Chromium window on the Instagram login page. Type your username and password yourself; the tool never reads, stores, or fills credentials. When Instagram shows the logged-in home page, the tool confirms it with a fresh page load, saves the session, and closes the browser. If you close the window early or `LOGIN_TIMEOUT_MS` passes, nothing is saved.

If Instagram shows a CAPTCHA, 2FA prompt, checkpoint, or suspicious-login confirmation, the tool logs a warning and waits while you complete it in the window. It does not touch or work around the challenge. Detection is by URL and page elements, not page text, so an unusual challenge page may go unannounced; it still will not be saved as logged in.

Check the saved session at any time:

```sh
npm run dev -- instagram-status
```

It loads the saved session (in a window unless `BROWSER_HEADED=false`) and reports whether it is still logged in. A missing or expired session stops with `Run: npm run instagram:login`. A security challenge stops with a message that manual intervention is required; run `instagram:login` and complete it in the window. Collection code calls `InstagramSessionManager.open()`, which throws `SessionExpiredError` or `ManualInterventionError` in those cases and refreshes the saved state on success.

### Where the session is saved

`data/browser/instagram-state.json` (under `DATA_DIR`). It is Playwright's storage state: Instagram cookies including the live `sessionid`, plus localStorage. Treat it like a password. The file is mode `0600` in a `0700` directory, and it is ignored by Git (`data/`, `instagram-state.json*`, and `*.storage-state.json` in `.gitignore`). To log out locally, delete the file.

## Project layout

```text
competitors.txt        Competitor usernames or profile URLs
.env.example            Example local settings
migrations/             Ordered SQLite schema changes
src/cli.ts              CLI entry point
src/browser.ts          BrowserManager: one Chromium instance, contexts closed together
src/instagram-session.ts  InstagramSessionManager: manual login, session reuse, logged-out detection
src/profile-extract.ts   Profile field extraction from JSON, DOM and meta (no browser; unit tested)
src/profile-scraper.ts   Profile page loading, retries, debug files, saving, batch runs
src/discovery.ts         Post discovery: grid scrolling, URL normalization, end detection, resume
src/post-extract.ts      Post field extraction from the media object, DOM and meta (no browser; unit tested)
src/post-scraper.ts      Post selection, page loading, retries, saving, batch runs
src/media.ts             Media downloads, per-post folders, metadata.json and caption.txt
src/media-files.ts       Safe paths, signed-URL expiry, file format and completeness checks, MP4 probe
src/reels.ts             Reel lifecycle: access decision, acquisition, MP4 probe, reel_status
src/frames.ts            FFmpeg frame extraction and generation replacement
src/transcripts.ts       Audio extraction, transcript state and persistence
src/transcription-provider.ts  OpenAI-compatible transcription requests
src/comments.ts          Comment pagination, deduplication and bounded collection
src/pipeline.ts          Stage orchestration and checkpoints
src/batch.ts             Status and targeted retries
src/export.ts            Streaming JSON and CSV exports
src/competitors.ts      Username normalization, list query
src/config.ts           Configuration validation
src/db.ts               SQLite connection and migration runner
src/logger.ts           Timestamped console logging
src/paths.ts            Data directory paths
data/browser/           Saved Instagram session (secret)
data/debug/             Screenshots and HTML from failed scrapes (may contain session tokens)
data/competitors/       Per-post folders: media files, caption.txt, metadata.json
data/raw/               Collector SQLite database and profile images
data/exports/           Regenerable JSON and CSV exports
data/derived/           Reserved for future AI output
```

The default `data/` directory and `.env` files are ignored by Git. Back up the whole `DATA_DIR`, including `competitors/` (post media and frames), `raw/` (database and avatars), and any derived output. Stop the collector and scheduler before copying it; copying only a live SQLite main file can lose committed WAL transactions. Browser state and debug files are sensitive. See the [backup strategy](PRODUCTION_REVIEW.md#8-backup-strategy) for retention and restore checks. A custom `DATA_DIR` outside `data/` needs its own Git ignore rule if it is inside the repository.

## Collection design

The collector takes one username at a time and uses Playwright with conservative pacing. It reads what its browser session can access. CAPTCHA, private accounts, authentication challenges, and access controls stop the affected work.

The database has these records:

- `competitors` holds the latest profile fields. Usernames are unique without regard to case. `raw_profile_snapshots` holds dated source JSON; a profile refresh should insert a snapshot before updating the latest fields.
- `posts` holds the latest post fields and separate discovery, extraction, media, comment, transcript, and frame statuses. Shortcodes and available Instagram post IDs are unique. New posts require a competitor. `competitor_posts` still records every profile where a post was found.
- `raw_post_snapshots` holds dated source JSON. Setting or changing `posts.raw_json` inserts a snapshot automatically. Existing snapshots from the initial schema remain intact.
- `media` is unique by post and position. `comments` uses Instagram comment IDs when available and a post, username, text, time key otherwise. `reel_frames` is unique by post and timestamp. `transcripts` holds transcript text and optional JSON.
- `collection_checkpoints` stores a JSON cursor per competitor and stage. `scrape_jobs` tracks current work and progress; `scrape_errors` keeps failures and retry details. The earlier `collection_runs`, `collection_errors`, and `media_assets` tables remain for existing datasets. Migration 002 copies existing media assets into `media`.
- `post_metrics_history` stores one observation per post per scrape job, with an observation time. Each refresh should insert a row, even when the counts have not changed, then update the latest counts on `posts` in the same transaction. A retry within one job cannot add a second observation. The `analysis` table is reserved for versioned results linked to a post or competitor; the collector does not write derived output.

Raw observations and metric history use foreign keys that restrict parent deletion. Triggers reject updates and deletes of snapshot and metric-history rows. Timestamps are UTC ISO 8601 text. SQLite foreign keys are enabled when the CLI opens the database.

The collector saves source observations and collection state in `data/raw/collector.sqlite`, with media in the paths above. Optional provider transcripts include provenance in the database. `analysis` and `data/derived/` are reserved for later analysis.

The migration runner applies numbered SQL files once, in filename order, inside transactions. Add a new migration for schema changes instead of editing an applied migration.
