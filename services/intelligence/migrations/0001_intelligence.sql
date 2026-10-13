CREATE TABLE chat_threads (
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,title text NOT NULL,
 scope jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE intelligence_jobs (
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('summary','answer')),scope jsonb NOT NULL,thread_id uuid,question text,
 status text NOT NULL CHECK(status IN ('queued','running','complete','failed','invalidated')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),result jsonb,source_versions jsonb,error_code text,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,thread_id) REFERENCES chat_threads(workspace_id,id),
 CHECK((kind='summary' AND thread_id IS NULL AND question IS NULL) OR (kind='answer' AND thread_id IS NOT NULL AND question IS NOT NULL)),
 CHECK((status='complete')=(result IS NOT NULL))
);
CREATE INDEX jobs_thread ON intelligence_jobs(workspace_id,owner_id,thread_id,created_at,id);
CREATE TABLE commands(workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(workspace_id,actor_id,key));
CREATE TABLE evidence_index(
 workspace_id uuid NOT NULL,owner_id uuid NOT NULL,meeting_id uuid NOT NULL,capture_id uuid NOT NULL,segment_id uuid NOT NULL,
 revision integer NOT NULL,start_ms integer NOT NULL,end_ms integer NOT NULL,text text NOT NULL,speaker_label text,
 document tsvector GENERATED ALWAYS AS (to_tsvector('english',text)) STORED,
 PRIMARY KEY(workspace_id,owner_id,meeting_id,capture_id,segment_id)
);
CREATE INDEX evidence_fulltext ON evidence_index USING gin(document);
CREATE TABLE outbox(workspace_id uuid NOT NULL,id uuid NOT NULL,event jsonb NOT NULL,published_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE deletion_tombstones(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,deletion_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,meeting_id),UNIQUE(workspace_id,deletion_id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['chat_threads','intelligence_jobs','commands','evidence_index','outbox','deletion_tombstones'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
-- Routing references only; these are not authority or business content.
CREATE TABLE intelligence_work_index(job_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,job_id) REFERENCES intelligence_jobs(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX intelligence_due ON intelligence_work_index(next_at,job_id);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON chat_threads,intelligence_jobs,commands,evidence_index,outbox,intelligence_work_index TO vs_intelligence_runtime;
GRANT SELECT,INSERT ON deletion_tombstones TO vs_intelligence_runtime;
