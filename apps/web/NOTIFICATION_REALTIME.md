# Optional private notification invalidation

Live delivery is off until the user selects **Enable live update hints**. The normal
notification list still loads through the authenticated API, polls every 30 seconds
after successful reads and supports manual refresh. Background list refreshes do not
reload the preferences form or discard unsaved channel choices. A hint never grants access or
becomes notification content.

The browser negotiates with bodyless `POST /api/v3/workspaces/{workspaceId}/realtime/negotiate`.
It accepts only a short-lived `{url, expiresAt}` response for
`wss://<resource>.webpubsub.azure.com/client/hubs/visualsprint_notifications` with exactly
one JWT-shaped `access_token`, no credentials/port/fragment and no client send/join/group
roles. The URL/token are never intentionally logged, persisted, rendered or copied
into application state. Client decoding is defense-in-depth, not JWT authentication;
the native backend pins the Azure resource and negotiates the recipient-bound token.
Azure documents the JWT claim names `role` and `webpubsub.group` in its
[client protocol reference](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/concept-client-protocols).
The guard rejects nonempty documented claims and alias forms `roles`, `groups` and
`wps.groups`, not merely the SDK option spelling.

Only the exact small JSON message `{ "type": "notifications.invalidate.v1" }` triggers
a debounced authorized refetch. Foreign message types, added content/IDs and binary or
oversized messages are ignored. Plain WebSocket is used without a send/group subprotocol.
The client never sends meeting content or joins a group.

Unexpected socket failures allow three retries at 1, 5 and 15 seconds, then stop until a
deliberate user retry. Negotiation failure (including default-off 503, denied access or
malformed links) stops immediately without login redirects or tight retries. Token expiry
closes the socket and renegotiates: token expiry alone does not revoke an open connection.
Workspace changes, logout initiation, pagehide, panel unmount or failed authorized reads
close the socket, clear timers and prevent pending negotiation/hint work from resurrecting it.

Deterministic tests use a controlled socket, not live Azure. They cover host/path/query/
roles/expiry guards, generic-only and duplicate hints, explicit opt-in, cleanup, disabled
fallback, bounded reconnect and read revocation. Live Web PubSub identity, send-to-user
delivery, production browser/network behavior and Azure deployment remain qualification gates.
