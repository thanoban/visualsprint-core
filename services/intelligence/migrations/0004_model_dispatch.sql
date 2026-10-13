-- Durable references-only dispatch barrier. No prompts, responses or tokens.
CREATE TABLE model_dispatches(
 workspace_id uuid NOT NULL,operation_id uuid NOT NULL,owner_id uuid NOT NULL,
 reservation_id uuid NOT NULL,state text NOT NULL CHECK(state IN ('dispatch_intent','succeeded','unknown','not_started')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,operation_id)
);
ALTER TABLE model_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON model_dispatches
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON model_dispatches FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON model_dispatches TO vs_intelligence_runtime;
