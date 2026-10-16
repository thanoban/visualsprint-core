# Secure runtime inventory

## Optional consent-bound automatic extraction

`enableCaptureExtractionWorker=false` remains the default. After qualifying the new owning
Account/Ingest/Intelligence migrations and immutable images, enabling it also requires
`activateRuntime=true` and `enableIntelligenceEvents=true`. The native flags must agree:

- Account: `CAPTURE_PROCESSING_ENABLED=true`, `CAPTURE_MODEL_ADMISSION_ENABLED=true`.
- Ingest: `CAPTURE_PROCESSING_ENABLED=true`, `CAPTURE_EXTRACTION_PUBLISH_ENABLED=true`.
- Intelligence: `INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED=true`,
  `INTELLIGENCE_MODEL_ADMISSION_ENABLED=true`.

The separate `ingest-processing` process uses `events.mjs` with
`INGEST_EVENT_WORKER_KIND=processing`; it authorizes metadata and commits the processing event.
The existing Ingest publisher delivers the outbox. Intelligence events consumes the dedicated
`vs-ingest/capture-extraction-v1` subscription using subscription-scoped Data Receiver, while a
separate `INTELLIGENCE_WORKER_KIND=extraction` worker performs admitted processing. A custom
subscription name is not accepted by this topology. Ingest processing receives only its runtime
database/signing-key secrets, not Recall or model credentials.

Account's `capture_extraction` purpose starts with zero allowed tokens/concurrency. An operator
must explicitly approve a positive budget; setting feature flags does not authorize unlimited or
free model usage. Exact consent, membership, source revision and deletion barriers still apply.
Do not activate this chain on source/unit checks alone: owning database, signed composition,
broker identity/delivery and approved model qualification remain release gates.

Build and promote immutable `@sha256:` image references into an existing approved Azure Container Registry. Include the independently built frontend (`infra/containers/web.Dockerfile`), native services (`infra/containers/service.Dockerfile`), pinned OpenFGA 1.22.0 mirror and bootstrap image (`bootstrap/Dockerfile`, PostgreSQL 17 alpine input digest). Frontend WorkOS client/API-host build arguments are public identifiers, not API secrets. Native images must include current owning migrations/specs. Qualify each image; the template does not build/push it.

Each `runtimeConfig.<service>` / `migrationConfig.<service>` / `bootstrapConfig.<db>` object contains `image`, `env: [{name,value}]` and `secrets: [{env,ref,secretName,version}]`. `version` is the actual 32-hex Key Vault version; immutable versions permit explicit rotation/rollback. Secrets are read with a distinct per-process identity and a role scoped to that individual secret. Do not share a filled deployment file or commit it.

Example **shape only**:

```json
{
  "image": "YOURREGISTRY.azurecr.io/ingest@sha256:REPLACE_WITH_REAL_64_HEX_DIGEST",
  "env": [{ "name": "SERVICE_KEY_ID", "value": "ingest-2026-rotation-1" }],
  "secrets": [
    {
      "env": "INGEST_DATABASE_URL",
      "ref": "runtime-dsn",
      "secretName": "ingest-runtime-dsn",
      "version": "REPLACE_WITH_REAL_32_HEX_VERSION"
    }
  ]
}
```

The orchestrator owns private service origins, native port 8080, production NODE_ENV, managed-identity client IDs, Service Bus namespace, server-controlled Account cell ID and gateway cell routes. Configuration must not override those. All remaining native variables come from the service's current `.env.example` **and actual runtime schema**. Delete empty optional entries rather than setting empty strings. The configuration guard intentionally rejects plaintext keys/DSNs, private fields in public JWKS, unsafe local/TLS URLs, duplicated entries, mutable images and administrator/migration secrets in APIs.

## Database credentials (Key Vault values only)

| Service/database          | Runtime variable and role                          | Migration variable and role                                    |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| account/account           | ACCOUNT_DATABASE_URL; vs_account_runtime           | ACCOUNT_MIGRATION_DATABASE_URL; vs_account_migration           |
| workspace/workspace       | WORKSPACE_DATABASE_URL; vs_workspace_runtime       | WORKSPACE_MIGRATION_DATABASE_URL; vs_workspace_migration       |
| ingest/ingest             | INGEST_DATABASE_URL; vs_ingest_runtime             | INGEST_MIGRATION_DATABASE_URL; vs_ingest_migration             |
| integration/integration   | INTEGRATION_DATABASE_URL; vs_integration_runtime   | INTEGRATION_MIGRATION_DATABASE_URL; vs_integration_migration   |
| intelligence/intelligence | INTELLIGENCE_DATABASE_URL; vs_intelligence_runtime | INTELLIGENCE_MIGRATION_DATABASE_URL; vs_intelligence_migration |
| workflow/workflow         | WORKFLOW_DATABASE_URL; vs_workflow_runtime         | WORKFLOW_MIGRATION_DATABASE_URL; vs_workflow_migration         |
| reporting/reporting       | REPORTING_DATABASE_URL; vs_reporting_runtime       | REPORTING_MIGRATION_DATABASE_URL; vs_reporting_migration       |
| notification/notification | NOTIFICATION_DATABASE_URL; vs_notification_runtime | **NOTIFICATION_MIGRATION_URL**; vs_notification_migration      |
| authz/authz_application   | AUTHZ_DATABASE_URL; vs_authz_app_runtime           | AUTHZ_MIGRATION_DATABASE_URL; vs_authz_app_migration           |
| openfga/authz             | OPENFGA_DATASTORE_URI; vs_authz_runtime            | OPENFGA_DATASTORE_URI; vs_authz_migration                      |

