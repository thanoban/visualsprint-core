CREATE TABLE meeting_deletions(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,deletion_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),PRIMARY KEY(workspace_id,meeting_id),UNIQUE(workspace_id,deletion_id));
ALTER TABLE meeting_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON meeting_deletions USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON meeting_deletions FROM PUBLIC;
GRANT SELECT,INSERT ON meeting_deletions TO vs_ingest_runtime;
