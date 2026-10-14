\set ON_ERROR_STOP on
\set VERBOSITY terse
\set ECHO none
\connect authz
SET ROLE vs_authz_migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO vs_authz_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO vs_authz_runtime;
REVOKE INSERT,UPDATE,DELETE ON goose_db_version FROM vs_authz_runtime;
RESET ROLE;
\echo OPENFGA_GRANTS_COMPLETE
