-- Optional comment collection (npm run scrape:comments). Lifecycle lives in posts.comments_status (002):
--   pending      never attempted          in_progress  interrupted mid-run (resumed next run)
--   complete     a run finished normally; comments_completion says whether everything visible was reached
--   failed       the attempt failed; retried on later runs. Never changes posts.extraction_status.
ALTER TABLE posts ADD COLUMN comments_completion TEXT
  CHECK (comments_completion IS NULL OR comments_completion IN ('complete', 'partial'));
ALTER TABLE posts ADD COLUMN comments_stop_reason TEXT;
ALTER TABLE posts ADD COLUMN comments_collected INTEGER NOT NULL DEFAULT 0 CHECK (comments_collected >= 0);
ALTER TABLE posts ADD COLUMN comments_last_collected_at TEXT;
ALTER TABLE posts ADD COLUMN comments_attempts INTEGER NOT NULL DEFAULT 0 CHECK (comments_attempts >= 0);
-- Instagram id of the comment this one replies to; NULL for top-level comments.
ALTER TABLE comments ADD COLUMN parent_comment_id TEXT;
