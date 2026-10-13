ALTER TABLE action_executions ADD COLUMN external_cleanup_state text NOT NULL DEFAULT 'not_required' CHECK(external_cleanup_state IN('not_required','pending'));
CREATE UNIQUE INDEX action_unique_external_reference ON action_executions(workspace_id,connection_id,external_id) WHERE external_id IS NOT NULL;
