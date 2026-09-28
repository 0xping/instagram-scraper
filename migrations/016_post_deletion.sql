-- A deleted post keeps its row (snapshots and metric history are append-only) as a marker that later collects skip.
ALTER TABLE posts ADD COLUMN deleted_at TEXT;
