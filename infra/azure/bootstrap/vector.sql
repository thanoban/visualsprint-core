\set ON_ERROR_STOP on
\set VERBOSITY terse
\set ECHO none
\connect intelligence
-- Allowlisted by foundation. Azure administrator privileges are required, never runtime credentials.
CREATE EXTENSION IF NOT EXISTS vector;
\echo VECTOR_BOOTSTRAP_COMPLETE
