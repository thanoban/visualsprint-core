-- Account-owned verified recipient projection; refreshes are fenced and never accept browser email claims.
CREATE TABLE verified_profiles(user_id uuid PRIMARY KEY REFERENCES users(id),subject text NOT NULL,verified_email text,provider_updated_at timestamptz,request_sequence bigint NOT NULL DEFAULT 0,applied_sequence bigint NOT NULL DEFAULT 0,checked_at timestamptz,CHECK(verified_email IS NULL OR length(verified_email)<=320),CHECK(request_sequence>=applied_sequence));
ALTER TABLE verified_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_scope ON verified_profiles USING(user_id=nullif(current_setting('app.actor_id',true),'')::uuid) WITH CHECK(user_id=nullif(current_setting('app.actor_id',true),'')::uuid);
REVOKE ALL ON verified_profiles FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON verified_profiles TO vs_account_runtime;
