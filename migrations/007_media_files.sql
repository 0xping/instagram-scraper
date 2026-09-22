-- Local file bookkeeping for npm run media. local_path is relative to DATA_DIR.
ALTER TABLE media ADD COLUMN bytes INTEGER CHECK (bytes >= 0);
ALTER TABLE media ADD COLUMN sha256 TEXT;
ALTER TABLE media ADD COLUMN file_format TEXT;
ALTER TABLE media ADD COLUMN downloaded_at TEXT;
ALTER TABLE media ADD COLUMN download_attempts INTEGER NOT NULL DEFAULT 0 CHECK (download_attempts >= 0);
ALTER TABLE media ADD COLUMN last_error TEXT;
