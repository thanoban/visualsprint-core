CREATE TABLE calendar_capture_tasks(
 workspace_id uuid NOT NULL,connection_id uuid NOT NULL,occurrence_id uuid NOT NULL,owner_id uuid NOT NULL,grant_id uuid NOT NULL,
 target jsonb NOT NULL,enabled boolean NOT NULL,attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0),
 key text,intent jsonb,intent_fingerprint text,capture_id uuid,lease_token uuid,lease_until timestamptz,next_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connection_id,occurrence_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id));
ALTER TABLE calendar_capture_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_capture_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON calendar_capture_tasks
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON calendar_capture_tasks FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON calendar_capture_tasks TO vs_integration_runtime;
