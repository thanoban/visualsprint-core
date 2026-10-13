CREATE TABLE exports (
 workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 format text NOT NULL CHECK(format IN ('text','json')),state text NOT NULL CHECK(state IN ('queued','running','complete','failed','blocked','expired','deleted')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 fingerprint text,content text,error_code text,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id),CHECK((state='complete')=(content IS NOT NULL)),CHECK(content IS NULL OR octet_length(content)<=2000000)
);
CREATE TABLE export_commands(workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,export_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,export_id) REFERENCES exports(workspace_id,id));
CREATE TABLE deletion_requests(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE deletion_tombstones(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,meeting_id));
CREATE TABLE export_work_index(export_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,export_id) REFERENCES exports(workspace_id,id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['exports','export_commands','deletion_requests','deletion_tombstones'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON exports,export_commands,export_work_index TO vs_reporting_runtime;
GRANT SELECT,INSERT ON deletion_requests TO vs_reporting_runtime;
GRANT SELECT,INSERT,UPDATE ON deletion_tombstones TO vs_reporting_runtime;
