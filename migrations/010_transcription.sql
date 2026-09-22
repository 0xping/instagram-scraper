-- Transcript attempts are append-only; a forced retry keeps the previous result.
ALTER TABLE transcripts ADD COLUMN model TEXT;
ALTER TABLE transcripts ADD COLUMN segments_json TEXT CHECK (segments_json IS NULL OR json_valid(segments_json));
ALTER TABLE transcripts ADD COLUMN has_speech INTEGER NOT NULL DEFAULT 1 CHECK (has_speech IN (0, 1));
ALTER TABLE posts ADD COLUMN transcript_error TEXT;
ALTER TABLE posts ADD COLUMN transcript_updated_at TEXT;
