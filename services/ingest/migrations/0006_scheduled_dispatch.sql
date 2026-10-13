ALTER TABLE capture_requests ADD COLUMN dispatch_not_before timestamptz NOT NULL DEFAULT now();
CREATE INDEX capture_work_due ON capture_work_index(next_at,request_id);
