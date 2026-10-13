-- DRAFT: do not move to active migrations before pgvector operator qualification.
CREATE TABLE vector_index_jobs(
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,session_id text NOT NULL,
 scope jsonb NOT NULL,source_fingerprint text NOT NULL,source_versions jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','complete','failed')),
 cursor integer NOT NULL DEFAULT 0 CHECK(cursor>=0),total_chunks integer NOT NULL CHECK(total_chunks BETWEEN 0 AND 10000),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
 lease_token uuid,lease_until timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),CHECK(cursor<=total_chunks)
);
CREATE INDEX vector_scope ON vector_index_jobs(workspace_id,owner_id,source_fingerprint,status,created_at);
CREATE TABLE vector_index_commands(workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,job_id uuid NOT NULL,PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,job_id) REFERENCES vector_index_jobs(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE evidence_embeddings(
 workspace_id uuid NOT NULL,index_id uuid NOT NULL,owner_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 meeting_id uuid NOT NULL,capture_id uuid NOT NULL,segment_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>=0),
 chunk_index integer NOT NULL CHECK(chunk_index>=0),character_start integer NOT NULL CHECK(character_start>=0),character_end integer NOT NULL,
 start_ms integer NOT NULL,end_ms integer NOT NULL,text text NOT NULL,speaker_label text,
 embedding vector(1536) NOT NULL,document tsvector GENERATED ALWAYS AS (to_tsvector('english',text)) STORED,
 PRIMARY KEY(workspace_id,index_id,ordinal),FOREIGN KEY(workspace_id,index_id) REFERENCES vector_index_jobs(workspace_id,id) ON DELETE CASCADE,
 CHECK(character_end>character_start),CHECK(end_ms>=start_ms)
);
CREATE INDEX embedding_scope ON evidence_embeddings(workspace_id,owner_id,index_id,meeting_id);
CREATE INDEX embedding_fts ON evidence_embeddings USING gin(document);
-- Exact filtered cosine ranking first. No shared approximate ANN index can
-- weaken tenant filtering or hide candidates at the initial qualification scale.
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['vector_index_jobs','vector_index_commands','evidence_embeddings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
CREATE TABLE vector_work_index(job_id uuid PRIMARY KEY,workspace_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,job_id) REFERENCES vector_index_jobs(workspace_id,id) ON DELETE CASCADE);
CREATE INDEX vector_due ON vector_work_index(next_at,job_id);
REVOKE ALL ON vector_index_jobs,vector_index_commands,evidence_embeddings,vector_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON vector_index_jobs,vector_index_commands,evidence_embeddings,vector_work_index TO vs_intelligence_runtime;
