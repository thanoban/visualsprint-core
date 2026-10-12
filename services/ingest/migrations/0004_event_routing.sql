-- Only the owning publisher may enumerate cell workspace routing references.
CREATE TABLE event_work_index(workspace_id uuid PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON event_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON event_work_index TO vs_ingest_runtime;
CREATE FUNCTION enqueue_event_workspace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_work_index(workspace_id) VALUES(NEW.workspace_id)
 ON CONFLICT(workspace_id) DO UPDATE SET next_at=LEAST(event_work_index.next_at,now());
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_outbox AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION enqueue_event_workspace();
