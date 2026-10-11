# Local v3 development

Use the isolated `codex/zedex-web-rebuild` checkout. Commands below affect the v3
development Compose project only. Loopback database credentials are public test fixtures.
Production credentials must come from Key Vault and must use separate roles.

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

The outbox publisher is a port with PostgreSQL claims/fencing; the Azure broker adapter and
daemon arrive in a subsequent slice. OpenFGA, Account, gateway and web UI wiring have their
own acceptance gates. Passing the Workspace suite does not qualify a live meeting bot.

To stop these local dependencies while keeping test data:

```powershell
docker compose -f infra/local/compose.yml stop
```
