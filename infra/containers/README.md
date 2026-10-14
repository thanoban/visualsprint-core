# V3 service images

Build from the repository root; this Dockerfile's default-deny context excludes legacy code,
credentials, environment files, recordings, tests and generated host artifacts.

```powershell
docker build -f infra/containers/service.Dockerfile --build-arg SERVICE=gateway -t visualsprint-v3-gateway:local .
```

Use one image per service. Run APIs with default CMD; workers/jobs override it with
`node dist/worker.mjs`, `node dist/events.mjs` or `node dist/migrate.mjs` only where that
entrypoint exists. Migration credentials belong only to migration jobs. Runtime images
run as the non-root node user; inject configuration/secrets at runtime, never build arguments.

pnpm 11.1.3 uses explicit legacy portable deployment because this repository does not enable
workspace injection. Services whitelist dist/migrations/specs so opt-in Intelligence extended
migrations remain available without shipping source/test/environment files. Technical workspace
dependencies and production vendor dependencies are packaged by pnpm; do not copy host node_modules.

Default Node tag is for local development. Release CI must supply a reviewed digest-pinned
NODE_IMAGE, scan the resulting image, promote the same image digest and qualify actual native
entrypoints/configuration in staging. A successful Docker build is not an Azure deployment or
provider qualification. See [pnpm deploy](https://pnpm.io/cli/deploy).

## Local verification

After building the gateway image:

```powershell
node --test tests/container/packaging.test.mjs
```

The smoke test uses generated throwaway signing keys and invalid external origins, verifies
non-root execution/source exclusion/dependency resolution, starts the actual API and checks
health. It stops only its own temporary container. It does not use identity/model providers.
Gateway build and this smoke test passed locally. Each other service image, worker/migration
command and deployment configuration still requires its own qualification before release.

## Frontend image

```powershell
docker build -f infra/containers/web.Dockerfile --build-arg VITE_WORKOS_CLIENT_ID=client_packaging_fixture --build-arg VITE_WORKOS_API_HOSTNAME=auth.invalid -t visualsprint-v3-web:local .
node --test tests/container/packaging.test.mjs
```

These are deliberately invalid public authentication fixtures for smoke tests, not production
credentials. Real release builds require the public WorkOS client ID and configured auth hostname.
Never put API/model/service secrets into VITE variables or build arguments. Frontend configuration
is baked into this artifact; differing environment configs require distinct builds/digests.

The frontend image includes static dist output and a small non-root Node static server, not backend
code, node_modules or environment files. SPA navigation uses index.html; missing assets, dotfiles
and decoded traversal attempts are rejected. Responses omit URL/query logging. Private API and
provider callback routes are not proxied by this server: Front Door must route /api/* and /webhooks/*
to the gateway, with web assets/navigation routed to this separate frontend origin.

Web and gateway container smoke tests passed locally, including HTML/assets/health, private-path
rejection and non-root execution. Real browser authentication, Front Door routing, release image
scanning, deployment recovery and provider behavior remain separate qualification gates.
