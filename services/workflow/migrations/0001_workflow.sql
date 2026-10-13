CREATE TABLE actions(workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('draft','approved','revoked')),input jsonb NOT NULL,payload_hash text NOT NULL CHECK(length(payload_hash)=64),approval_id uuid,PRIMARY KEY(workspace_id,id),CHECK(state<>'approved' OR approval_id IS NOT NULL));
CREATE TABLE approvals(workspace_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,actor_id uuid NOT NULL,payload_hash text NOT NULL,source_meeting_id uuid NOT NULL,source_revision integer NOT NULL CHECK(source_revision>0),input jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,id,payload_hash,source_meeting_id,source_revision),FOREIGN KEY(workspace_id,action_id) REFERENCES actions(workspace_id,id));
CREATE TABLE operations(workspace_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,approval_id uuid NOT NULL,payload_hash text NOT NULL,source_meeting_id uuid NOT NULL,source_revision integer NOT NULL,input jsonb NOT NULL,state text NOT NULL CHECK(state IN('queued','dispatching','unknown','reconciling','confirmed','rejected','cancelled')),external_id text,error_code text,version integer NOT NULL DEFAULT 1,lease_token uuid,lease_until timestamptz,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,approval_id),FOREIGN KEY(workspace_id,action_id) REFERENCES actions(workspace_id,id),FOREIGN KEY(workspace_id,approval_id,payload_hash,source_meeting_id,source_revision) REFERENCES approvals(workspace_id,id,payload_hash,source_meeting_id,source_revision),CHECK(state<>'confirmed' OR external_id IS NOT NULL));
CREATE TABLE commands(workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(workspace_id,actor_id,key));
CREATE TABLE outbox(workspace_id uuid NOT NULL,id uuid NOT NULL,event jsonb NOT NULL,published_at timestamptz,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['actions','approvals','operations','commands','outbox'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
CREATE TABLE operation_work_index(workspace_id uuid NOT NULL,operation_id uuid PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,operation_id) REFERENCES operations(workspace_id,id));
CREATE INDEX operation_work_due ON operation_work_index(next_at,operation_id);
CREATE FUNCTION check_operation_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved approvals; BEGIN
 SELECT * INTO approved FROM approvals WHERE workspace_id=NEW.workspace_id AND id=NEW.approval_id;
 IF approved.id IS NULL OR approved.input<>NEW.input OR approved.actor_id<>NEW.owner_id OR approved.action_id<>NEW.action_id THEN RAISE EXCEPTION 'APPROVAL_SNAPSHOT_MISMATCH'; END IF;
 IF TG_OP='UPDATE' AND (NEW.input<>OLD.input OR NEW.approval_id<>OLD.approval_id OR NEW.owner_id<>OLD.owner_id OR NEW.session_id<>OLD.session_id OR NEW.action_id<>OLD.action_id OR NEW.payload_hash<>OLD.payload_hash OR NEW.source_revision<>OLD.source_revision OR NEW.source_meeting_id<>OLD.source_meeting_id) THEN RAISE EXCEPTION 'IMMUTABLE_EXECUTION_INTENT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operation_snapshot BEFORE INSERT OR UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION check_operation_snapshot();
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON actions,operations,commands,outbox,operation_work_index TO vs_workflow_runtime;
GRANT SELECT,INSERT ON approvals TO vs_workflow_runtime;
-- The runtime cannot change or erase an approved snapshot. Domain deletion uses a separate narrowly scoped cleanup migration/capability.
