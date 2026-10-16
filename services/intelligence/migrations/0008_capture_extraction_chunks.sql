CREATE TABLE capture_extraction_chunks(
 workspace_id uuid NOT NULL,job_id uuid NOT NULL,source_fingerprint text NOT NULL,
 chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 64),
 outputs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(outputs)='array' AND jsonb_array_length(outputs)<=chunk_count),
 PRIMARY KEY(workspace_id,job_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES capture_extraction_jobs(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE capture_extraction_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_extraction_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON capture_extraction_chunks
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON capture_extraction_chunks FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_extraction_chunks TO vs_intelligence_runtime;
