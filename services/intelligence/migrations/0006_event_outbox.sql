ALTER TABLE outbox ADD COLUMN lease_token uuid;
ALTER TABLE outbox ADD COLUMN lease_until timestamptz;
CREATE INDEX intelligence_outbox_pending ON outbox(workspace_id,created_at,id) WHERE published_at IS NULL;
-- Scheduler references only. Event content remains in tenant-RLS outbox rows.
CREATE TABLE intelligence_event_work_index(
 workspace_id uuid NOT NULL,event_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,event_id),
 FOREIGN KEY(workspace_id,event_id) REFERENCES outbox(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX intelligence_event_due ON intelligence_event_work_index(next_at,workspace_id);
CREATE FUNCTION route_intelligence_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO intelligence_event_work_index(workspace_id,event_id) VALUES(NEW.workspace_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER intelligence_event_route AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION route_intelligence_event();
-- The owning migration role temporarily uses its owner exemption to backfill
-- existing tenants inside this atomic migration; runtime tenant RLS stays enabled.
ALTER TABLE outbox NO FORCE ROW LEVEL SECURITY;
INSERT INTO intelligence_event_work_index(workspace_id,event_id)
 SELECT workspace_id,id FROM outbox WHERE published_at IS NULL;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON intelligence_event_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON intelligence_event_work_index TO vs_intelligence_runtime;
