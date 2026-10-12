CREATE TABLE entitlements (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 max_concurrent integer NOT NULL DEFAULT 5 CHECK(max_concurrent BETWEEN 1 AND 10000),
 monthly_seconds integer NOT NULL DEFAULT 360000 CHECK(monthly_seconds>=0)
);
CREATE TABLE capture_reservations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), request_id uuid NOT NULL,
 owner_id uuid NOT NULL REFERENCES users(id), max_seconds integer NOT NULL CHECK(max_seconds BETWEEN 1 AND 14400),
 period date NOT NULL DEFAULT date_trunc('month',now() AT TIME ZONE 'UTC')::date,
 state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','settled','released')),
 charged_seconds integer CHECK(charged_seconds BETWEEN 0 AND 604800),
 created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(workspace_id,request_id),
 CHECK((state='held' AND charged_seconds IS NULL) OR (state='settled' AND charged_seconds IS NOT NULL) OR (state='released' AND charged_seconds=0))
);
CREATE INDEX capture_usage_active ON capture_reservations(workspace_id,period) WHERE state='held';
CREATE TABLE usage_ledger (
 workspace_id uuid NOT NULL, request_id uuid NOT NULL, period date NOT NULL,
 seconds integer NOT NULL CHECK(seconds BETWEEN 0 AND 604800), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES capture_reservations(workspace_id,request_id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['entitlements','capture_reservations','usage_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
REVOKE ALL ON entitlements,capture_reservations,usage_ledger FROM PUBLIC;
GRANT SELECT ON entitlements TO vs_account_runtime;
GRANT INSERT(workspace_id) ON entitlements TO vs_account_runtime;
GRANT SELECT,INSERT,UPDATE ON capture_reservations TO vs_account_runtime;
GRANT SELECT,INSERT ON usage_ledger TO vs_account_runtime;
