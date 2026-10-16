CREATE TABLE capture_extraction_jobs(
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,meeting_id uuid NOT NULL,capture_id uuid NOT NULL,
 consent_id uuid NOT NULL,consent_version integer NOT NULL CHECK(consent_version>0),transcript_revision integer NOT NULL CHECK(transcript_revision>0),
 proof jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','running','complete','failed','invalidated')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),result jsonb,error_code text,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,capture_id,consent_id,consent_version,transcript_revision),
 CHECK((status='complete')=(result IS NOT NULL)),
 CHECK(jsonb_typeof(proof)='object' AND proof->>'workspaceId'=workspace_id::text AND proof->>'ownerId'=owner_id::text AND proof->>'meetingId'=meeting_id::text AND proof->>'captureId'=capture_id::text AND proof->>'consentId'=consent_id::text)
);
CREATE INDEX capture_extraction_owner ON capture_extraction_jobs(workspace_id,owner_id,meeting_id,created_at,id);
CREATE TABLE capture_extraction_inbox(
 workspace_id uuid NOT NULL,event_id uuid NOT NULL,digest text NOT NULL,meeting_id uuid NOT NULL,job_id uuid,rejection_code text,
 PRIMARY KEY(workspace_id,event_id),FOREIGN KEY(workspace_id,job_id) REFERENCES capture_extraction_jobs(workspace_id,id) ON DELETE CASCADE,
 CHECK((job_id IS NULL)=(rejection_code IS NOT NULL))
);
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['capture_extraction_jobs','capture_extraction_inbox'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
-- Routing metadata only; ownership and proof content remain tenant-RLS records.
CREATE TABLE capture_extraction_work_index(workspace_id uuid NOT NULL,job_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,job_id),FOREIGN KEY(workspace_id,job_id) REFERENCES capture_extraction_jobs(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX capture_extraction_due ON capture_extraction_work_index(next_at,workspace_id,job_id);
REVOKE ALL ON capture_extraction_jobs,capture_extraction_inbox,capture_extraction_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_extraction_jobs,capture_extraction_inbox,capture_extraction_work_index TO vs_intelligence_runtime;