DSN shape: `postgres://ROLE:URL_ENCODED_PASSWORD@PRIVATE_SERVER.postgres.database.azure.com:5432/DATABASE?sslmode=verify-full`. Bootstrap passwords must match these DSNs. The bootstrap does not rotate or overwrite existing role passwords; a rerun with unrelated secrets fails connection qualification instead of silently resetting data access. Runtime roles have no membership, ownership, CREATE, BYPASSRLS or superuser privileges. Administrator retains narrowly explicit migration-role membership for operator setup only.

## Required trust/provider configuration

- Every signing service gets its **own** EdDSA `SERVICE_PRIVATE_JWK` secret and `SERVICE_KEY_ID`; Account needs these for optional capture-processing callbacks. Gateway and public service APIs pin each expected caller's public JWKS. Account `SERVICE_TRUSTED_JWKS` is a caller-name map, not a single shared caller key. Never place private JWK fields inside a public JWKS. Rotation accepts explicitly coordinated current/previous public keys only.
- Account/gateway: WorkOS client ID, token issuer/audience. Optional Account `WORKOS_PROFILE_API_KEY` is a server secret; missing verified-profile configuration means email stays unavailable. Native sessions/refresh and actual WorkOS redirect behavior require live qualification.
- Workspace: caller-specific Ingest/Integration/Intelligence/Reporting/Workflow/Notification public keys and `DELETION_SERVICE_ORIGINS` mapping to the output private cell origins (including Authz). A missing deletion participant keeps deletion pending; do not omit it to fake completion. Accepted-record evidence needs Ingest/Intelligence trust. Context assignment never grants read access.
- Ingest: Recall region/API key, signed lifecycle/realtime secret versions, HTTPS `/webhooks/v3/cells/CELL/recall` callback; pinned gateway/integration/intelligence/reporting/workspace and any current automatic-processing caller keys. ZDR/text-only configuration remains enforced by native adapters. No retained media is enabled by IaC.
- Integration: `TOKEN_KEY_ID` + secret `TOKEN_KEYS` AES key ring, real `CALENDAR_REDIRECT_URI`, minimum-read Google/Microsoft OAuth ID/secret pairs, gateway/workspace/workflow pins. Optional push base is `https://OWNED_HOST/webhooks/v3/cells/CELL/calendars/`. No calendar write scopes are added. OAuth finish is an authenticated native API operation; the web callback route/state exchange must be proven, not assumed from an edge `/oauth/*` rule. Approved connector credentials remain encrypted/private and explicit owner authorization is mandatory.
- Intelligence: Azure endpoint and versioned text/embedding deployments; its API/worker identities need approved resource-scoped model access, operator-owned Account budgets/concurrency and owning extended migrations. `INTELLIGENCE_MODEL_ADMISSION_ENABLED`, preparation and retrieval are explicit flags. The preparation/indexing worker gates must agree with those flags. `enableIntelligenceEvents` deploys the current owning publisher; enable only with its image/migration qualification. No model resource/quota is created by this template.
- Authz/OpenFGA: private OPENFGA_URL is generated. Configure matching secret OpenFGA API key / engine preshared-key array, model/store IDs and Workspace public key. Engine env requires postgres datastore, preshared auth, disabled playground and JSON/safe logging. Provision store/model with the existing authorized bootstrap procedure **after** engine availability; source definition alone does not create model IDs.
- Workflow: gateway/workspace/integration pins and private origins. Integration execution does not bypass approved exact payload/source/destination checks.
- Reporting: gateway and workspace pins. Native text export is service-owned persistence today; Blob provisioning is not a newly wired export adapter.
- Notification: `WEB_APP_ORIGIN` is the verified owned HTTPS first-party frontend origin; gateway/workspace/event-caller pins. Azure email endpoint/sender are optional and must be configured together with authoritative verified WorkOS profiles, provider RBAC, consent and domain proof. Leave email variables absent until that paid/provider gate is approved. `ALLOW_LOCAL_EMAIL_AZURE_CLI=false` in production. Provider_sent does not mean mailbox delivery.

## Azure and operational gates

Supply actual approved subscription/RG/ACR IDs, globally unique 3–8 character lowercase prefix, stage, region and distinct supported HA zones. Examples use placeholder identifiers deliberately. Account/cell provisioning passwords use ARM Key Vault references to an existing operator-controlled provisioning vault; infrastructure outputs expose hosts/URIs, never secret values. Populating private vaults requires an authorized VNet-reachable operator or deployment agent; no public-vault/network bypass is acceptable.

The image registry may require existing networking and trusted ACA managed-identity pull support. AcrPull assumes an ordinary RBAC registry, not ABAC-only repository permissions; ABAC registries need explicitly reviewed repository-reader assignments. Bootstrap/jobs and APIs use different identities; no API can read the provisioning secret. Optional model/email/storage roles are not automatically granted to every service.
