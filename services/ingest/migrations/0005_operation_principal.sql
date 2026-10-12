-- Reference only; Account remains the authority. No cross-service foreign key.
ALTER TABLE capture_requests ADD COLUMN operation_grant_id uuid;
