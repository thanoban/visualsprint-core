import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { validateParameters, services } from "../validate-parameters.mjs";
const template = () =>
  JSON.parse(readFileSync(new URL("../parameters/staging.example.json", import.meta.url), "utf8"));
function runtime() {
  const p = template();
  p.parameters.activateRuntime.value = true;
  p.parameters.runtimeConfig.value = Object.fromEntries(
    services.map((name) => [
      name,
      {
        image: `replacewithregistry.azurecr.io/${name}@sha256:${"a".repeat(64)}`,
        env: ["gateway", "web", "openfga", "authz"].includes(name)
          ? []
          : [{ name: "SERVICE_KEY_ID", value: "fixture-1" }],
        secrets: [],
      },
    ]),
  );
  for (const [name, c] of Object.entries(p.parameters.runtimeConfig.value)) {
    const binding = (env) => ({
      env,
      ref: env.toLowerCase().replaceAll("_", "-"),
      secretName: `${name}-${env.toLowerCase().replaceAll("_", "-")}`,
      version: "b".repeat(32),
    });
    if (!["gateway", "web"].includes(name))
      c.secrets.push(
        binding(
          name === "openfga" ? "OPENFGA_DATASTORE_URI" : `${name.toUpperCase()}_DATABASE_URL`,
        ),
      );
    if (!["web", "openfga", "authz"].includes(name)) {
      c.secrets.push(binding("SERVICE_PRIVATE_JWK"));
      if (name === "gateway") c.env.push({ name: "SERVICE_KEY_ID", value: "fixture-1" });
    }
  }
  return p;
}
test("foundations alone never imply runtime or paid-provider activation", () =>
  assert.equal(validateParameters(template()).runtime, false));
test("all independently configured native APIs accept pinned fixture references", () =>
  assert.equal(validateParameters(runtime()).runtime, true));
test("refuses raw administrator secrets", () => {
  const p = template();
  p.parameters.accountAdministratorPassword = { value: "not-a-secret-reference" };
  assert.throws(() => validateParameters(p), /ADMIN_KEY/);
});
test("refuses mutable or all-zero images", () => {
  for (const image of [
    "registry/api:latest",
    `replacewithregistry.azurecr.io/api@sha256:${"0".repeat(64)}`,
  ]) {
    const p = runtime();
    p.parameters.runtimeConfig.value.ingest.image = image;
    assert.throws(() => validateParameters(p), /DIGEST/);
  }
});
test("refuses plaintext private keys, DSNs and model keys", () => {
  for (const name of ["SERVICE_PRIVATE_JWK", "INGEST_DATABASE_URL", "RECALL_API_KEY"]) {
    const p = runtime();
    p.parameters.runtimeConfig.value.ingest.env.push({ name, value: "do-not-print" });
    assert.throws(() => validateParameters(p), /SECRET_IN_PLAINTEXT/);
  }
});
test("rejects duplicate env, private public-JWKS and generated URL override", () => {
  for (const entry of [
    { name: "SERVICE_KEY_ID", value: "another" },
    { name: "GATEWAY_PUBLIC_JWKS", value: '{"d":"not-public"}' },
    { name: "INGEST_INTERNAL_URL", value: "https://example.org" },
  ]) {
    const p = runtime();
    p.parameters.runtimeConfig.value.ingest.env.push(entry);
    assert.throws(() => validateParameters(p));
  }
});
test("refuses migration or admin secrets in APIs", () => {
  for (const update of [
    { env: "INGEST_MIGRATION_DATABASE_URL" },
    { secretName: "admin-password" },
  ]) {
    const p = runtime();
    Object.assign(p.parameters.runtimeConfig.value.ingest.secrets[0], update);
    assert.throws(() => validateParameters(p), /MIGRATION|ADMIN/);
  }
});
test("requires all runtime services and blocks unfinished partial config", () => {
  const p = runtime();
  delete p.parameters.runtimeConfig.value.workspace;
  assert.throws(() => validateParameters(p), /CONFIG_REQUIRED/);
});
test("feature workers require owning model-admission and feature flags", () => {
  const p = runtime();
  p.parameters.enablePreparationWorker = { value: true };
  assert.throws(() => validateParameters(p), /PREPARATION_WORKER/);
});
test("worker/event grants derive native publisher by name, not brittle numeric index", () => {
  const main = readFileSync(new URL("../main.bicep", import.meta.url), "utf8");
  assert.match(main, /indexOf\(workerNames, '\$\{publisher\}-events'\)/);
  assert.match(main, /indexOf\(workerNames, 'notification-events'\)/);
  for (const name of ["workspace", "ingest", "workflow", "notification", "intelligence"])
    assert.match(main, new RegExp(`name: '${name}-events', service: '${name}', entry: 'events'`));
});
test("private foundations and Service Bus Standard retain network/auth boundaries", () => {
  const foundation = readFileSync(new URL("../modules/foundation.bicep", import.meta.url), "utf8");
  const cell = readFileSync(new URL("../modules/cell-resources.bicep", import.meta.url), "utf8");
  assert.match(foundation, /publicNetworkAccess: 'Disabled'/);
  assert.match(foundation, /internal: true/);
  assert.match(foundation, /mode: 'ZoneRedundant'/);
  assert.match(cell, /name: 'Standard', tier: 'Standard'/);
  assert.match(cell, /disableLocalAuth: true/);
  assert.match(cell, /ipMask: egressIp/);
  assert.doesNotMatch(cell, /groupId: 'namespace'/);
});
test("maximum production names fit Key Vault/Blob/Container Apps limits", () => {
  const prefix = "vsaabbcc",
    stage = "production",
    base = `${prefix}-prd-c`;
  assert.ok(`${prefix}-${stage}-g-kv`.length <= 24);
  assert.ok(`${prefix}${stage}ctext`.length <= 24);
  for (const service of services) assert.ok(`${base}-${service}`.length <= 32);
  for (const service of services.filter((x) => !["web", "gateway"].includes(x))) {
    const alias = service
      .replace("intelligence", "ai")
      .replace("notification", "notify")
      .replace("integration", "connect");
    assert.ok(`${base}-${alias}-migrate`.length <= 32);
  }
  const p = template();
  p.parameters.prefix.value = "ninetynine";
  assert.throws(() => validateParameters(p), /PREFIX_INVALID/);
});
test("edge keeps internal routes blocked without forwarding-placeholder paths", () => {
  const edge = readFileSync(new URL("../modules/edge.bicep", import.meta.url), "utf8");
  assert.match(edge, /BlockInternalRoutes/);
  assert.doesNotMatch(edge, /internal-disabled/);
  assert.match(edge, /certificateType: 'ManagedCertificate'/);
});

