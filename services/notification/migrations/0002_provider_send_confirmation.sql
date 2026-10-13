-- Provider send-operation success is not actual recipient mailbox delivery.
ALTER TABLE deliveries DROP CONSTRAINT deliveries_state_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_state_check CHECK(state IN('queued','dispatching','unknown','held','delivered','provider_sent','cancelled','failed'));
ALTER TABLE attempts DROP CONSTRAINT attempts_state_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_state_check CHECK(state IN('dispatching','unknown','provider_sent','failed')) NOT VALID;
-- Only migration-owner fixture/legacy send-status normalization; FORCE returns before commit.
ALTER TABLE deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attempts NO FORCE ROW LEVEL SECURITY;
UPDATE deliveries SET state='provider_sent' WHERE channel='email' AND state='delivered';
UPDATE attempts SET state='provider_sent' WHERE state='delivered';
ALTER TABLE attempts VALIDATE CONSTRAINT attempts_state_check;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE deliveries ADD CONSTRAINT provider_sent_requires_external_id CHECK(state<>'provider_sent' OR(channel='email' AND external_id IS NOT NULL));
ALTER TABLE deliveries ADD CONSTRAINT in_app_delivery_only CHECK(state<>'delivered' OR channel='in_app');
