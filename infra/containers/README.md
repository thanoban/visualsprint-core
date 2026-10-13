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
