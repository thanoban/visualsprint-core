-- Public credentials exclusively for disposable loopback development databases.
CREATE ROLE vs_workspace_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_workspace_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE workspace OWNER vs_workspace_migration;
REVOKE CONNECT ON DATABASE workspace FROM PUBLIC;
GRANT CONNECT ON DATABASE workspace TO vs_workspace_migration,vs_workspace_runtime;
\connect workspace
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_workspace_runtime;
