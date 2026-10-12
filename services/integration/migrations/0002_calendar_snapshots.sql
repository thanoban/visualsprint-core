CREATE TABLE calendar_syncs(
 workspace_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 calendar_id text NOT NULL,connection_version integer NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','complete','failed','blocked','superseded')),
 cursor text,cursor_hashes jsonb NOT NULL DEFAULT '[]',page_count integer NOT NULL DEFAULT 0 CHECK(page_count BETWEEN 0 AND 20),error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),CHECK(ends_at>starts_at));
CREATE UNIQUE INDEX one_active_calendar_sync ON calendar_syncs(workspace_id,connection_id) WHERE state IN ('queued','running');
CREATE INDEX calendar_sync_latest ON calendar_syncs(workspace_id,connection_id,created_at DESC);
CREATE TABLE calendar_sync_commands(workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,connection_id uuid NOT NULL,sync_id uuid NOT NULL,PRIMARY KEY(workspace_id,actor_id,key),FOREIGN KEY(workspace_id,sync_id) REFERENCES calendar_syncs(workspace_id,id));
CREATE TABLE calendar_sync_stage(workspace_id uuid NOT NULL,sync_id uuid NOT NULL,source_key text NOT NULL,body jsonb NOT NULL,fingerprint text NOT NULL,PRIMARY KEY(workspace_id,sync_id,source_key),FOREIGN KEY(workspace_id,sync_id) REFERENCES calendar_syncs(workspace_id,id));
CREATE TABLE calendar_occurrences(workspace_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,calendar_id text NOT NULL,source_key text NOT NULL,body jsonb NOT NULL,fingerprint text NOT NULL,version integer NOT NULL DEFAULT 1,generation uuid NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,connection_id,calendar_id,source_key),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['calendar_syncs','calendar_sync_commands','calendar_sync_stage','calendar_occurrences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON calendar_syncs,calendar_sync_commands,calendar_sync_stage,calendar_occurrences FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON calendar_syncs,calendar_sync_commands,calendar_sync_stage,calendar_occurrences TO vs_integration_runtime;
