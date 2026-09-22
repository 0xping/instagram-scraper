CREATE TABLE competitors (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE raw_profile_snapshots (
  id INTEGER PRIMARY KEY,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX profile_snapshots_by_competitor ON raw_profile_snapshots (competitor_id, captured_at);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  shortcode TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('post', 'reel', 'carousel') OR kind IS NULL),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_attempt_at TEXT,
  collected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX posts_by_status ON posts (status);

CREATE TABLE competitor_posts (
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  post_id INTEGER NOT NULL REFERENCES posts(id),
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (competitor_id, post_id)
);
CREATE INDEX competitor_posts_by_post ON competitor_posts (post_id);

CREATE TABLE raw_post_snapshots (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX snapshots_by_post ON raw_post_snapshots (post_id, captured_at);

CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  ordinal INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  local_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_attempt_at TEXT,
  downloaded_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (post_id, ordinal)
);

CREATE TABLE collection_checkpoints (
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  stage TEXT NOT NULL,
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (competitor_id, stage)
);

CREATE TABLE collection_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

CREATE TABLE collection_errors (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES collection_runs(id),
  competitor_id INTEGER REFERENCES competitors(id),
  post_id INTEGER REFERENCES posts(id),
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX errors_by_competitor ON collection_errors (competitor_id, occurred_at);
