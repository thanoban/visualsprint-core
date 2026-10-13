ALTER TABLE intelligence_jobs ADD COLUMN retrieval_mode text NOT NULL DEFAULT 'lexical'
 CHECK(retrieval_mode IN ('lexical','indexed'));
ALTER TABLE intelligence_jobs ADD CONSTRAINT indexed_answers_only
 CHECK(retrieval_mode='lexical' OR kind='answer');
