CREATE TABLE capture_processing_withdrawals(
 workspace_id uuid NOT NULL,capture_id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,
 policy_version text NOT NULL CHECK(policy_version='english-text-v1'),PRIMARY KEY(workspace_id,capture_id)
);
ALTER TABLE capture_processing_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_processing_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON capture_processing_withdrawals
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON capture_processing_withdrawals FROM PUBLIC;
GRANT SELECT,INSERT ON capture_processing_withdrawals TO vs_account_runtime;
