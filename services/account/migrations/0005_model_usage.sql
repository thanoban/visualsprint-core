-- Independent workload estimates: not provider token billing or a monetary invoice.
CREATE TABLE model_entitlements (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 purpose text NOT NULL CHECK(purpose IN('preparation','summary','chat','indexing','retrieval')),
 max_concurrent integer NOT NULL DEFAULT 2 CHECK(max_concurrent BETWEEN 0 AND 10000),
 monthly_input_tokens bigint NOT NULL DEFAULT 1000000 CHECK(monthly_input_tokens BETWEEN 0 AND 9007199254740991),
 monthly_output_tokens bigint NOT NULL DEFAULT 100000 CHECK(monthly_output_tokens BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(workspace_id,purpose)
);
CREATE TABLE model_reservations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), reservation_id uuid NOT NULL,
 operation_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES users(id),
 purpose text NOT NULL CHECK(purpose IN('preparation','summary','chat','indexing','retrieval')),
 max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 250000),
 max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 0 AND 6000),
 period date NOT NULL DEFAULT date_trunc('month',now() AT TIME ZONE 'UTC')::date,
 state text NOT NULL DEFAULT 'held' CHECK(state IN('held','unknown','succeeded','not_started')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,reservation_id), UNIQUE(workspace_id,operation_id),
 CHECK((purpose IN('indexing','retrieval') AND max_output_tokens=0) OR(purpose IN('preparation','summary','chat') AND max_output_tokens>0)),
 CHECK(purpose<>'indexing' OR max_input_tokens<=96000), CHECK(purpose<>'retrieval' OR max_input_tokens<=6000)
);
CREATE INDEX model_reservations_active ON model_reservations(workspace_id,period) WHERE state IN('held','unknown');
CREATE TABLE model_estimate_ledger (
 workspace_id uuid NOT NULL, reservation_id uuid NOT NULL, period date NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('preparation','summary','chat','indexing','retrieval')),
 estimated_input_tokens integer NOT NULL CHECK(estimated_input_tokens BETWEEN 1 AND 250000),
 estimated_output_tokens integer NOT NULL CHECK(estimated_output_tokens BETWEEN 0 AND 6000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,reservation_id), FOREIGN KEY(workspace_id,reservation_id) REFERENCES model_reservations(workspace_id,reservation_id)
);
CREATE TABLE model_outcome_ledger (
 workspace_id uuid NOT NULL, reservation_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN('succeeded','unknown','not_started')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,reservation_id,outcome), FOREIGN KEY(workspace_id,reservation_id) REFERENCES model_reservations(workspace_id,reservation_id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['model_entitlements','model_reservations','model_estimate_ledger','model_outcome_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
REVOKE ALL ON model_entitlements,model_reservations,model_estimate_ledger,model_outcome_ledger FROM PUBLIC;
GRANT SELECT ON model_entitlements TO vs_account_runtime;
GRANT INSERT(workspace_id,purpose) ON model_entitlements TO vs_account_runtime;
GRANT SELECT,INSERT,UPDATE ON model_reservations TO vs_account_runtime;
GRANT SELECT,INSERT ON model_estimate_ledger,model_outcome_ledger TO vs_account_runtime;
