CREATE TABLE deletion_jobs(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 source_version integer NOT NULL CHECK(source_version>0),state text NOT NULL CHECK(state IN('pending','complete')),required jsonb NOT NULL,
 acknowledgements jsonb NOT NULL DEFAULT '{}'::jsonb,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,meeting_id));
CREATE TABLE deletion_commands(workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,deletion_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,deletion_id) REFERENCES deletion_jobs(workspace_id,id));
CREATE TABLE deletion_work_index(deletion_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,deletion_id) REFERENCES deletion_jobs(workspace_id,id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['deletion_jobs','deletion_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON deletion_jobs,deletion_commands,deletion_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON deletion_jobs,deletion_commands TO vs_workspace_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON deletion_work_index TO vs_workspace_runtime;
