-- Server ordering is independent of clock resolution, request time and random IDs.
ALTER TABLE calendar_syncs ADD COLUMN sequence bigserial;
GRANT USAGE,SELECT ON SEQUENCE calendar_syncs_sequence_seq TO vs_integration_runtime;
