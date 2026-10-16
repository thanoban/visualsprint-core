-- Capture-consent model authority remains separate from normal interactive model requests.
ALTER TABLE model_entitlements DROP CONSTRAINT model_entitlements_purpose_check;
ALTER TABLE model_entitlements ADD CONSTRAINT model_entitlements_purpose_check CHECK(purpose IN('preparation','summary','chat','indexing','retrieval','capture_extraction'));
ALTER TABLE model_reservations DROP CONSTRAINT model_reservations_purpose_check;
ALTER TABLE model_reservations ADD CONSTRAINT model_reservations_purpose_check CHECK(purpose IN('preparation','summary','chat','indexing','retrieval','capture_extraction'));
ALTER TABLE model_estimate_ledger DROP CONSTRAINT model_estimate_ledger_purpose_check;
ALTER TABLE model_estimate_ledger ADD CONSTRAINT model_estimate_ledger_purpose_check CHECK(purpose IN('preparation','summary','chat','indexing','retrieval','capture_extraction'));
-- PostgreSQL can derive compound CHECK names from referenced columns. Locate exactly the owning output-policy CHECK, never drop unrelated bounds.
DO $$ DECLARE constraint_name text; matches integer; BEGIN
 SELECT count(*),min(conname::text) INTO matches,constraint_name FROM pg_constraint
 WHERE conrelid='model_reservations'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%purpose%' AND pg_get_constraintdef(oid) LIKE '%max_output_tokens%'
 AND pg_get_constraintdef(oid) NOT LIKE '%max_input_tokens%';
 IF matches<>1 THEN RAISE EXCEPTION 'MODEL_OUTPUT_POLICY_SCHEMA_MISMATCH'; END IF;
 EXECUTE format('ALTER TABLE model_reservations DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE model_reservations ADD CONSTRAINT model_reservations_output_policy_check
 CHECK((purpose IN('indexing','retrieval') AND max_output_tokens=0) OR(purpose IN('preparation','summary','chat','capture_extraction') AND max_output_tokens>0));
-- New capture-purpose rows are disabled even if the runtime creates an entitlement seed.
-- An authorized operator must explicitly UPDATE this purpose after cost/consent qualification.
CREATE FUNCTION capture_model_zero_defaults() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.purpose='capture_extraction' THEN NEW.max_concurrent=0;NEW.monthly_input_tokens=0;NEW.monthly_output_tokens=0;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_model_zero_defaults BEFORE INSERT ON model_entitlements FOR EACH ROW EXECUTE FUNCTION capture_model_zero_defaults();
CREATE TABLE capture_model_bindings(
 workspace_id uuid NOT NULL,reservation_id uuid NOT NULL,operation_id uuid NOT NULL,owner_id uuid NOT NULL,
 consent_id uuid NOT NULL,consent_version integer NOT NULL CHECK(consent_version>0),meeting_id uuid NOT NULL,capture_id uuid NOT NULL,
 policy_version text NOT NULL CHECK(policy_version='english-text-v1'),transcript_revision integer NOT NULL CHECK(transcript_revision>0),fingerprint text NOT NULL,
 PRIMARY KEY(workspace_id,reservation_id),UNIQUE(workspace_id,operation_id),
 FOREIGN KEY(workspace_id,reservation_id) REFERENCES model_reservations(workspace_id,reservation_id)
);
ALTER TABLE capture_model_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_model_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON capture_model_bindings USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON capture_model_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_model_zero_defaults() FROM PUBLIC;
GRANT SELECT,INSERT ON capture_model_bindings TO vs_account_runtime;
