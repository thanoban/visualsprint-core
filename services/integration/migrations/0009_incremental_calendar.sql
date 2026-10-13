ALTER TABLE calendar_syncs ADD COLUMN incremental boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_syncs ADD COLUMN signal_revision bigint NOT NULL DEFAULT 0 CHECK(signal_revision>=0);
CREATE TABLE calendar_sync_checkpoints(
 workspace_id uuid NOT NULL,connection_id uuid NOT NULL,calendar_id text NOT NULL,connection_version integer NOT NULL,
 source_cursor text CHECK(length(source_cursor)<=16000),generation uuid NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,last_full_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,connection_id,calendar_id),FOREIGN KEY(workspace_id,generation) REFERENCES calendar_syncs(workspace_id,id));
CREATE TABLE calendar_change_rounds(
 workspace_id uuid NOT NULL,sync_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN('detecting','snapshot','unchanged')),
 source_cursor text,page_cursor text,candidate_cursor text,base_generation uuid,changed boolean NOT NULL DEFAULT false,
 page_count integer NOT NULL DEFAULT 0 CHECK(page_count BETWEEN 0 AND 20),cursor_hashes jsonb NOT NULL DEFAULT '[]',error_code text,
 PRIMARY KEY(workspace_id,sync_id),FOREIGN KEY(workspace_id,sync_id) REFERENCES calendar_syncs(workspace_id,id));
CREATE TABLE calendar_sync_signals(workspace_id uuid NOT NULL,connection_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),PRIMARY KEY(workspace_id,connection_id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['calendar_sync_checkpoints','calendar_change_rounds','calendar_sync_signals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP;END $$;
REVOKE ALL ON calendar_sync_checkpoints,calendar_change_rounds,calendar_sync_signals FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON calendar_sync_checkpoints,calendar_change_rounds,calendar_sync_signals TO vs_integration_runtime;
