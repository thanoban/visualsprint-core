CREATE TABLE event_work_index(workspace_id uuid PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX event_work_due ON event_work_index(next_at,workspace_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON event_work_index TO vs_workflow_runtime;
-- Transactional migration-owner backfill; FORCE is restored before the migration commits.
ALTER TABLE outbox NO FORCE ROW LEVEL SECURITY;
INSERT INTO event_work_index(workspace_id) SELECT DISTINCT workspace_id FROM outbox WHERE published_at IS NULL;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
