CREATE ROLE vs_workflow_migration LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE vs_workflow_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE workflow OWNER vs_workflow_migration;
\connect workflow
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO vs_workflow_migration;
GRANT USAGE ON SCHEMA public TO vs_workflow_runtime;
