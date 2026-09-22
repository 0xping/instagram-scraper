-- Fields filled by post extraction (npm run scrape:posts). JSON arrays are stored as text.
ALTER TABLE posts ADD COLUMN product_type TEXT;
ALTER TABLE posts ADD COLUMN owner_username TEXT;
ALTER TABLE posts ADD COLUMN hashtags_json TEXT CHECK (hashtags_json IS NULL OR json_valid(hashtags_json));
ALTER TABLE posts ADD COLUMN mentions_json TEXT CHECK (mentions_json IS NULL OR json_valid(mentions_json));
ALTER TABLE posts ADD COLUMN tagged_users_json TEXT CHECK (tagged_users_json IS NULL OR json_valid(tagged_users_json));
ALTER TABLE posts ADD COLUMN coauthors_json TEXT CHECK (coauthors_json IS NULL OR json_valid(coauthors_json));
ALTER TABLE posts ADD COLUMN accessibility_caption TEXT;
ALTER TABLE posts ADD COLUMN likes_hidden INTEGER CHECK (likes_hidden IN (0, 1));
ALTER TABLE posts ADD COLUMN comments_disabled INTEGER CHECK (comments_disabled IN (0, 1));
ALTER TABLE posts ADD COLUMN audio_title TEXT;
ALTER TABLE posts ADD COLUMN audio_artist TEXT;
ALTER TABLE posts ADD COLUMN audio_type TEXT;
ALTER TABLE posts ADD COLUMN width INTEGER CHECK (width > 0);
ALTER TABLE posts ADD COLUMN height INTEGER CHECK (height > 0);
ALTER TABLE posts ADD COLUMN carousel_count INTEGER CHECK (carousel_count >= 0);
ALTER TABLE posts ADD COLUMN thumbnail_url TEXT;
-- 'unknown' until extraction runs; 'unavailable' = deleted or never existed; 'restricted' = private or gated.
ALTER TABLE posts ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown'
  CHECK (availability IN ('unknown', 'available', 'unavailable', 'restricted'));
-- Failed extraction runs since the last success; bounds retries across runs.
ALTER TABLE posts ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0 CHECK (extraction_attempts >= 0);

ALTER TABLE media ADD COLUMN alt_text TEXT;

CREATE INDEX posts_by_competitor_extraction ON posts (competitor_id, extraction_status);