function extraction() {
  const p = runtime();
  p.parameters.enableIntelligenceEvents = { value: true };
  p.parameters.enableCaptureExtractionWorker = { value: true };
  const add = (name, values) =>
    p.parameters.runtimeConfig.value[name].env.push(
      ...Object.entries(values).map(([name, value]) => ({ name, value })),
    );
  add("account", { CAPTURE_PROCESSING_ENABLED: "true", CAPTURE_MODEL_ADMISSION_ENABLED: "true" });
  add("ingest", { CAPTURE_PROCESSING_ENABLED: "true", CAPTURE_EXTRACTION_PUBLISH_ENABLED: "true" });
  add("intelligence", {
    INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED: "true",
    INTELLIGENCE_MODEL_ADMISSION_ENABLED: "true",
  });
  return p;
}
test("extraction deployment requires native events and all three explicit service gates", () => {
  assert.equal(validateParameters(extraction()).runtime, true);
  const missingEvents = extraction();
  missingEvents.parameters.enableIntelligenceEvents.value = false;
  assert.throws(() => validateParameters(missingEvents), /EXTRACTION_REQUIRES_RUNTIME_AND_EVENTS/);
  for (const [name, key, error] of [
    ["account", "CAPTURE_MODEL_ADMISSION_ENABLED", /CAPTURE_ADMISSION_NOT_ENABLED/],
    ["ingest", "CAPTURE_EXTRACTION_PUBLISH_ENABLED", /CAPTURE_PRODUCER_NOT_ENABLED/],
    ["intelligence", "INTELLIGENCE_CAPTURE_EXTRACTION_ENABLED", /CAPTURE_CONSUMER_NOT_ENABLED/],
  ]) {
    const p = extraction();
    p.parameters.runtimeConfig.value[name].env.find((entry) => entry.name === key).value = "false";
    assert.throws(() => validateParameters(p), error);
  }
});
test("extraction subscription is native-aligned and scoped to its event worker identity", () => {
  const p = extraction();
  p.parameters.runtimeConfig.value.intelligence.env.push({
    name: "INTELLIGENCE_CAPTURE_SUBSCRIPTION",
    value: "wrong-subscription",
  });
  assert.throws(() => validateParameters(p), /CAPTURE_SUBSCRIPTION_MISMATCH/);
  const main = readFileSync(new URL("../main.bicep", import.meta.url), "utf8");
  assert.match(main, /name: 'intelligence-extraction', service: 'intelligence', entry: 'worker'/);
  assert.match(main, /subscriptionName: 'capture-extraction-v1'/);
  assert.match(
    main,
    /name: 'ingest-processing', service: 'ingest', entry: 'events', extra: \{ INGEST_EVENT_WORKER_KIND: 'processing' \}/,
  );
  assert.match(main, /worker.name == 'ingest-processing' \? filter/);
  assert.match(main, /principalId: workerApps\[indexOf\(workerNames, 'intelligence-events'\)\]/);
  const resources = readFileSync(
    new URL("../modules/cell-resources.bicep", import.meta.url),
    "utf8",
  );
  assert.match(resources, /parent: topics\[indexOf\(publishers, 'ingest'\)\]/);
  assert.match(resources, /if \(enableCaptureExtraction\)/);
});
