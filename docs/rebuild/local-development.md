# Local v3 development

Authz runs OpenFGA 1.22.0 backed by its own database. Compose runs vendor migrations
with a migration role, then grants limited runtime permissions. HTTP is loopback port 4180
with the public `local-openfga-only` fixture key; never use that key remotely.
Run `pnpm --filter @visualsprint/authz bootstrap` with `OPENFGA_URL` and `OPENFGA_API_KEY`
in the process environment. Save returned store/model IDs in the Authz runtime environment.
Bootstrap creates a fresh store; do not run on every API startup or deployment.
Configure Workspace `AUTHZ_INTERNAL_URL` and Authz `WORKSPACE_PUBLIC_JWKS`; no runtime
local-policy fallback exists. Production needs private HTTPS and separate Key Vault keys.

Use the isolated `codex/zedex-web-rebuild` checkout. Commands below affect the v3
development Compose project only. Loopback database credentials are public test fixtures.
Production credentials must come from Key Vault and must use separate roles.

The rebuilt browser lives in `apps/web`, separate from the legacy frontend. Configure its
public WorkOS client ID (and the owned authentication hostname in production). Register its
origin/redirect URI in WorkOS and configure the API JWT audience to match Account/gateway
`WORKOS_TOKEN_AUDIENCE`. Hosted sign-in/refresh use AuthKit. Never put WorkOS secret keys,
Recall credentials, signing keys or model keys in `VITE_*` variables.
Run `pnpm --filter @visualsprint/web dev` after starting signed local APIs. Same-origin
`/api/v3` proxies to loopback gateway port 4100. Production routes that same path to the gateway
instead of exposing individual services. Missing identity configuration shows setup guidance,
not an insecure demo login.
Run `pnpm --filter @visualsprint/web test:browser` for controlled browser checks. Windows uses
installed Edge; CI installs Playwright Chromium. Root integration also opens a browser against
real service APIs/databases and closes it after persistence verification.

```powershell
pnpm install --frozen-lockfile
docker compose -f infra/local/compose.yml up -d --wait --quiet-pull
pnpm check
pnpm build
pnpm test:integration
```

Workspace migrations run through `WORKSPACE_MIGRATION_DATABASE_URL`; the API uses
`WORKSPACE_DATABASE_URL` with `vs_workspace_runtime`. The runtime role cannot alter the
schema or migration ledger. Tenant context is transaction-local; FORCE RLS blocks reads
without a workspace context and cross-workspace writes. API checks additionally restrict
meetings to owners and explicit readers. Customers/projects are initially creator-private.

Build first with `pnpm build`. Services start from compiled native Node bundles;
production runtime does not require a TypeScript loader. Workspace packages are bundled
into each service; external dependencies remain service-local.
`pnpm --filter @visualsprint/workspace migrate` runs the service-owned migrations.
`pnpm --filter @visualsprint/workspace start` starts its HTTP service after the Account
membership authority is available and service keys have been configured. See its
`.env.example` for required process variables. The service never accepts user-supplied
actor headers: it verifies a 30-second signed gateway delegation for its own audience.

The integration suite uses real PostgreSQL, non-owner runtime connections and controlled
identity/membership providers. It covers tenant isolation, concurrent idempotency, private
projects/meetings, confirmation, separate sharing, revocation, stale edits, transaction
rollback, crash/redelivery and inbox deduplication. Missing PostgreSQL fails the suite.

WorkOS API tokens require a JWT template audience equal to the configured API URI. Configure
the exact issuer from the environment's token, client ID and audience; JWKS uses HTTPS.
The verifier requires signature, issuer, audience, expiry, session ID and matching client ID.
It returns 503 for unavailable signing-key infrastructure and 401 for invalid credentials.
[WorkOS verification guidance](https://workos.com/blog/verify-workos-access-tokens-in-your-own-api).

Account runs on a separate PostgreSQL server on loopback port 55434. Its service owns identity
mapping, membership, session revocation and the cell directory. Start Account with its service
`.env.example` variables, then Workspace, then gateway. The gateway resolves destinations from
the Account cell ID and operator-configured `CELL_ROUTES`; clients cannot supply a service URL.
Gateway and Account verify the WorkOS access token independently, and gateway-to-Account
requests additionally require a short signed identity assertion. Other service requests carry
an audience-specific signed actor/workspace/session assertion.

`pnpm test:integration` runs both owning-service suites and a composition suite through real
HTTP listeners. Only composition tests import several service entry points. The Account and
Workspace databases are separate; runtime source never reads another service's tables.

The outbox publisher uses PostgreSQL claims/fencing and the Azure adapter described below.
OpenFGA, web UI and live provider wiring have separate acceptance gates.
Passing the Workspace suite does not qualify a live meeting bot.

The Azure adapter is now available in `@visualsprint/messaging`; Workspace and Ingest have
separate compiled `events.mjs` publisher processes. Configure `SERVICE_BUS_NAMESPACE` and
optional `AZURE_CLIENT_ID`, then run the owning service's `events` script. Production uses
managed identity; local opt-in Azure execution uses Azure CLI credentials. No SAS connection
string or administrative provisioning is performed by application workers. Do not run these
publishers against a paid/live namespace until the environment and roles are approved.

To stop these local dependencies while keeping test data:

```powershell
docker compose -f infra/local/compose.yml stop
```
