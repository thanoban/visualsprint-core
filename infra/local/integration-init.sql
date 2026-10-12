-- Disposable loopback-only development credentials, never production credentials.
CREATE ROLE vs_integration_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_integration_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE integration OWNER vs_integration_migration;
REVOKE CONNECT ON DATABASE integration FROM PUBLIC;
GRANT CONNECT ON DATABASE integration TO vs_integration_migration,vs_integration_runtime;
\connect integration
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_integration_runtime;
