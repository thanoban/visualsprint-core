CREATE TABLE calendar_push_subscriptions(
 workspace_id uuid NOT NULL,id uuid NOT NULL,connection_id uuid NOT NULL,calendar_id text NOT NULL,connection_version integer NOT NULL,provider text NOT NULL CHECK(provider IN('google','microsoft')),
 state text NOT NULL CHECK(state IN('intent','unknown','active','retired','failed')),proof_hash text NOT NULL CHECK(length(proof_hash)=64),proof_cipher text,
 external_id text,resource_id text,requested_expires_at timestamptz NOT NULL,expires_at timestamptz,lease_token uuid,lease_until timestamptz,error_code text,renewal_required boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),CHECK(state<>'active' OR(external_id IS NOT NULL AND expires_at IS NOT NULL)));
CREATE INDEX calendar_push_connection ON calendar_push_subscriptions(workspace_id,connection_id,state);
ALTER TABLE calendar_push_subscriptions ENABLE ROW LEVEL SECURITY;ALTER TABLE calendar_push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON calendar_push_subscriptions USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
-- Reference-only routing is not permission. Owning subscription/current policy is checked after lookup.
CREATE TABLE calendar_push_route_index(route_id text PRIMARY KEY,workspace_id uuid NOT NULL,subscription_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN('google','microsoft')));
CREATE TABLE calendar_push_inbox(workspace_id uuid NOT NULL,key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,key));
ALTER TABLE calendar_push_inbox ENABLE ROW LEVEL SECURITY;ALTER TABLE calendar_push_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON calendar_push_inbox USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON calendar_push_subscriptions,calendar_push_route_index,calendar_push_inbox FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON calendar_push_subscriptions,calendar_push_route_index,calendar_push_inbox TO vs_integration_runtime;
