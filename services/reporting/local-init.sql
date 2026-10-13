-- Disposable loopback development credentials only.
CREATE ROLE vs_reporting_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_reporting_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE reporting OWNER vs_reporting_migration;
REVOKE CONNECT ON DATABASE reporting FROM PUBLIC;
GRANT CONNECT ON DATABASE reporting TO vs_reporting_migration,vs_reporting_runtime;
\connect reporting
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_reporting_runtime;
