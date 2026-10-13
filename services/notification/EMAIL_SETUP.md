# Verified-email delivery setup and qualification — 2026-10-13

The selected Azure-path implementation uses Azure Communication Services Email with managed identity.
This document distinguishes implemented adapters from configuration, paid provisioning and live proof.
No cloud resource, sender-domain mutation, profile API lookup or external email send was performed.

## Account: authoritative recipient

`WorkOSProfiles` reads the official server endpoint using a server API key. It accepts `email` only
when the response has `email_verified:true`, and the returned user ID exactly matches the subject
already derived from a verified AuthKit JWT and persisted by Account. Client claims, calendar addresses
and submitted notification destinations never establish recipient identity.
[WorkOS user API](https://workos.com/docs/reference/authkit/user).

`VerifiedProfileService`/`PostgresProfiles` record sequenced projections in Account. The provider request
runs outside database transactions; current membership/workspace status is checked again before save.
Out-of-order requests and conflicting provider revisions are fenced. Unverified/deleted users clear
the destination; malformed responses or outages never fall back to a previous cached email.

Account migration `migrations/0004_verified_profiles.sql` is active in the owning service and locally
qualified. Optional `NotificationProfiles` is wired into the notification-membership capability;
Account rechecks current membership after the provider call. Configure its factory with
`WORKOS_PROFILE_API_KEY` from Key Vault. An absent key preserves the safe null gate. Public OAuth
callback URLs and client-supplied destination restrictions remain unchanged.

## Azure Email: adapter contract

`AzureCommunicationEmail` pins an HTTPS Azure communication resource, API version `2025-09-01`,
the configured verified sender and first-party web origin. It emits only the fixed generic plain-text
template, no HTML/attachments, no engagement tracking and one verified recipient per request.

Each send supplies the persisted delivery UUID as `Operation-Id`. The REST response is a queued
operation, not proof of mailbox delivery. Status is read at the known operation path; running,
malformed, timed-out or missing operations remain pending/unknown. A 404 is not authoritative
no-send evidence, and the adapter never automatically repeats the POST.
[Azure send API](https://learn.microsoft.com/en-us/rest/api/communication/email/email/send?view=rest-communication-email-2025-09-01),
[status lookup API](https://learn.microsoft.com/en-us/rest/api/communication/email/email/get-send-result?view=rest-communication-email-2025-09-01).

Operation success means provider send/handoff success, not inbox arrival, recipient reading or a
guaranteed absence of bounce. Delivery/bounce telemetry requires a separately qualified Event Grid
or Azure Monitor path. Notification migration `0002` normalizes legacy email status and uses
`provider_sent` for confirmed send operations; `delivered` is now in-app only. Do not expose send
confirmation as a verified mailbox-delivery claim.

The official Azure SDK supports token credentials for Email; its communication auth policy requests
`https://communication.azure.com//.default` (the double slash is intentional). The factory uses managed
identity in production, with Azure CLI credentials only after explicit local opt-in. The adapter's
optional `prepare()` allows token acquisition before persisting send intent, followed by fresh
preference/source checks. Token and HTTP operations have bounded deadlines.
[Microsoft authentication guidance](https://learn.microsoft.com/en-us/azure/communication-services/concepts/authentication),
[official token policy](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/communication/communication-common/src/credential/communicationAuthPolicy.ts).

## Administrator steps — no resources are created automatically

1. Obtain cost approval and select the production subscription/region before provisioning.
2. Create or reuse an Email Communication Services resource and an Azure Communication Services
   resource. Verify a sender domain and connect that domain to the communication resource.
   [Domain connection guide](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/email/connect-email-communication-resource).
3. Use its actual approved MailFrom sender, not a client-supplied or arbitrary mailbox. Configure
   custom-domain DNS verification/authentication as required by the provider.
4. Assign Notification's managed identity a reviewed, resource-scoped role with the tested email
   permissions. Microsoft documents a managed-identity example using a scoped supported role or
   custom CommunicationServices read/write permissions; this is not a reason to grant subscription
   Owner. Qualify the actual deployment role before release.
   [Managed-identity sample](https://learn.microsoft.com/en-us/samples/azure-samples/communication-services-dotnet-quickstarts/email-sample-send-email-with-managed-identity/).
5. Configure the wired `configuredEmail` factory with `AZURE_EMAIL_ENDPOINT`, `AZURE_EMAIL_SENDER`,
   `WEB_APP_ORIGIN` and optional `AZURE_CLIENT_ID`. Both endpoint/sender must be set together.
   Missing both settings keeps delivery disabled; an incomplete pair fails startup. Do not add Azure
   connection strings or SMTP secrets to the browser/repository.
6. Configure Account's server WorkOS profile key separately; apply its owned migration and verify
   the recipient is actually verified. Normal logout must not revoke consented delivery, while
   current membership/source barriers still prevent new sends.
7. Have the recipient opt into generic email in VisualSprint. Enable in-app separately. Capture
   transition updates remain in-app only; the UTC-hour setting schedules individual emails, not
   an aggregated digest.
8. Run a gated staging send only with approval and a verified test recipient. Verify one operation
   for repeated events, unknown-response lookup without another POST, current-access revocation,
   preference changes, domain/RBAC failure, bounce handling and deletion/restore barriers.

## Cost comparison and choice

| Option                    | Published cost/constraint                                                       | Architectural tradeoff                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Azure Communication Email | Microsoft's illustrative example uses $0.00025/email plus $0.00012/MB           | Fits Azure managed identity and known operation-ID status lookup; requires approved Azure resources/domain/RBAC |
| Resend                    | Current public Free tier: 3,000 emails/month, 100/day; Pro $20/month for 50,000 | Low-cost startup option, but another API secret/provider and its published idempotency window is only 24 hours  |

The Azure figures are **illustrative**, not a region/contract quote. At those example rates,
3,000 small 2KB emails would be approximately $0.75 plus less than $0.001 data, excluding domain,
other Azure resources, monitoring, taxes and existing infrastructure. Confirm the actual retail
meters/agreement before enabling. There is no claim that student credits cover these resources.
[Microsoft email pricing example](https://learn.microsoft.com/en-us/azure/communication-services/concepts/email-pricing),
[Azure pricing](https://azure.microsoft.com/en-us/pricing/details/communication-services/),
[Resend pricing](https://resend.com/pricing),
[Resend idempotency documentation](https://resend.com/changelog/idempotency-keys).

Azure is the chosen implementation path because it matches the approved managed-identity deployment.
Resend remains a possible later adapter, not an automatic fallback. No provider switch may silently
change destination, retention/disclosure or uncertainty guarantees.

## Current evidence and remaining gates

Controlled transport tests cover server-subject binding, verified-only email, mismatch/unverified/
404/outage/oversize cases; managed-identity scope, generic templates, stable operation IDs, status
matching, unsafe origins/operation locations and no automatic send retries. They perform no live calls.
Account projection migration/runtime wiring and focused local integration tests are implemented.
The send-intent transaction serializes against opt-out and schedule changes; source/member/verified
destination are rechecked after credential preflight. Exact deployment RBAC/domain, signed service
composition and actual WorkOS/Azure Email/Event Grid qualification remain separate release gates.
