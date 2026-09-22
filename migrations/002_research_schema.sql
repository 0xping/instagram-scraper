-- Keep 001's observations and checkpoints. New collection records use the fields below.
ALTER TABLE competitors ADD COLUMN display_name TEXT;
ALTER TABLE competitors ADD COLUMN bio TEXT;
ALTER TABLE competitors ADD COLUMN profile_url TEXT;
ALTER TABLE competitors ADD COLUMN external_url TEXT;
ALTER TABLE competitors ADD COLUMN followers_count INTEGER CHECK (followers_count >= 0);
ALTER TABLE competitors ADD COLUMN following_count INTEGER CHECK (following_count >= 0);
ALTER TABLE competitors ADD COLUMN posts_count INTEGER CHECK (posts_count >= 0);
ALTER TABLE competitors ADD COLUMN verified INTEGER CHECK (verified IN (0, 1));
ALTER TABLE competitors ADD COLUMN category TEXT;
ALTER TABLE competitors ADD COLUMN profile_image_path TEXT;
ALTER TABLE competitors ADD COLUMN account_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE competitors ADD COLUMN first_scraped_at TEXT;
ALTER TABLE competitors ADD COLUMN last_scraped_at TEXT;
CREATE UNIQUE INDEX competitors_username_nocase ON competitors (username COLLATE NOCASE);
CREATE INDEX competitors_by_status ON competitors (account_status);

-- Existing posts may have no owner; retain them and recover an owner from 001's links.
ALTER TABLE posts ADD COLUMN competitor_id INTEGER REFERENCES competitors(id) ON DELETE RESTRICT;
ALTER TABLE posts ADD COLUMN instagram_post_id TEXT;
ALTER TABLE posts ADD COLUMN type TEXT NOT NULL DEFAULT 'unknown'
  CHECK (type IN ('image', 'carousel', 'reel', 'unknown'));
