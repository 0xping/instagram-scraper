-- Reel lifecycle (npm run reels). NULL for posts that are not Reels.
--   pending      waiting for metadata, a fresh media link, or a first download
--   downloaded   video saved and verified; not yet probed
--   processed    video probed; duration/size/audio recorded below
--   unavailable  no legitimate access: Reel deleted, account restricted, or no video served to this session
--   failed       download or probe failed; retried on later runs up to the media attempt limit
ALTER TABLE posts ADD COLUMN reel_status TEXT
  CHECK (reel_status IS NULL OR reel_status IN ('pending', 'downloaded', 'processed', 'unavailable', 'failed'));
ALTER TABLE posts ADD COLUMN reel_status_reason TEXT;
ALTER TABLE posts ADD COLUMN reel_updated_at TEXT;
-- Read from the downloaded MP4 itself, independent of Instagram's metadata.
ALTER TABLE posts ADD COLUMN video_probe_duration REAL CHECK (video_probe_duration >= 0);
ALTER TABLE posts ADD COLUMN video_width INTEGER CHECK (video_width > 0);
ALTER TABLE posts ADD COLUMN video_height INTEGER CHECK (video_height > 0);
ALTER TABLE posts ADD COLUMN video_has_audio INTEGER CHECK (video_has_audio IN (0, 1));

UPDATE posts SET reel_status = 'pending', reel_status_reason = 'not processed yet' WHERE type = 'reel';
CREATE INDEX posts_by_reel_status ON posts (reel_status) WHERE reel_status IS NOT NULL;
