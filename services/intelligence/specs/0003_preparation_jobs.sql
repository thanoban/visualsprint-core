-- DRAFT: isolated qualification only; not an active application migration.
CREATE TABLE preparation_jobs(
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,input jsonb NOT NULL,
 source_versions jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','running','complete','failed','invalidated')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),result jsonb,commitments_fingerprint text,error_code text,
 lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),CHECK((status='complete')=(result IS NOT NULL))
);
CREATE TABLE preparation_commands(workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,job_id uuid NOT NULL,PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,job_id) REFERENCES preparation_jobs(workspace_id,id) ON DELETE CASCADE);
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['preparation_jobs','preparation_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
CREATE TABLE preparation_work_index(job_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,job_id) REFERENCES preparation_jobs(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX preparation_due ON preparation_work_index(next_at,job_id);
REVOKE ALL ON preparation_jobs,preparation_commands,preparation_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON preparation_jobs,preparation_commands,preparation_work_index TO vs_intelligence_runtime;