ALTER TABLE posts ADD COLUMN caption TEXT;
ALTER TABLE posts ADD COLUMN published_at TEXT;
ALTER TABLE posts ADD COLUMN likes_count INTEGER CHECK (likes_count >= 0);
ALTER TABLE posts ADD COLUMN comments_count INTEGER CHECK (comments_count >= 0);
ALTER TABLE posts ADD COLUMN views_count INTEGER CHECK (views_count >= 0);
ALTER TABLE posts ADD COLUMN plays_count INTEGER CHECK (plays_count >= 0);
ALTER TABLE posts ADD COLUMN duration_seconds REAL CHECK (duration_seconds >= 0);
ALTER TABLE posts ADD COLUMN location TEXT;
ALTER TABLE posts ADD COLUMN thumbnail_path TEXT;
ALTER TABLE posts ADD COLUMN raw_json TEXT CHECK (raw_json IS NULL OR json_valid(raw_json));
ALTER TABLE posts ADD COLUMN discovery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (discovery_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (extraction_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN media_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (media_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN comments_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (comments_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN transcript_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (transcript_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN frame_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (frame_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked'));
ALTER TABLE posts ADD COLUMN first_scraped_at TEXT;
ALTER TABLE posts ADD COLUMN last_scraped_at TEXT;
ALTER TABLE posts ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE posts SET created_at = discovered_at;
UPDATE posts SET competitor_id = (
  SELECT MIN(competitor_id) FROM competitor_posts WHERE post_id = posts.id
);
CREATE TRIGGER posts_require_competitor BEFORE INSERT ON posts
WHEN NEW.competitor_id IS NULL
BEGIN SELECT RAISE(ABORT, 'posts.competitor_id is required'); END;
CREATE UNIQUE INDEX posts_instagram_id ON posts (instagram_post_id)
  WHERE instagram_post_id IS NOT NULL;
CREATE INDEX posts_by_competitor_published ON posts (competitor_id, published_at DESC);
CREATE INDEX posts_by_discovery_status ON posts (competitor_id, discovery_status);
CREATE INDEX posts_by_extraction_status ON posts (competitor_id, extraction_status);
CREATE INDEX posts_by_media_status ON posts (media_status) WHERE media_status != 'complete';
CREATE INDEX posts_by_comments_status ON posts (comments_status) WHERE comments_status != 'complete';
CREATE INDEX posts_by_transcript_status ON posts (transcript_status) WHERE transcript_status != 'complete';
CREATE INDEX posts_by_frame_status ON posts (frame_status) WHERE frame_status != 'complete';

-- A changed post payload is captured before the latest-value column is replaced.
CREATE TRIGGER posts_capture_raw_insert AFTER INSERT ON posts
WHEN NEW.raw_json IS NOT NULL
BEGIN
  INSERT INTO raw_post_snapshots (post_id, raw_json) VALUES (NEW.id, NEW.raw_json);
END;
CREATE TRIGGER posts_capture_raw_update BEFORE UPDATE OF raw_json ON posts
WHEN NEW.raw_json IS NOT NULL AND NEW.raw_json IS NOT OLD.raw_json
BEGIN
  INSERT INTO raw_post_snapshots (post_id, raw_json) VALUES (OLD.id, NEW.raw_json);
END;

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (media_type IN ('image', 'video', 'unknown')),
  position INTEGER NOT NULL CHECK (position >= 0),
  local_path TEXT,
  source_url TEXT,
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  duration_seconds REAL CHECK (duration_seconds >= 0),
  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked')),
  raw_json TEXT CHECK (raw_json IS NULL OR json_valid(raw_json)),
  UNIQUE (post_id, position)
);
CREATE INDEX media_by_download_status ON media (download_status)
  WHERE download_status != 'complete';
INSERT INTO media (post_id, position, local_path, source_url, download_status)
SELECT post_id, ordinal, local_path, source_url, status FROM media_assets;

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  instagram_comment_id TEXT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  likes_count INTEGER CHECK (likes_count >= 0),
  published_at TEXT,
  raw_json TEXT CHECK (raw_json IS NULL OR json_valid(raw_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX comments_instagram_id ON comments (post_id, instagram_comment_id)
  WHERE instagram_comment_id IS NOT NULL;
CREATE UNIQUE INDEX comments_fallback_identity ON comments (post_id, username, text, published_at)
  WHERE instagram_comment_id IS NULL AND published_at IS NOT NULL;
CREATE INDEX comments_by_post_published ON comments (post_id, published_at);

CREATE TABLE reel_frames (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  timestamp_seconds REAL NOT NULL CHECK (timestamp_seconds >= 0),
  image_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (post_id, timestamp_seconds)
);

CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  language TEXT,
  transcript TEXT NOT NULL,
  transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX transcripts_by_post ON transcripts (post_id);

CREATE TABLE scrape_jobs (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'blocked')),
  started_at TEXT,
  finished_at TEXT,
  current_stage TEXT,
  processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
  total_items INTEGER CHECK (total_items >= 0),
  error TEXT
);
CREATE INDEX scrape_jobs_by_competitor_status ON scrape_jobs (competitor_id, status, started_at);

CREATE TABLE scrape_errors (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
  post_id INTEGER REFERENCES posts(id) ON DELETE RESTRICT,
  url TEXT,
  stage TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);
CREATE INDEX scrape_errors_open ON scrape_errors (competitor_id, stage, created_at)
  WHERE resolved_at IS NULL;
CREATE INDEX scrape_errors_by_post ON scrape_errors (post_id);

CREATE TABLE analysis (
  id INTEGER PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE RESTRICT,
  competitor_id INTEGER REFERENCES competitors(id) ON DELETE RESTRICT,
  analysis_type TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (post_id IS NOT NULL OR competitor_id IS NOT NULL)
);
CREATE INDEX analysis_by_post ON analysis (post_id, analysis_type, created_at);
CREATE INDEX analysis_by_competitor ON analysis (competitor_id, analysis_type, created_at);

-- One row per observation, including repeated values, allows engagement trends by scrape run.
CREATE TABLE post_metrics_history (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  scrape_job_id INTEGER REFERENCES scrape_jobs(id) ON DELETE RESTRICT,
  likes_count INTEGER CHECK (likes_count >= 0),
  comments_count INTEGER CHECK (comments_count >= 0),
  views_count INTEGER CHECK (views_count >= 0),
  plays_count INTEGER CHECK (plays_count >= 0),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX post_metrics_by_post_time ON post_metrics_history (post_id, observed_at DESC);
CREATE UNIQUE INDEX post_metrics_by_job ON post_metrics_history (post_id, scrape_job_id)
  WHERE scrape_job_id IS NOT NULL;
