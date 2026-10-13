\set ON_ERROR_STOP on
-- Explicit local/CI bootstrap only. Never alters the main Workspace database or existing data.
DO $$ DECLARE role_name text; existing record; BEGIN
 IF current_database()<>'postgres' OR current_user<>'local_admin' THEN
  RAISE EXCEPTION 'LOCAL_QUALIFICATION_ADMIN_REQUIRED';
 END IF;
 FOREACH role_name IN ARRAY ARRAY['vs_commitment_test_migration','vs_commitment_test_runtime'] LOOP
  SELECT * INTO existing FROM pg_roles WHERE rolname=role_name;
  IF FOUND AND(existing.rolsuper OR existing.rolbypassrls OR existing.rolcreatedb OR existing.rolcreaterole OR NOT existing.rolcanlogin) THEN
   RAISE EXCEPTION 'UNSAFE_EXISTING_QUALIFICATION_ROLE';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=role_name)) THEN
   RAISE EXCEPTION 'QUALIFICATION_ROLE_MEMBERSHIP_NOT_ALLOWED';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='workspace_commitment_test' AND pg_get_userbyid(datdba)<>'vs_commitment_test_migration') THEN
  RAISE EXCEPTION 'QUALIFICATION_DATABASE_OWNER_CONFLICT';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vs_commitment_test_migration') THEN
  CREATE ROLE vs_commitment_test_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vs_commitment_test_runtime') THEN
  CREATE ROLE vs_commitment_test_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
 END IF;
 IF(SELECT rolinherit FROM pg_roles WHERE rolname='vs_commitment_test_runtime') THEN
  RAISE EXCEPTION 'QUALIFICATION_RUNTIME_MUST_NOT_INHERIT';
 END IF;
END $$;
SELECT 'CREATE DATABASE workspace_commitment_test OWNER vs_commitment_test_migration'
WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='workspace_commitment_test')\gexec
REVOKE CONNECT ON DATABASE workspace_commitment_test FROM PUBLIC;
GRANT CONNECT ON DATABASE workspace_commitment_test TO vs_commitment_test_migration,vs_commitment_test_runtime;
\connect workspace_commitment_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_commitment_test_runtime;
