-- Latest-job lookup and id-less comment reconciliation grow with the lifetime dataset.
CREATE INDEX scrape_jobs_by_competitor_type_id ON scrape_jobs (competitor_id, job_type, id DESC);
CREATE INDEX comments_by_identity ON comments (post_id, username, text, published_at);
