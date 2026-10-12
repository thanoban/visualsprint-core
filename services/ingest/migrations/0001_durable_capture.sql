CREATE TABLE capture_requests (
 workspace_id uuid NOT NULL, id uuid NOT NULL, meeting_id uuid NOT NULL, owner_id uuid NOT NULL,
 session_id text NOT NULL, meeting_version integer NOT NULL CHECK(meeting_version>0),
 join_url text NOT NULL CHECK(length(join_url)<=4096), max_seconds integer NOT NULL CHECK(max_seconds BETWEEN 1 AND 14400),
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','dispatching','dispatch_unknown','joining','waiting_for_admission','capturing','stopping','finalizing','complete','partial','failed','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), ready boolean NOT NULL DEFAULT false,
 quota_state text NOT NULL DEFAULT 'pending' CHECK(quota_state IN ('pending','held','settled','released')),
 coverage text NOT NULL DEFAULT 'unknown' CHECK(coverage IN ('unknown','known_gaps','no_detected_gaps')),
 error_code text, stop_requested boolean NOT NULL DEFAULT false, attempt_id uuid NOT NULL UNIQUE,
 provider_id uuid UNIQUE, dispatch_at timestamptz, departed_at timestamptz, provider_done boolean NOT NULL DEFAULT false,
 last_status_at timestamptz, last_transcript_at timestamptz, lease_until timestamptz, lease_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE UNIQUE INDEX one_active_capture_per_meeting ON capture_requests(workspace_id,meeting_id)
 WHERE state NOT IN ('complete','partial','failed','cancelled');
CREATE TABLE attempt_directory (
 attempt_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, request_id uuid NOT NULL,
 FOREIGN KEY(workspace_id,request_id) REFERENCES capture_requests(workspace_id,id)
);
CREATE TABLE transcript_segments (
 workspace_id uuid NOT NULL, request_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 start_ms integer NOT NULL CHECK(start_ms>=0), end_ms integer NOT NULL CHECK(end_ms>=start_ms),
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 32000), speaker_label text,
 finalized boolean NOT NULL DEFAULT true, PRIMARY KEY(workspace_id,request_id,id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES capture_requests(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE webhook_inbox (
 workspace_id uuid NOT NULL, source text NOT NULL, message_id text NOT NULL CHECK(length(message_id)<=200),
 digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,source,message_id)
);
CREATE TABLE commands (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
 request_id uuid NOT NULL, PRIMARY KEY(workspace_id,actor_id,key),
 FOREIGN KEY(workspace_id,request_id) REFERENCES capture_requests(workspace_id,id)
);
CREATE TABLE outbox (
 workspace_id uuid NOT NULL, id uuid NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, lease_until timestamptz, lease_token uuid, attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['capture_requests','transcript_segments','webhook_inbox','commands','outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
ALTER TABLE attempt_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_directory FORCE ROW LEVEL SECURITY;
-- Only the metadata directory may be resolved before tenant context, using the
-- attempt ID authenticated by a signed provider event. It contains no meeting text.
CREATE POLICY directory_scope ON attempt_directory USING (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid OR
 attempt_id=nullif(current_setting('app.attempt_id',true),'')::uuid
) WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON capture_requests,transcript_segments,webhook_inbox,commands,outbox TO vs_ingest_runtime;
GRANT SELECT,INSERT,DELETE ON attempt_directory TO vs_ingest_runtime;
