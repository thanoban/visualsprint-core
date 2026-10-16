-- Workspace-owned, explicitly owner-reviewed agendas. Generated preparation remains Intelligence-owned draft data.
CREATE TABLE reviewed_agendas(
 workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 250),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 32000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),reviewed boolean NOT NULL DEFAULT true CHECK(reviewed),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id)
);
CREATE INDEX reviewed_agendas_meeting ON reviewed_agendas(workspace_id,meeting_id,id);
CREATE TABLE agenda_commands(
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,
 meeting_id uuid NOT NULL,agenda_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN('create','update','delete')),
 agenda_version integer NOT NULL CHECK(agenda_version>0),PRIMARY KEY(workspace_id,actor_id,key),
 FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id)
);
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['reviewed_agendas','agenda_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON reviewed_agendas,agenda_commands FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON reviewed_agendas TO vs_workspace_runtime;
GRANT SELECT,INSERT,DELETE ON agenda_commands TO vs_workspace_runtime;
