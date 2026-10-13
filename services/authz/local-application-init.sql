-- Separate Authz-owned application DB on the local authorization server, not OpenFGA tables.
CREATE ROLE vs_authz_app_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_authz_app_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE authz_application OWNER vs_authz_app_migration;
REVOKE CONNECT ON DATABASE authz_application FROM PUBLIC;
GRANT CONNECT ON DATABASE authz_application TO vs_authz_app_migration,vs_authz_app_runtime;
\connect authz_application
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_authz_app_runtime;
