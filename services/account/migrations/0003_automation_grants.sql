CREATE TABLE operation_grants (
 workspace_id uuid NOT NULL, id uuid NOT NULL, owner_id uuid NOT NULL,
 connection_id uuid NOT NULL, capability text NOT NULL CHECK(capability='calendar_capture'),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,user_id)
);
CREATE UNIQUE INDEX active_connection_grant ON operation_grants(workspace_id,owner_id,connection_id) WHERE active;
ALTER TABLE operation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON operation_grants USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON operation_grants FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON operation_grants TO vs_account_runtime;
