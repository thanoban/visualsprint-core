CREATE ROLE vs_account_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_account_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
CREATE DATABASE account OWNER vs_account_migration;
REVOKE CONNECT ON DATABASE account FROM PUBLIC;
GRANT CONNECT ON DATABASE account TO vs_account_migration,vs_account_runtime;
\connect account
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vs_account_runtime;
