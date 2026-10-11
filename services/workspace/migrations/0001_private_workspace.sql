CREATE TABLE customers (workspace_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), version integer NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(workspace_id,id));
CREATE TABLE projects (workspace_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL,
 customer_id uuid, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), version integer NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id));
CREATE TABLE meetings (workspace_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), notes text NOT NULL DEFAULT '' CHECK(length(notes)<=32000), join_url text,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), blocked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id));
CREATE TABLE meeting_readers (workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,meeting_id,user_id), FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE meeting_assignments (workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, project_id uuid NOT NULL, confirmed_by uuid NOT NULL,
 PRIMARY KEY(workspace_id,meeting_id,project_id), FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id));
CREATE TABLE commands (workspace_id uuid NOT NULL, actor_id uuid NOT NULL, key text NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(workspace_id,actor_id,key));
CREATE TABLE outbox (workspace_id uuid NOT NULL, id uuid NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, lease_until timestamptz, lease_token uuid, attempts integer NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,id));
CREATE INDEX outbox_pending ON outbox(workspace_id,created_at,id) WHERE published_at IS NULL;
CREATE TABLE inbox (workspace_id uuid NOT NULL, event_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,event_id));

-- Migration connection owns DDL; runtime is a separately provisioned non-owner role.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['customers','projects','meetings','meeting_readers','meeting_assignments','commands','outbox','inbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON customers,projects,meetings,meeting_readers,meeting_assignments,commands,outbox,inbox TO vs_workspace_runtime;
