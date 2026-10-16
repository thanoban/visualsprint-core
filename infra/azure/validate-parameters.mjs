import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const services = [
  "account",
  "gateway",
  "web",
  "openfga",
  "workspace",
  "authz",
  "ingest",
  "integration",
  "intelligence",
  "workflow",
  "reporting",
  "notification",
];
export const databases = [
  "account",
  "workspace",
  "ingest",
  "integration",
  "intelligence",
  "workflow",
  "notification",
  "reporting",
  "authz_application",
  "authz",
];
const generated = new Set([
  "NODE_ENV",
  "PORT",
  "AZURE_CLIENT_ID",
  "ACCOUNT_INTERNAL_URL",
  "WORKSPACE_INTERNAL_URL",
  "INGEST_INTERNAL_URL",
  "INTEGRATION_INTERNAL_URL",
  "INTELLIGENCE_INTERNAL_URL",
  "WORKFLOW_INTERNAL_URL",
  "AUTHZ_INTERNAL_URL",
  "OPENFGA_URL",
  "SERVICE_BUS_NAMESPACE",
  "AZURE_WEB_PUBSUB_ENDPOINT",
  "CELL_ROUTES",
  "DEFAULT_CELL_ID",
]);
const privateEnv =
  /(?:DATABASE_URL|MIGRATION_URL|MIGRATION_DATABASE_URL|PRIVATE_JWK|API_KEY|TOKEN_KEYS|CLIENT_SECRET|WEBHOOK_SECRETS|PRESHARED_KEYS|PASSWORD)$/;
const refs =
  /\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[a-z0-9_-]+\/providers\/Microsoft.KeyVault\/vaults\/[a-z0-9-]+$/i;
