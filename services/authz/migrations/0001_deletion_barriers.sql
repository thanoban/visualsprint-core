CREATE TABLE deletion_requests(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 completed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id));
CREATE TABLE meeting_tombstones(workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,meeting_id));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['deletion_requests','meeting_tombstones'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON deletion_requests,meeting_tombstones FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON deletion_requests,meeting_tombstones TO vs_authz_app_runtime;
CREATE FUNCTION permanent_authz_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.meeting_id) IS DISTINCT FROM (OLD.workspace_id,OLD.meeting_id) OR NEW.source_version<OLD.source_version THEN RAISE EXCEPTION 'IMMUTABLE_DELETION_BARRIER'; END IF; RETURN NEW; END $$;
CREATE TRIGGER authz_tombstone_immutable BEFORE UPDATE ON meeting_tombstones FOR EACH ROW EXECUTE FUNCTION permanent_authz_tombstone();
