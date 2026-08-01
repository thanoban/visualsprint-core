# Data Model

Implemented in [`backend/app/db/models.py`](../backend/app/db/models.py). UUID string PKs; `org_id` on every tenant-scoped row; timestamps everywhere.

## Tenancy & identity
- `org` — join policy (all / organized_only / never_private), retention, settings
- `person` — org-level identity with aliases ("Nimal" / "Nimal Perera" resolve to one person)
- `calendar_connection` — OAuth reference (tokens in secret store, not DB)

## Meetings & capture
- `meeting` — platform, scheduling
- `capture_session` — mode A1/A2/B/C/D, FSM state, disclosure log
- `participant` — roster entry, links to person
- `coverage_interval` — *(session, span, modality, ok/degraded/missing, reason)* → capture honesty

## Evidence
- `utterance` — span, person, text, `lang_tags[]`, asr_confidence, **attribution_confidence**, provider, repaired flag
- `keyframe` — validity interval, image URI, phash, OCR text, VLM caption, detected entities
- `utterance_keyframe` — speech↔screen grounding link + score + method

## Knowledge
- `knowledge_item` — type (decision/commitment/requirement/blocker/question/fact), statement, owner, due, **lifecycle_state**, **confidence**, rationale, coverage-gap flag, embedding (pgvector 1024)
- `knowledge_evidence` — item → utterance/keyframe (CHECK: at least one source)
- `knowledge_edge` — `SUPERSEDES | CONTRADICTS | CONTINUES | RECURS | RESOLVES` + rationale

**Design rule:** lifecycle **state** lives on items (`NEW/RECURRING/REOPENED/RESOLVED/SUPERSEDED`); **relations** are edges between items. Conflating them makes cross-meeting traversal impossible.

## Actions, corrections, compliance
- `proposed_action` — **DB CHECK constraint:** status cannot be `approved`/`executed` without `approved_by_person_id`. Unapproved execution is unrepresentable, not merely forbidden.
- `correction` — original/corrected text + training-consent flag → the si-ta-en corpus flywheel
- `consent_record`, `audit_log`

## Pipeline
- `pipeline_job` — Postgres queue row: stage, status, attempts, backoff `run_at`, lock columns. Claimed via `FOR UPDATE SKIP LOCKED`.

## Retrieval (chat & reports)

Hybrid search (pgvector + Postgres FTS) over `knowledge_item` → expansion along `knowledge_edge` → synthesis **constrained to retrieved items and their evidence**, never raw transcript chunks. That is what produces a traced answer instead of a lucky text match.
