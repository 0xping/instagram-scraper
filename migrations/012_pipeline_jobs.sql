-- npm run scrape: one scrape_jobs row (job_type = 'pipeline') per run, with every stage's outcome as JSON
-- ({"<stage>": {"status", "detail", "counts", "at"}}), written after each stage so a rerun can resume.
ALTER TABLE scrape_jobs ADD COLUMN stages_json TEXT CHECK (stages_json IS NULL OR json_valid(stages_json));
