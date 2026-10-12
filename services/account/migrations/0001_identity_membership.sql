CREATE TABLE users (id uuid PRIMARY KEY, subject text NOT NULL UNIQUE CHECK(subject ~ '^user_[a-zA-Z0-9]+$'));
CREATE TABLE workspaces (id uuid PRIMARY KEY, creator_id uuid NOT NULL REFERENCES users(id), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 cell_id text NOT NULL CHECK(length(cell_id) BETWEEN 1 AND 100), blocked boolean NOT NULL DEFAULT false);
CREATE TABLE memberships (workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','member')), active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(workspace_id,user_id));
CREATE INDEX membership_directory ON memberships(user_id,workspace_id) WHERE active;
CREATE TABLE revoked_sessions (user_id uuid NOT NULL REFERENCES users(id), session_id text NOT NULL, revoked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,session_id));
CREATE TABLE commands (user_id uuid NOT NULL REFERENCES users(id), key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE outbox (workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid PRIMARY KEY, event jsonb NOT NULL, published_at timestamptz);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['users','workspaces','memberships','revoked_sessions','commands','outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 END LOOP;
END $$;
CREATE POLICY identity_scope ON users USING (subject=current_setting('app.identity_subject',true) OR id=nullif(current_setting('app.actor_id',true),'')::uuid OR
 EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=users.id AND m.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid))
 WITH CHECK (subject=current_setting('app.identity_subject',true));
CREATE POLICY membership_scope ON memberships USING (user_id=nullif(current_setting('app.actor_id',true),'')::uuid OR workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
CREATE POLICY workspace_scope ON workspaces USING (creator_id=nullif(current_setting('app.actor_id',true),'')::uuid OR EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=workspaces.id AND m.user_id=nullif(current_setting('app.actor_id',true),'')::uuid AND m.active))
 WITH CHECK (creator_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY session_scope ON revoked_sessions USING(user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY command_scope ON commands USING(user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
CREATE POLICY outbox_scope ON outbox USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON users,workspaces,memberships,revoked_sessions,commands,outbox TO vs_account_runtime;
