-- Disposable loopback development credentials only.
CREATE ROLE vs_ingest_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_ingest_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE ingest OWNER vs_ingest_migration;
REVOKE CONNECT ON DATABASE ingest FROM PUBLIC;
GRANT CONNECT ON DATABASE ingest TO vs_ingest_migration,vs_ingest_runtime;
\connect ingest
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_ingest_runtime;
