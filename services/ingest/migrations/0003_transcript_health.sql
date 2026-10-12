ALTER TABLE capture_requests ADD COLUMN transcript_health text NOT NULL DEFAULT 'unknown'
 CHECK(transcript_health IN ('unknown','receiving','paused','ended'));
