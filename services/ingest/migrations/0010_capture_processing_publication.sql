CREATE TABLE capture_processing_publications(
 workspace_id uuid NOT NULL,capture_id uuid NOT NULL,meeting_id uuid NOT NULL,consent_id uuid NOT NULL,
 consent_version integer NOT NULL CHECK(consent_version>0),transcript_revision integer NOT NULL CHECK(transcript_revision>0),
 state text NOT NULL CHECK(state IN ('published','rejected')),event_id uuid,rejection_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,capture_id,consent_id,consent_version,transcript_revision),
 FOREIGN KEY(workspace_id,capture_id) REFERENCES capture_requests(workspace_id,id),
 CHECK((state='published')=(event_id IS NOT NULL)),CHECK((state='rejected')=(rejection_code IS NOT NULL))
);
ALTER TABLE capture_processing_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_processing_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON capture_processing_publications USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
-- Tenant/aggregate references only. Source text and consent records stay tenant-RLS.
CREATE TABLE capture_processing_publish_index(workspace_id uuid NOT NULL,capture_id uuid NOT NULL,next_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,capture_id),FOREIGN KEY(workspace_id,capture_id) REFERENCES capture_requests(workspace_id,id));
CREATE INDEX capture_processing_publish_due ON capture_processing_publish_index(next_at,workspace_id,capture_id);
CREATE FUNCTION route_capture_processing_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='capture_requests' THEN target:=NEW.id; ELSE target:=NEW.capture_id; END IF;
 IF TG_TABLE_NAME='capture_processing_intents' AND NEW.state<>'ready' THEN
  DELETE FROM capture_processing_publish_index WHERE workspace_id=NEW.workspace_id AND capture_id=target;
 ELSIF EXISTS(SELECT 1 FROM capture_requests c JOIN capture_processing_intents i ON i.workspace_id=c.workspace_id AND i.capture_id=c.id WHERE c.workspace_id=NEW.workspace_id AND c.id=target AND c.state IN ('complete','partial') AND c.transcript_revision>0 AND i.state='ready') THEN
  INSERT INTO capture_processing_publish_index(workspace_id,capture_id) VALUES(NEW.workspace_id,target)
  ON CONFLICT(workspace_id,capture_id) DO UPDATE SET next_at=LEAST(capture_processing_publish_index.next_at,now());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_publication_revision AFTER UPDATE OF transcript_revision,state ON capture_requests FOR EACH ROW EXECUTE FUNCTION route_capture_processing_publication();
CREATE TRIGGER capture_publication_consent AFTER INSERT OR UPDATE OF state ON capture_processing_intents FOR EACH ROW EXECUTE FUNCTION route_capture_processing_publication();
CREATE FUNCTION purge_capture_processing_publication_routes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM capture_processing_publish_index p USING capture_requests c WHERE p.workspace_id=NEW.workspace_id AND p.capture_id=c.id AND c.workspace_id=NEW.workspace_id AND c.meeting_id=NEW.meeting_id;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_publication_deletion AFTER INSERT ON meeting_deletions FOR EACH ROW EXECUTE FUNCTION purge_capture_processing_publication_routes();
-- Owner-only backfill inside the atomic migration; tenant runtime policies remain
-- installed and are forced again before the migration commits.
ALTER TABLE capture_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_processing_intents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_deletions NO FORCE ROW LEVEL SECURITY;
INSERT INTO capture_processing_publish_index(workspace_id,capture_id)
 SELECT c.workspace_id,c.id FROM capture_requests c JOIN capture_processing_intents i ON i.workspace_id=c.workspace_id AND i.capture_id=c.id
 WHERE c.state IN ('complete','partial') AND c.transcript_revision>0 AND i.state='ready'
 AND NOT EXISTS(SELECT 1 FROM meeting_deletions d WHERE d.workspace_id=c.workspace_id AND d.meeting_id=c.meeting_id);
ALTER TABLE capture_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_processing_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_deletions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON capture_processing_publications,capture_processing_publish_index FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_processing_publications,capture_processing_publish_index TO vs_ingest_runtime;
