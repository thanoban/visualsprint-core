CREATE TABLE connections (
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('google','microsoft')),
 status text NOT NULL CHECK(status IN ('authorizing','exchanging','exchange_unknown','initializing','connected','reauth_required','configuration_error','disconnected')),
 calendar_id text NOT NULL,calendar_name text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 oauth_hash text NOT NULL,oauth_cipher text,oauth_expires_at timestamptz NOT NULL,
 token_cipher text,token_expires_at timestamptz,exchange_at timestamptz,error_code text,
 grant_id uuid,automatic boolean NOT NULL DEFAULT false,
 lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),CHECK(NOT automatic OR (grant_id IS NOT NULL AND status='connected'))
);
CREATE TABLE commands(workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,connection_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,key),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id));
CREATE TABLE outbox(workspace_id uuid NOT NULL,id uuid NOT NULL,event jsonb NOT NULL,published_at timestamptz,lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['connections','commands','outbox'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
-- Own scheduler routing only; never token, actor, event or permission content.
CREATE TABLE connection_work_index(connection_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id));
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON connections,commands,outbox,connection_work_index TO vs_integration_runtime;
