-- 0010 is already applied/frozen. Deletion updates terminal capture state after
-- inserting its barrier; those later updates must not recreate publication work.
CREATE OR REPLACE FUNCTION route_capture_processing_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='capture_requests' THEN target:=NEW.id; ELSE target:=NEW.capture_id; END IF;
 IF (TG_TABLE_NAME='capture_processing_intents' AND NEW.state<>'ready') OR
   EXISTS(SELECT 1 FROM meeting_deletions d JOIN capture_requests c ON c.workspace_id=d.workspace_id AND c.meeting_id=d.meeting_id WHERE c.workspace_id=NEW.workspace_id AND c.id=target) THEN
  DELETE FROM capture_processing_publish_index WHERE workspace_id=NEW.workspace_id AND capture_id=target;
 ELSIF EXISTS(SELECT 1 FROM capture_requests c JOIN capture_processing_intents i ON i.workspace_id=c.workspace_id AND i.capture_id=c.id WHERE c.workspace_id=NEW.workspace_id AND c.id=target AND c.state IN ('complete','partial') AND c.transcript_revision>0 AND i.state='ready') THEN
  INSERT INTO capture_processing_publish_index(workspace_id,capture_id) VALUES(NEW.workspace_id,target)
  ON CONFLICT(workspace_id,capture_id) DO UPDATE SET next_at=LEAST(capture_processing_publish_index.next_at,now());
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE capture_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_deletions NO FORCE ROW LEVEL SECURITY;
DELETE FROM capture_processing_publish_index p USING capture_requests c,meeting_deletions d
 WHERE p.workspace_id=c.workspace_id AND p.capture_id=c.id AND d.workspace_id=c.workspace_id AND d.meeting_id=c.meeting_id;
ALTER TABLE capture_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_deletions FORCE ROW LEVEL SECURITY;
