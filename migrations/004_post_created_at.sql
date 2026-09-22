-- SQLite cannot add a column with a nonconstant default to an existing table.
CREATE TRIGGER posts_set_created_at AFTER INSERT ON posts
WHEN NEW.created_at = ''
BEGIN
  UPDATE posts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
