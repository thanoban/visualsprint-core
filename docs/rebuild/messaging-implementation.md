# Azure event transport implementation

2026-10-12. Source implementation and local tests; live namespace qualification is outstanding.

`@visualsprint/messaging` owns technical encoding and Azure SDK transport only. It contains
no database schema, service business rules or shared persistence. Workspace and Ingest publish
their own transactional outboxes from independent compiled `events.mjs` processes.

- SDK pins: `@azure/service-bus` 7.10.0 and `@azure/identity` 4.13.3.
- Production authentication: managed identity, optional user-assigned client ID. Local Azure
  execution is explicit through Azure CLI credentials; no application SAS/admin connection string.
- One producer topic per owning service: `vs-workspace`, `vs-ingest`. Grant sender permission
  on that topic only; grant consumers receiver permission on their required subscriptions only.
- Message ID equals immutable domain event ID; subject equals versioned event type. Tenant,
  schema and trace metadata are validated against the reference-only envelope.
- Receive in peek-lock mode, bounded concurrency five, explicit settlement. A consumer handler
  must commit its owning inbox and effect transaction before returning. Validation failures
  dead-letter with a constant reason; transient handler failures abandon; acknowledgement failure
  propagates so redelivery is handled by the inbox. Broker duplicate detection does not replace it.
- Publisher rows are leased/fenced; publication is marked only after send acknowledgement.
  Unknown sends retry the same event identity. Duplicate delivery remains possible and expected.
- Only owning-service routing indexes are enumerated across tenants. They contain workspace IDs
  and scheduling time, not content or authorization. Business rows remain under forced RLS.
- Logs use constant operational error codes; neither broker payloads nor credentials are logged.

Environment checklist: `SERVICE_BUS_NAMESPACE=<name>.servicebus.windows.net`, optional
`AZURE_CLIENT_ID`, owning runtime database URL. Deploy migrations before `events` workers.
Workers do not create namespaces, topics, subscriptions or role assignments. Production topology
uses Service Bus Standard; configure duplicate detection and dead-letter monitoring in deployment.
Old populated outboxes require an authorized, workspace-scoped routing-index backfill.

Run `pnpm check`, `pnpm build`, `pnpm test:integration` and web browser tests. Local tests exercise
encoding/settlement with controlled transport and actual PostgreSQL outbox lease/retry behavior.
They do not connect to Azure. Open gates: live RBAC, send/receive/redelivery, topic filters,
dead-letter operations, observability, deployment resources, new service consumers and failure
qualification. This does not complete calendars, intelligence or follow-through features.

References: [Microsoft JavaScript SDK](https://learn.microsoft.com/en-us/javascript/api/overview/azure/service-bus-readme?view=azure-node-latest)
and [duplicate detection](https://learn.microsoft.com/en-us/azure/service-bus-messaging/duplicate-detection).
