# Explicit indexed retrieval UI

The production `IntelligencePanel` mounts a scoped index control. Ordinary saved-chat requests stay lexical by default; merely opening a chat, changing context or choosing indexed mode never builds an index or sends a model request.

The user explicitly chooses the configured embedding provider and clicks **Build scoped index**. The browser sends an idempotent `POST /api/v3/workspaces/{workspaceId}/intelligence/indexes` with `{scope:{kind,id}}`, then polls `GET /indexes/{jobId}`. Only a completed job with matching scope and valid cursor/chunk metadata establishes UI readiness. The source fingerprint is a server reference, not authorization. The backend checks current access/revisions independently.

Index scope, provider choice and readiness are separate from project association and meeting sharing. Source changes, permission loss, malformed/cross-scope IDs and service outages remove readiness; none triggers a replacement build or lexical fallback. Only an opaque index-job ID is retained in tab-scoped session storage. Reload resumes the same authorized operation; transcript text, vectors, questions and answers are not stored there.

For a ready scoped index, a user may explicitly select **Indexed evidence lookup** and ask a question. The message command includes `{text,retrievalMode:"indexed"}`. Its stored answer displays the persisted retrieval mode after reload. Lexical requests preserve the existing `{text}` contract. Indexed input is limited to 6,000 UTF-8 bytes before the API call; the backend independently enforces the same bound.

`INDEX_NOT_READY` / `SOURCE_CHANGED` block indexed readiness and retain the user's mode/question. The user must refresh/rebuild, or explicitly select lexical retrieval. `RETRIEVAL_DISABLED` reports an administrator gate without faking an index. Selecting lexical remains possible while indexed submission is disabled.

Operator prerequisites belong to Intelligence, not browser credentials: `INTELLIGENCE_RETRIEVAL_ENABLED`, authorized source interfaces, owning pgvector migrations, configured Azure embedding deployment/identity and Account model-budget admission. Query embeddings and answer-model calls are separately admitted by the backend. No provider secrets are exposed to web environment variables.

This UI does not activate the independent semantic verifier or claim a retrieved chunk proves an arbitrary generated statement. Current answers remain evidence/citation checked and review-required; stale or unauthorized stored answers are removed by the owning service. Model quality, real provider performance/cost and live cloud deployment remain separate qualification gates.

Controlled browser cases cover explicit index choice, persisted progress, same-job reload, cross-scope metadata rejection, stale/revoked/disabled sources, persisted indexed answers, no automatic fallback and the multibyte query boundary. Unit tests validate index metadata; web typecheck/build and the full browser regression are required before publication. Browser mocks prove UI behavior/contract handling, not live provider operation.
