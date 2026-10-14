\set ON_ERROR_STOP on
\set VERBOSITY terse
\set ECHO none
\getenv database DB_NAME
\getenv migration_password MIGRATION_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
-- Fixed, operator-owned database/role mapping. Never accept a client supplied identifier.
SELECT CASE WHEN :'database' = 'authz_application' THEN 'vs_authz_app'
  WHEN :'database' IN ('account','workspace','ingest','integration','intelligence','workflow','notification','reporting','authz') THEN 'vs_' || :'database'
  ELSE '' END AS role_prefix \gset
SELECT length(:'role_prefix') > 0 AND length(:'migration_password') >= 32
  AND length(:'runtime_password') >= 32 AND :'migration_password' <> :'runtime_password'
  AND current_user = 'vs_provisioner' AS valid \gset
\if :valid
\else
  \echo BOOTSTRAP_INPUT_REJECTED
  SELECT 1/0;
\endif
SELECT :'role_prefix' || '_migration' AS migration_role, :'role_prefix' || '_runtime' AS runtime_role \gset
SELECT pg_advisory_lock(hashtextextended('visualsprint-azure-role-bootstrap-v1',0));
-- Refuse unexpected existing roles, elevated roles or role membership. Never silently repair a legacy estate.
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles r WHERE r.rolname IN (:'migration_role', :'runtime_role')
  AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR NOT r.rolcanlogin)
) AND NOT EXISTS (
  SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN (:'migration_role', :'runtime_role')
) AND EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database')
AND NOT EXISTS (
  SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = :'database' AND r.rolname NOT IN ('vs_provisioner', :'migration_role')
) AS safe \gset
\if :safe
\else
  \echo BOOTSTRAP_EXISTING_STATE_REJECTED
  SELECT 1/0;
\endif
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT', :'migration_role', :'migration_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_role') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT', :'runtime_role', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role') \gexec
-- Azure's administrator is not a PostgreSQL superuser. Explicit migration membership permits ownership transfer.
SELECT format('GRANT %I TO %I WITH INHERIT FALSE', :'migration_role', current_user) \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'database', :'migration_role') \gexec
SELECT format('SET ROLE %I', :'migration_role') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, vs_provisioner', :'database', :'migration_role', :'runtime_role') \gexec
RESET ROLE;
SELECT pg_advisory_unlock(hashtextextended('visualsprint-azure-role-bootstrap-v1',0));
\connect :database
SELECT format('SET ROLE %I', :'migration_role') \gexec
-- PostgreSQL 15+ public schema ownership tracks the database owner through pg_database_owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec
RESET ROLE;
\echo BOOTSTRAP_ROLES_COMPLETE
