CREATE ROLE vs_notification_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_notification_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE notification OWNER vs_notification_migration;
\connect notification
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO vs_notification_migration;
GRANT USAGE ON SCHEMA public TO vs_notification_runtime;
