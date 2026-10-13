CREATE TABLE calendar_capture_tombstones(
 workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,grant_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key));
ALTER TABLE calendar_capture_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_capture_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON calendar_capture_tombstones
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON calendar_capture_tombstones FROM PUBLIC;
GRANT SELECT,INSERT ON calendar_capture_tombstones TO vs_ingest_runtime;
