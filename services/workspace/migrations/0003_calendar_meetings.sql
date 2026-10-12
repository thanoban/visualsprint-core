CREATE TABLE calendar_meetings(workspace_id uuid NOT NULL,connection_id uuid NOT NULL,occurrence_id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),fingerprint text NOT NULL,last_title text NOT NULL,status text NOT NULL CHECK(status IN ('confirmed','tentative','cancelled')),all_day boolean NOT NULL,declined boolean NOT NULL,starts_at timestamptz,ends_at timestamptz,
 PRIMARY KEY(workspace_id,connection_id,occurrence_id),UNIQUE(workspace_id,meeting_id),FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id));
ALTER TABLE calendar_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON calendar_meetings USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON calendar_meetings FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON calendar_meetings TO vs_workspace_runtime;
