-- Frame extraction state for npm run process:frames. NULL = never attempted.
--   complete  frames saved and recorded in reel_frames (frames_count rows)
--   failed    unsupported/corrupt video or ffmpeg error; retried on the next run
ALTER TABLE posts ADD COLUMN frames_status TEXT
  CHECK (frames_status IS NULL OR frames_status IN ('complete', 'failed'));
ALTER TABLE posts ADD COLUMN frames_status_reason TEXT;
-- Seconds between frames actually used (may exceed the requested one when --max-frames applies).
ALTER TABLE posts ADD COLUMN frames_interval_seconds REAL CHECK (frames_interval_seconds > 0);
ALTER TABLE posts ADD COLUMN frames_count INTEGER CHECK (frames_count >= 0);
ALTER TABLE posts ADD COLUMN frames_updated_at TEXT;
