# Azure infrastructure source package

Status: locally compiled infrastructure source, **not deployed or production-qualified**. No Azure login, subscription lookup, what-if, deployment, provider calls or paid resource changes were performed. The existing application remains untouched.

## Entry points and boundaries

`main.bicep` is a subscription-scoped first-region deployment with separate global Account and regional-cell resource groups. Foundations create infrastructure even when every activation flag is false: **false flags do not make an Azure deployment free**. Deployment needs a separate cost and authority decision.

| Module         | Executable source responsibility                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| network        | Non-overlapping /23 Container Apps subnets, separate delegated PostgreSQL subnets, non-delegated endpoints subnet, NAT/static outbound IPv4 and shared private DNS                                               |
| foundation     | Private workload-profile Container Apps environment, private PostgreSQL 17 with zone-redundant HA, service logical databases, Key Vault RBAC/private endpoint, private application DNS and bounded Log Analytics |
| cell-resources | Service Bus Standard/TLS/Entra/IP firewall; owned topics and Notification subscriptions; private text-only Blob; private PubSub server endpoint with public client-only WSS                                      |
| runtime        | Separate managed identities; secret-scoped Key Vault reader and registry-scoped AcrPull; API, worker or manual/scheduled Job definition; private-environment HTTPS ingress                                       |
| event-access   | Topic-only sender or subscription-only receiver; no namespace Owner access                                                                                                                                       |
| edge           | Front Door Premium, separate private gateway/frontend origins, WAF/internal-route block, HTTPS and optional managed-certificate owned domain                                                                     |
| bootstrap      | Manual role/bootstrap, vector-extension and post-OpenFGA-migration grant scripts; separate non-owner runtime and owning migration credentials                                                                    |

The runtime consists of native service APIs and independent workers. Account is in the global environment and its own physical server. Cell services use private logical databases on a separate physical HA server. Authz application and OpenFGA use distinct logical databases/roles. No cross-service SQL is introduced.

Service-to-service ingress uses `external: true` **inside internal-VIP/public-network-disabled environments**. Container Apps `external: false` is same-environment only and would break Account → Ingest callbacks. Private DNS connects both environments in the regional VNet; native service signatures, membership checks and caller-specific JWKS remain mandatory. Private networking is not an authorization substitute. [Microsoft app-to-app networking](https://learn.microsoft.com/en-us/azure/container-apps/connect-apps), [private Front Door origins](https://learn.microsoft.com/en-us/azure/container-apps/front-door-custom-virtual-network-private-link).

Service Bus Standard has **no private endpoint or VNet service-endpoint rule** here. Its authenticated public TLS endpoint accepts only the NAT IP, local/SAS authentication is disabled and trusted-service bypass is off. [Microsoft Standard networking constraints](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-ip-filtering).

## Local verification only

Use an explicitly supplied official Bicep binary. The runner never installs tools, logs in, skips a missing compiler or calls Azure.

```powershell
$env:BICEP_BIN = 'C:\absolute\path\bicep.exe'
node infra/azure/validate.mjs
node infra/azure/validate-parameters.mjs infra/azure/parameters/staging.example.json
# Optional owning SQL qualification: requires an already-local PostgreSQL fixture image and Docker.
$env:AZURE_BOOTSTRAP_TEST_ENABLED = 'true'
node --test infra/azure/test/bootstrap.test.mjs
```

Cross-platform CI uses `BICEP_BIN=/absolute/path/bicep node infra/azure/validate.mjs`. Compiler pin: 0.48.1, [official release](https://github.com/Azure/bicep/releases/tag/v0.48.1).

| Asset             | SHA-256                                                          |
| ----------------- | ---------------------------------------------------------------- |
| bicep-linux-x64   | b09ec25a9d376c1f8e33ede6ed22b587f915ad68488d5db77a6f9541748c7f6e |
| bicep-win-x64.exe | 398af294cf16ac4becdbd008a77d148d0e8e91492309a6b60ec911b7e1cab082 |

The local Windows binary matched the official release digest. Initial per-user `az bicep install` installed the compiler/tool-path setting only; subsequent compilation uses an ignored isolated copy. No subscription credentials were queried. `.tools/`, compiled `out/` and `*.local.json` parameters are ignored. Do not commit filled configurations or binaries.

The optional SQL suite uses only a fresh labelled container, no published ports or existing databases/volumes. It verifies a non-superuser CREATEROLE administrator, idempotent bootstrap, private runtime privileges, forbidden role switching/DDL, rejected unsafe existing roles and rejected identifiers. It removes only its own labelled fixture. Azure-specific administrator differences and private TLS remain staging gates.

## Activation and truthful limits

`activateRuntime`, `activateMigrationJobs`, `activateBootstrapJobs`, `activateMaintenanceJobs` and `activateEdge` are independent explicit gates. Jobs deploy without executing; migrations and role setup are never automatic. Preparation, indexing and Intelligence events have additional explicit worker gates. Native Intelligence events now has an owning published entrypoint; enable its named worker to publish summary-ready events.

Critical Account/gateway/Ingest APIs have at least two warm replicas after activation. Worker loops remain single-replica, owning lease/idempotency fences protect replay; this is a starting capacity configuration, not a latency/HA guarantee. Native `/health` proves process liveness, not healthy databases/providers. OpenFGA uses `/healthz`. PostgreSQL pools remain bounded natively; total connections across replicas/workers must be qualified against the chosen server.

`staging.example.json` is an **unfilled structural example**, not a deployable environment. Offline validation verifies types, secret-reference boundaries, digest pins, naming constraints and activation consistency; it cannot inspect Key Vault secret contents, prove provider registrations, native configuration completeness or Azure authorization. Fill and validate the complete inventory in [CONFIGURATION.md](CONFIGURATION.md) before runtime activation.

Native PostgreSQL currently uses password DSNs, not rotating Entra database tokens. APIs receive only per-service runtime DSNs; migration Jobs receive only migration DSNs. Bootstrap Jobs alone receive administrator credentials. Managed identities authenticate Key Vault, ACR, Service Bus and optional supported Azure adapters. **Do not put the administrator DSN in an application**, set `rejectUnauthorized:false` or relax TLS. Node DSNs require `sslmode=verify-full`; PostgreSQL 17 bootstrap uses `PGSSLMODE=verify-full`, `PGSSLROOTCERT=system`. [libpq system roots](https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-CONNECT-SSLROOTCERT).

PubSub and Blob infrastructure exist as source, but native PubSub negotiation and Blob export/import adapters are not connected by this slice. Browser WSS requires public `ClientConnection`; REST/server/trace access is denied publicly and routed privately. Resource provisioning is not a realtime or storage-feature proof. Model deployments, email resources, CI federated identity and registry provisioning are operator-owned dependencies, not silently created here.

Front Door access/WAF diagnostic logs are intentionally not enabled: they can retain OAuth query strings/passcodes/bodies. Do not enable them until a verified redaction pipeline and retention policy exist. App logging uses existing redacted native loggers; no request content is added by these templates. App Insights is provisioned with Entra-only auth; native OTEL export/metric-alert routing still needs qualification/configuration.

See [RUNBOOK.md](RUNBOOK.md) for authorized future deployment sequence, domain/provider migration, restoration/rollback and release gates. Preserve the previous $1,200–1,800/month **planning allowance**, not a quote; warm replicas, NAT, private endpoints, log retention, model/Recall usage and actual Azure region can change it. Reprice this complete template before any paid provisioning.
