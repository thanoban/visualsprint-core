-- The owning Ingest scheduler may enumerate only opaque routing references.
-- No actor, link, text or permission facts belong in this cross-tenant index.
CREATE TABLE capture_work_index (
 request_id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
 next_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,request_id) REFERENCES capture_requests(workspace_id,id) ON DELETE CASCADE
);
REVOKE ALL ON capture_work_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_work_index TO vs_ingest_runtime;
INSERT INTO capture_work_index(request_id,workspace_id)
 SELECT request_id,workspace_id FROM attempt_directory;
-- Backfill is scoped by normal RLS; existing environments must enqueue known
-- workspace references through their authorized migration/reconciliation process.
