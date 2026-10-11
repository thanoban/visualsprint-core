# Azure setup, operations and cost

Status: deployment target; no Azure resources provisioned by this rebuild.

## Required configuration

| Component | Setup |
|---|---|
| Azure | Subscription, approved region, separate environment resource groups, quota, OIDC CI identity |
| WorkOS | Application, production/staging redirect URIs, server credentials and verified session flow |
| OpenFGA | Per-cell store/model, authenticated service access, tuple sync and revocation tests |
| Recall | Regional API key, signed lifecycle webhook, signed realtime delivery, explicit ZDR for every creation/start |
| Google Calendar | OAuth application/consent, minimum calendar-read scopes, callback, watch renewal |
| Microsoft Calendar | Entra registration, consent, callback, Graph subscriptions/delta reconciliation |
| Azure AI | Versioned text/embedding deployments, region/quota and privacy evaluation |
| Jira/GitHub/Linear | Provider applications, scoped authorization, callbacks/webhooks and token refresh where supported |
| Email | Verified sender/domain and delivery configuration |

Secrets belong in Key Vault, not tracked files or logs. Rotate previously exposed credentials.
Use stable owned app/api domains. Keep existing OAuth callback paths where possible. A
provider-owned *.run.app hostname cannot be transferred to Azure; such URLs require a migration.
Server-side OAuth refresh uses concurrency control and a clear reauthorization state.

## Provisioning and release

Bicep must define global and regional-cell stacks, HA PostgreSQL and private service roles,
Container Apps APIs/workers/jobs, Service Bus Standard, Web PubSub, Key Vault, text Blob storage,
private application origins, Front Door Premium/WAF and telemetry.
Deployment is a later gate: this document is not executable IaC.

Build immutable images once; promote digests through staging/production. CI uses Azure workload
identity, not a long-lived subscription key. Run compatibility checks, staged rollouts and
expand/contract migrations. Database rollback is not assumed to undo newly written business data.

Track trace/request/capture IDs, state age, outbox age, consumer lag, webhook rejection, last text,
provider capacity/error classes, model quota and cost per workspace/hour. Do not record raw
transcripts, authorization headers, join passcodes or model prompts in telemetry.
Restore tests reapply deletion tombstones before enabling access.

## Cost worksheet

2026-10-11 planning baseline, USD, 730 hours/month, before tax:

| Item | Basis | Approximate monthly amount |
|---|---|---|
| Front Door Premium | Base fee | $330 |
| Account + cell PostgreSQL compute | Two 2-vCore servers, each with paid HA standby; $0.178/hour per node | $520 |
| Recall bot + base STT | 100 hours at $0.50 + $0.15/hour | $65 |
| Other | Container Apps, PG/Blob storage, network/private endpoints, PubSub, logs, identity extras, model tokens | Price with actual deployment |

Carry $1,200–1,800/month as an allowance, not a quote. Waiting time, concurrency speech/STT modifiers,
larger database sizes and additional cells can change this. Reprice the actual Bicep deployment
before provisioning; earlier $100–300 pilot estimates do not describe this production topology.

Sources: [Azure retail API](https://prices.azure.com/api/retail/prices),
[HA billing](https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql),
[Recall pricing](https://www.recall.ai/pricing),
[ZDR](https://docs.recall.ai/docs/zero-data-retention),
[private Container Apps origins](https://learn.microsoft.com/en-us/azure/container-apps/front-door-custom-virtual-network-private-link).

With ZDR, app downtime may lose incoming text permanently. HA ingress, prompt durable ACK and
visible gap reporting are necessary; backup/restore of our database cannot recover text never received.
