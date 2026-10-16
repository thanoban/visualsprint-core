# Private Azure Web PubSub invalidation transport

This optional source-wired transport is off by default. Controlled REST and API tests are not live
Azure delivery qualification. It provisions no resource, sends nothing at startup and uses no access
key, SAS, connection string, browser credential or Azure CLI fallback.

## Activation

Configure the Notification API and its separate `events.mjs` process with:

```dotenv
NOTIFICATION_REALTIME_ENABLED=true
AZURE_WEB_PUBSUB_ENDPOINT=https://your-resource.webpubsub.azure.com
AZURE_CLIENT_ID=<that-runtime-managed-identity-client-id>
```

The endpoint must be a bare HTTPS public-cloud `*.webpubsub.azure.com` resource origin. Sovereign
clouds/custom endpoints need a separately qualified allowlist and audience; they are rejected now.
The hub is fixed to `visualsprint_notifications`. No browser or client input can change it.
Enable the API and event process together, with the gateway's `realtime/negotiate` route enabled.

Each runtime uses its own managed identity. Grant only the resource-scoped data actions required for
the runtime: generate-client-token to the API, send-to-user to the event process. The built-in Web
PubSub Service Owner role includes these capabilities but is broader; a qualified custom role is
preferred. Do not grant subscription ownership, access-key listing or a namespace-wide role. Endpoint
configuration does not establish network reachability: a browser must be able to reach its public
WebSocket endpoint while private service REST access follows the selected Azure network policy.

Official contracts:

- [Generate Client Token, API 2024-01-01](https://learn.microsoft.com/en-us/rest/api/webpubsub/dataplane/webpubsub/web-pub-sub/generate-client-token?view=rest-webpubsub-dataplane-webpubsub-2024-01-01)
- [Send To User, API 2024-01-01](https://learn.microsoft.com/en-us/rest/api/webpubsub/dataplane/webpubsub/web-pub-sub/send-to-user?view=rest-webpubsub-dataplane-webpubsub-2024-01-01)
- [Entra token-generation permission requirements](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/howto-generate-client-access-url)

## Security and delivery

`POST /api/v3/workspaces/{workspaceId}/realtime/negotiate` requires gateway delegation and current
Account membership for a normal user session; operation grants are forbidden. Body/query values
are rejected. The service checks session authority before and after native token generation, returns
`Cache-Control: no-store`, and constructs the `wss` URL itself using the configured host/hub. It never
forwards an access URL from the provider response. Do not log/store/cache this bearer URL.

The scoped recipient ID is SHA-256 of a canonical tuple `[workspaceId,userId]`. A user switching
workspaces cannot reuse one workspace's recipient stream as another. No client publish/join roles or
initial groups are requested. Tokens expire after two minutes for new connections. Token expiration
does **not** guarantee an already-open socket is closed; clients must close on logout/workspace switch.
Configure no hub event handler that accepts client messages as business commands.

The only pushed content is exactly:

```json
{ "type": "notifications.invalidate.v1" }
```

There are no meeting, delivery, workspace, actor or project IDs; no title, state, transcript, task
payload, provider link, passcode or source content. A remaining socket after revocation can receive
only this generic hint, never a meeting event. Every useful fetch still goes through current session,
membership, source ACL, OpenFGA and deletion checks. These hints establish no access rights.

After ordinary Service Bus publication, the existing owning outbox calls the recipient send endpoint
before acknowledging its row. Unknown/failed push results leave the row retryable. This may republish
the same immutable bus event and duplicate a hint, so consumers retain their inbox dedupe. The hint
has a 15-second provider message TTL; it is not durable data or an exactly-once UI update. The private
notifications endpoint is the source of truth. A missed hint/offline browser uses normal polling.

Native REST uses managed-identity scope `https://webpubsub.azure.com/.default`, a two-second identity
deadline and five-second request deadline, rejects redirects, bounds token response bytes and returns
safe error codes. Provider errors or credentials do not enter application logs.

## Qualification gates

Controlled tests cover endpoint substitution, recipient isolation, role/group omission, token URL
pinning, bounded/malformed replies, no automatic transport retry, explicit default-off configuration,
normal membership revocation during issuance, operation-grant/cross-workspace denial, request-body
substitution, cache headers, content-free delivery and durable publisher retry propagation.

Before enabling in staging, qualify managed identity/RBAC, network/browser reachability, reconnect and
expiry behavior, no client publish permission, logout/workspace teardown, resource rate limits and
duplicate/lost hints. Docker-free tests do not prove PostgreSQL/broker settlement or live WebSocket
delivery. Native Blob export storage remains a separate lifecycle feature; PostgreSQL text exports
are still the authorized artifact implementation.
