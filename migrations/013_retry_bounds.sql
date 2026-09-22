-- Failed frame and transcript attempts, so retries are bounded like extraction, media and comments.
-- Reset to 0 on success; past the cap (5) a Reel is left alone until --force.
ALTER TABLE posts ADD COLUMN frames_attempts INTEGER NOT NULL DEFAULT 0 CHECK (frames_attempts >= 0);
ALTER TABLE posts ADD COLUMN transcript_attempts INTEGER NOT NULL DEFAULT 0 CHECK (transcript_attempts >= 0);
