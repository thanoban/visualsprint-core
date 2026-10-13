CREATE TABLE action_connections(workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN('jira','github','linear')),
 destination text NOT NULL,configuration jsonb NOT NULL,credential_cipher text,status text NOT NULL CHECK(status IN('configured','disconnected')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(workspace_id,id),CHECK(status<>'configured' OR credential_cipher IS NOT NULL));
CREATE TABLE action_connection_commands(workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,connection_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,connection_id) REFERENCES action_connections(workspace_id,id));
CREATE TABLE action_executions(workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,approval_id uuid NOT NULL,payload_hash text NOT NULL,
 connection_id uuid NOT NULL,connection_version integer NOT NULL,meeting_id uuid NOT NULL,source_revision integer NOT NULL,provider text NOT NULL,payload jsonb,
 state text NOT NULL CHECK(state IN('prepared','dispatching','confirmed','rejected','unknown','deleted')),external_id text,error_code text,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 lease_token uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,approval_id),
 CHECK(state<>'confirmed' OR external_id IS NOT NULL));
CREATE TABLE action_deletion_requests(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL,
 PRIMARY KEY(workspace_id,id));
CREATE TABLE action_deletion_tombstones(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL,
 PRIMARY KEY(workspace_id,meeting_id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['action_connections','action_connection_commands','action_executions','action_deletion_requests','action_deletion_tombstones'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON action_connections,action_connection_commands,action_executions,action_deletion_requests,action_deletion_tombstones FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON action_connections,action_connection_commands,action_executions,action_deletion_tombstones TO vs_integration_runtime;
GRANT SELECT,INSERT ON action_deletion_requests TO vs_integration_runtime;
CREATE FUNCTION immutable_action_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.owner_id,NEW.approval_id,NEW.payload_hash,NEW.connection_id,NEW.connection_version,NEW.meeting_id,NEW.source_revision,NEW.provider) IS DISTINCT FROM
 (OLD.workspace_id,OLD.id,OLD.owner_id,OLD.approval_id,OLD.payload_hash,OLD.connection_id,OLD.connection_version,OLD.meeting_id,OLD.source_revision,OLD.provider) THEN RAISE EXCEPTION 'IMMUTABLE_EXECUTION_INTENT'; END IF;
 IF NEW.payload IS DISTINCT FROM OLD.payload AND NOT(NEW.payload IS NULL AND NEW.state='deleted') THEN RAISE EXCEPTION 'IMMUTABLE_EXECUTION_PAYLOAD'; END IF; RETURN NEW; END $$;
CREATE TRIGGER action_execution_immutable BEFORE UPDATE ON action_executions FOR EACH ROW EXECUTE FUNCTION immutable_action_execution();
