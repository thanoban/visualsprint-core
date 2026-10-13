CREATE TABLE deletion_tombstones(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,deletion_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,meeting_id),UNIQUE(workspace_id,deletion_id));
CREATE TABLE cleanup_executions(workspace_id uuid NOT NULL,operation_id uuid NOT NULL,deletion_id uuid NOT NULL,approval_id uuid NOT NULL,payload_hash text NOT NULL,source_meeting_id uuid NOT NULL,source_revision integer NOT NULL,state text NOT NULL CHECK(state IN('dispatching','unknown','reconciling','confirmed')),external_id text,PRIMARY KEY(workspace_id,operation_id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['deletion_tombstones','cleanup_executions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
GRANT SELECT,INSERT ON deletion_tombstones TO vs_workflow_runtime;
GRANT SELECT ON cleanup_executions TO vs_workflow_runtime;
-- A bounded cleanup capability, not general approval-delete permission. It deletes private payloads
-- and preserves only execution references for the independently owned Integration cleanup/reconciliation.
CREATE FUNCTION purge_meeting_actions(target_workspace uuid,target_meeting uuid,target_deletion uuid,target_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF target_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')::uuid THEN RAISE EXCEPTION 'FORBIDDEN_CLEANUP'; END IF;
 IF NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE workspace_id=target_workspace AND meeting_id=target_meeting AND deletion_id=target_deletion AND source_version=target_version) THEN RAISE EXCEPTION 'TOMBSTONE_REQUIRED'; END IF;
 INSERT INTO cleanup_executions(workspace_id,operation_id,deletion_id,approval_id,payload_hash,source_meeting_id,source_revision,state,external_id)
 SELECT workspace_id,id,target_deletion,approval_id,payload_hash,source_meeting_id,source_revision,state,external_id FROM operations WHERE workspace_id=target_workspace AND source_meeting_id=target_meeting AND state IN('dispatching','unknown','reconciling','confirmed') ON CONFLICT DO NOTHING;
 DELETE FROM operation_work_index WHERE workspace_id=target_workspace AND operation_id IN(SELECT id FROM operations WHERE workspace_id=target_workspace AND source_meeting_id=target_meeting);
 DELETE FROM commands WHERE workspace_id=target_workspace AND (result->>'id' IN(SELECT id::text FROM actions WHERE workspace_id=target_workspace AND input->'source'->>'meetingId'=target_meeting::text) OR result->>'id' IN(SELECT id::text FROM operations WHERE workspace_id=target_workspace AND source_meeting_id=target_meeting));
 DELETE FROM operations WHERE workspace_id=target_workspace AND source_meeting_id=target_meeting;
 DELETE FROM approvals WHERE workspace_id=target_workspace AND source_meeting_id=target_meeting;
 DELETE FROM actions WHERE workspace_id=target_workspace AND input->'source'->>'meetingId'=target_meeting::text;
END $$;
REVOKE ALL ON FUNCTION purge_meeting_actions(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_meeting_actions(uuid,uuid,uuid,integer) TO vs_workflow_runtime;
