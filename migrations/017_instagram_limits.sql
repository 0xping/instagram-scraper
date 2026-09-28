-- Instagram pages opened per local day, for the daily limit. Pushback seen in the browser (HTTP 429, or a jump
-- to a security-check page) is kept too: like a rate_limited or security_challenge scrape error, it starts a pause.
CREATE TABLE instagram_pages (day TEXT PRIMARY KEY, opened INTEGER NOT NULL DEFAULT 0);
CREATE TABLE instagram_pushback (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason TEXT NOT NULL
);
