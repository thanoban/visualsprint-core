ALTER TABLE capture_requests ADD COLUMN transcript_revision integer NOT NULL DEFAULT 0 CHECK(transcript_revision>=0);
CREATE TABLE capture_processing_intents(
 workspace_id uuid NOT NULL,capture_id uuid NOT NULL,meeting_id uuid NOT NULL,owner_id uuid NOT NULL,
 intent_version integer NOT NULL DEFAULT 1 CHECK(intent_version>0),policy_version text NOT NULL CHECK(policy_version='english-text-v1'),
 state text NOT NULL CHECK(state IN ('consent_pending','ready','withdraw_requested','revoked','configuration_error')),
 consent_id uuid,consent_version integer,error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,capture_id),FOREIGN KEY(workspace_id,capture_id) REFERENCES capture_requests(workspace_id,id),
 CHECK((consent_id IS NULL)=(consent_version IS NULL)),CHECK(consent_version IS NULL OR consent_version>0)
);
CREATE TABLE capture_processing_commands(
 workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,capture_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,capture_id) REFERENCES capture_processing_intents(workspace_id,capture_id)
);
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['capture_processing_intents','capture_processing_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON capture_processing_intents,capture_processing_commands FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_processing_intents,capture_processing_commands TO vs_ingest_runtime;

-- Text generation is distinct from operational capture version. In particular,
-- quota settlement and lease/status bookkeeping cannot invalidate a final stream.
CREATE FUNCTION bump_capture_text_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (NEW.revision,NEW.start_ms,NEW.end_ms,NEW.text,NEW.speaker_label,NEW.finalized)
   IS DISTINCT FROM (OLD.revision,OLD.start_ms,OLD.end_ms,OLD.text,OLD.speaker_label,OLD.finalized) THEN
  UPDATE capture_requests SET transcript_revision=transcript_revision+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transcript_processing_revision AFTER INSERT OR UPDATE ON transcript_segments FOR EACH ROW EXECUTE FUNCTION bump_capture_text_revision();
CREATE FUNCTION bump_capture_final_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coverage IS DISTINCT FROM OLD.coverage OR
   (NEW.state IN ('complete','partial') AND OLD.state NOT IN ('complete','partial')) THEN
   NEW.transcript_revision=OLD.transcript_revision+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_processing_final_revision BEFORE UPDATE OF coverage,state ON capture_requests FOR EACH ROW EXECUTE FUNCTION bump_capture_final_revision();
