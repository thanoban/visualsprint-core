-- Workspace-owned human-reviewed decisions and commitments. Append-only after qualification.
CREATE TABLE accepted_items(workspace_id uuid NOT NULL,id uuid NOT NULL,meeting_id uuid NOT NULL,created_by uuid NOT NULL,reviewed_by uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('decision','commitment')),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 250),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
 assignee_id uuid,due_date date,state text NOT NULL CHECK(state IN('accepted','superseded','open','completed','cancelled')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 source_meeting_version integer NOT NULL CHECK(source_meeting_version>0),citations jsonb NOT NULL,source_fingerprint text NOT NULL,source_partial boolean NOT NULL,
 proposal_ref jsonb,human_corrected boolean NOT NULL DEFAULT false,status_source text NOT NULL DEFAULT 'human_review' CHECK(status_source='human_review'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id),
 CHECK((kind='decision' AND state IN('accepted','superseded') AND assignee_id IS NULL AND due_date IS NULL) OR (kind='commitment' AND state IN('open','completed','cancelled'))));
CREATE INDEX accepted_meeting_items ON accepted_items(workspace_id,meeting_id,kind,id);
CREATE TABLE accepted_commands(workspace_id uuid NOT NULL,actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,item_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,key));
DO $$ DECLARE relation text; BEGIN FOREACH relation IN ARRAY ARRAY['accepted_items','accepted_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
END LOOP; END $$;
REVOKE ALL ON accepted_items,accepted_commands FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON accepted_items TO vs_workspace_runtime;
GRANT SELECT,INSERT ON accepted_commands TO vs_workspace_runtime;
