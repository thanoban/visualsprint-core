CREATE TABLE capture_processing_consents(
 workspace_id uuid NOT NULL,consent_id uuid NOT NULL,owner_id uuid NOT NULL,
 meeting_id uuid NOT NULL,capture_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 policy_version text NOT NULL CHECK(policy_version='english-text-v1'),active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,consent_id),UNIQUE(workspace_id,capture_id)
);
CREATE TABLE capture_processing_commands(
 workspace_id uuid NOT NULL,owner_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,consent_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,key),FOREIGN KEY(workspace_id,consent_id) REFERENCES capture_processing_consents(workspace_id,consent_id)
);
CREATE TABLE capture_processing_deletions(
 workspace_id uuid NOT NULL,meeting_id uuid NOT NULL,deletion_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 PRIMARY KEY(workspace_id,meeting_id),UNIQUE(workspace_id,deletion_id)
);
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['capture_processing_consents','capture_processing_commands','capture_processing_deletions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON capture_processing_consents,capture_processing_commands,capture_processing_deletions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON capture_processing_consents,capture_processing_commands,capture_processing_deletions TO vs_account_runtime;
