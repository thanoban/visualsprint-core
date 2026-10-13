CREATE TABLE calendar_deletion_requests(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),PRIMARY KEY(workspace_id,id));
CREATE TABLE calendar_suppressed_occurrences(workspace_id uuid NOT NULL,connection_id uuid NOT NULL,calendar_id text NOT NULL,source_key text NOT NULL,PRIMARY KEY(workspace_id,connection_id,calendar_id,source_key));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['calendar_deletion_requests','calendar_suppressed_occurrences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON calendar_deletion_requests,calendar_suppressed_occurrences FROM PUBLIC;
GRANT SELECT,INSERT ON calendar_deletion_requests,calendar_suppressed_occurrences TO vs_integration_runtime;
