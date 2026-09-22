CREATE TRIGGER raw_profile_snapshots_no_update BEFORE UPDATE ON raw_profile_snapshots
BEGIN SELECT RAISE(ABORT, 'profile snapshots are append-only'); END;
CREATE TRIGGER raw_profile_snapshots_no_delete BEFORE DELETE ON raw_profile_snapshots
BEGIN SELECT RAISE(ABORT, 'profile snapshots are append-only'); END;

CREATE TRIGGER raw_post_snapshots_no_update BEFORE UPDATE ON raw_post_snapshots
BEGIN SELECT RAISE(ABORT, 'post snapshots are append-only'); END;
CREATE TRIGGER raw_post_snapshots_no_delete BEFORE DELETE ON raw_post_snapshots
BEGIN SELECT RAISE(ABORT, 'post snapshots are append-only'); END;

CREATE TRIGGER post_metrics_history_no_update BEFORE UPDATE ON post_metrics_history
BEGIN SELECT RAISE(ABORT, 'metric history is append-only'); END;
CREATE TRIGGER post_metrics_history_no_delete BEFORE DELETE ON post_metrics_history
BEGIN SELECT RAISE(ABORT, 'metric history is append-only'); END;
