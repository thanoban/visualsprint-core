CREATE ROLE vs_authz_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_authz_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE authz OWNER vs_authz_migration;
REVOKE CONNECT ON DATABASE authz FROM PUBLIC;
GRANT CONNECT ON DATABASE authz TO vs_authz_migration,vs_authz_runtime;
\connect authz
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_authz_runtime;