function assert(ok, code) {
  if (!ok) throw new Error(code);
}
function config(value, p, name, kind) {
  assert(
    value && Array.isArray(value.env) && Array.isArray(value.secrets),
    `CONFIG_REQUIRED:${kind}:${name}`,
  );
  assert(
    new RegExp(`^${p.registryName}\\.azurecr\\.io/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$`).test(
      value.image,
    ) && !value.image.endsWith("0".repeat(64)),
    `DIGEST_IMAGE_REQUIRED:${name}`,
  );
  const used = new Set();
  for (const entry of value.env) {
    assert(
      entry &&
        /^[A-Z][A-Z0-9_]+$/.test(entry.name) &&
        typeof entry.value === "string" &&
        entry.value.length > 0,
      `ENV_INVALID:${name}`,
    );
    assert(!used.has(entry.name), `ENV_DUPLICATE:${name}:${entry.name}`);
    used.add(entry.name);
    assert(!privateEnv.test(entry.name), `SECRET_IN_PLAINTEXT:${name}:${entry.name}`);
    assert(
      kind !== "runtime" || !generated.has(entry.name),
      `GENERATED_ENV_OVERRIDE:${entry.name}`,
    );
    assert(
      kind !== "bootstrap" ||
        !["PGHOST", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGSSLROOTCERT", "DB_NAME"].includes(
          entry.name,
        ),
      `BOOTSTRAP_IDENTITY_OVERRIDE:${entry.name}`,
    );
    assert(
      !/(localhost|127\.0\.0\.1|sslmode=(?:disable|require|prefer)|rejectUnauthorized)/i.test(
        entry.value,
      ),
      `INSECURE_CONFIG:${name}`,
    );
    if (/JWKS$/.test(entry.name)) {
      let keys;
      try {
        keys = JSON.parse(entry.value);
      } catch {
        throw new Error(`JWKS_INVALID:${name}`);
      }
      assert(
        !/"(?:d|p|q|dp|dq|qi)"\s*:/.test(entry.value) && keys && typeof keys === "object",
        `PRIVATE_KEY_IN_PUBLIC_CONFIG:${name}`,
      );
    }
  }
  const names = new Set();
  const secretRefs = new Set();
  for (const binding of value.secrets) {
    assert(
      binding &&
        /^[A-Z][A-Z0-9_]+$/.test(binding.env) &&
        /^[a-z][a-z0-9-]{0,126}$/.test(binding.ref) &&
        /^[a-z0-9-]{1,127}$/.test(binding.secretName) &&
        /^[0-9a-f]{32}$/.test(binding.version),
      `SECRET_REFERENCE_INVALID:${name}`,
    );
    assert(
      !used.has(binding.env) && !names.has(binding.secretName) && !secretRefs.has(binding.ref),
      `SECRET_DUPLICATE:${name}`,
    );
    used.add(binding.env);
    names.add(binding.secretName);
    secretRefs.add(binding.ref);
    assert(
      kind !== "runtime" || !generated.has(binding.env),
      `GENERATED_SECRET_OVERRIDE:${binding.env}`,
    );
    assert(
      kind !== "bootstrap" ||
        !["PGHOST", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGSSLROOTCERT", "DB_NAME"].includes(
          binding.env,
        ),
      `BOOTSTRAP_IDENTITY_OVERRIDE:${binding.env}`,
    );
    assert(
      kind === "bootstrap" || !/admin|provisioner|bootstrap/.test(binding.secretName),
      `ADMIN_SECRET_FORBIDDEN:${name}`,
    );
    assert(
      kind !== "runtime" || !/MIGRATION|PASSWORD|^PG/.test(binding.env),
      `MIGRATION_SECRET_IN_RUNTIME:${name}`,
    );
  }
  if (kind === "runtime" && !["gateway", "web"].includes(name))
    assert(
      value.secrets.some((x) => /DATABASE_URL|DATASTORE_URI/.test(x.env)),
      `RUNTIME_DATABASE_SECRET_REQUIRED:${name}`,
    );
  if (kind === "migration")
    assert(
      value.secrets.some((x) => /MIGRATION|DATASTORE_URI/.test(x.env)),
      `MIGRATION_SECRET_REQUIRED:${name}`,
    );
  if (kind === "bootstrap")
    for (const key of ["PGPASSWORD", "MIGRATION_PASSWORD", "RUNTIME_PASSWORD"])
      assert(
        used.has(key) && value.secrets.some((x) => x.env === key),
        `BOOTSTRAP_SECRET_REQUIRED:${name}:${key}`,
      );
  if (
    kind === "runtime" &&
    [
      "account",
      "gateway",
      "workspace",
      "ingest",
      "integration",
      "intelligence",
      "workflow",
      "reporting",
      "notification",
    ].includes(name)
  ) {
    assert(
      used.has("SERVICE_PRIVATE_JWK") && used.has("SERVICE_KEY_ID"),
      `SIGNING_CONFIGURATION_REQUIRED:${name}`,
    );
  }
  if (kind === "runtime" && name === "intelligence") {
    const env = Object.fromEntries(value.env.map((x) => [x.name, x.value]));
    if (p.enablePreparationWorker)
      assert(
        env.INTELLIGENCE_PREPARATION_ENABLED === "true" &&
          env.INTELLIGENCE_MODEL_ADMISSION_ENABLED === "true",
        "PREPARATION_WORKER_NOT_ENABLED",
      );
    if (p.enableIndexingWorker)
      assert(
        env.INTELLIGENCE_RETRIEVAL_ENABLED === "true" &&
          env.INTELLIGENCE_MODEL_ADMISSION_ENABLED === "true",
        "INDEXING_WORKER_NOT_ENABLED",
      );
  }
}
export function validateParameters(document) {
  const p = Object.fromEntries(
    Object.entries(document.parameters ?? {}).map(([name, entry]) => [name, entry.value ?? entry]),
  );
  assert(/^[a-z][a-z0-9]{2,7}$/.test(p.prefix), "PREFIX_INVALID");
  assert(
    ["staging", "production"].includes(p.stage) &&
      /^[a-z0-9-]+$/.test(p.location) &&
      /^[a-z0-9-]{1,100}$/.test(p.cellId ?? "cell-1"),
    "ENVIRONMENT_INVALID",
  );
  assert(
    /^[a-z0-9]{5,50}$/.test(p.registryName) &&
      typeof p.registryResourceGroup === "string" &&
      p.registryResourceGroup.length > 0,
    "REGISTRY_REQUIRED",
  );
  for (const key of ["accountAdministratorPassword", "cellAdministratorPassword"])
    assert(
      p[key]?.reference &&
        refs.test(p[key].reference.keyVault?.id ?? "") &&
        /^[a-z0-9-]+$/.test(p[key].reference.secretName ?? ""),
      `ADMIN_KEY_VAULT_REFERENCE_REQUIRED:${key}`,
    );
  for (const key of [
    "activateRuntime",
    "activateMigrationJobs",
    "activateBootstrapJobs",
    "activateMaintenanceJobs",
    "activateEdge",
    "enablePreparationWorker",
    "enableIndexingWorker",
    "enableIntelligenceEvents",
    "enableCaptureExtractionWorker",
    "enableNotificationRealtime",
  ])
    assert(p[key] === undefined || typeof p[key] === "boolean", `FLAG_INVALID:${key}`);
  assert(
    p.publicHostname === undefined ||
      p.publicHostname === "" ||
      /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(p.publicHostname),
    "PUBLIC_HOSTNAME_INVALID",
  );
  assert(!p.activateEdge || p.activateRuntime, "EDGE_REQUIRES_RUNTIME");
  assert(!p.enablePreparationWorker || p.activateRuntime, "PREPARATION_REQUIRES_RUNTIME");
  assert(!p.enableIndexingWorker || p.activateRuntime, "INDEXING_REQUIRES_RUNTIME");
  assert(!p.enableIntelligenceEvents || p.activateRuntime, "EVENTS_REQUIRES_RUNTIME");
  assert(!p.enableNotificationRealtime || p.activateRuntime, "REALTIME_REQUIRES_RUNTIME");
  assert(
    !p.enableCaptureExtractionWorker || (p.activateRuntime && p.enableIntelligenceEvents),
    "EXTRACTION_REQUIRES_RUNTIME_AND_EVENTS",
  );
  const groups = [
    [p.activateRuntime, services, p.runtimeConfig, "runtime"],
    [
      p.activateMigrationJobs,
      services.filter((x) => !["gateway", "web"].includes(x)),
      p.migrationConfig,
      "migration",
    ],
    [p.activateBootstrapJobs, databases, p.bootstrapConfig, "bootstrap"],
  ];
  for (const [active, expected, configs, kind] of groups) {
    assert(
      configs === undefined || (configs && typeof configs === "object" && !Array.isArray(configs)),
      `CONFIG_MAP_INVALID:${kind}`,
    );
    for (const key of Object.keys(configs ?? {}))
      assert(expected.includes(key), `UNKNOWN_SERVICE:${kind}:${key}`);
    if (active) for (const name of expected) config(configs?.[name], p, name, kind);
    else for (const [name, value] of Object.entries(configs ?? {})) config(value, p, name, kind);
  }
  if (p.activateMaintenanceJobs)
    for (const name of ["intelligence", "authz"])
      config(p.bootstrapConfig?.[name], p, name, "bootstrap");
  const realtimeFlag = (p.runtimeConfig?.notification?.env ?? []).find(
    (entry) => entry.name === "NOTIFICATION_REALTIME_ENABLED",
  )?.value;
  assert(
    realtimeFlag === undefined || ["true", "false"].includes(realtimeFlag),
    "REALTIME_FLAG_INVALID",
  );
  assert(
    Boolean(p.enableNotificationRealtime) === (realtimeFlag === "true"),
    "REALTIME_ACTIVATION_MISMATCH",
  );
  if (p.enableCaptureExtractionWorker) {
    const env = (name) =>
      Object.fromEntries(
        (p.runtimeConfig?.[name]?.env ?? []).map((entry) => [entry.name, entry.value]),
      );
    const account = env("account"),
      ingest = env("ingest"),
      intelligence = env("intelligence");
    assert(
      account.CAPTURE_PROCESSING_ENABLED === "true" &&
        account.CAPTURE_MODEL_ADMISSION_ENABLED === "true",
      "CAPTURE_ADMISSION_NOT_ENABLED",
    );
    assert(
      ingest.CAPTURE_PROCESSING_ENABLED === "true" &&
        ingest.CAPTURE_EXTRACTION_PUBLISH_ENABLED === "true",
      "CAPTURE_PRODUCER_NOT_ENABLED",
    );
    assert(
      intelligence.INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED === "true" &&
        intelligence.INTELLIGENCE_MODEL_ADMISSION_ENABLED === "true",
      "CAPTURE_CONSUMER_NOT_ENABLED",
    );
    assert(
      intelligence.INTELLIGENCE_CAPTURE_SUBSCRIPTION === undefined ||
        intelligence.INTELLIGENCE_CAPTURE_SUBSCRIPTION === "capture-extraction-v1",
      "CAPTURE_SUBSCRIPTION_MISMATCH",
    );
  }
  return {
    valid: true,
    stage: p.stage,
    runtime: !!p.activateRuntime,
    migrations: !!p.activateMigrationJobs,
    bootstrap: !!p.activateBootstrapJobs,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(validateParameters(JSON.parse(readFileSync(process.argv[2], "utf8")))),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
