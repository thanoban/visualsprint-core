-- Isolated local qualification server only. Existing PG55438 data is untouched.
CREATE ROLE vs_intelligence_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_intelligence_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE intelligence OWNER vs_intelligence_migration;
REVOKE CONNECT ON DATABASE intelligence FROM PUBLIC;
GRANT CONNECT ON DATABASE intelligence TO vs_intelligence_migration,vs_intelligence_runtime;
\connect intelligence
-- pgvector is operator-owned; never grant superuser to an application/migrator.
CREATE EXTENSION vector VERSION '0.8.6';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_intelligence_runtime;
