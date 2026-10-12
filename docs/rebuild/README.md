# VisualSprint v3 microservices rebuild

Approved direction: 2026-10-11. Implementation has started in an isolated checkout.
This package supersedes the modular-monolith target in docs/18–24 for v3 only.
Legacy applications and existing production data are preserved.

## Specification

- [Architecture and ownership](architecture.md): boundaries, data, events, deployment and scaling.
- [Product and API contracts](contracts.md): tenant scope, capture, projects, chat and actions.
- [Competitor evidence](competitors.md): documented capabilities versus inference.
- [Delivery and acceptance](delivery.md): dependency order and test gates.
- [Azure setup and costs](operations.md): environments, provider setup, CI and cutover.
- [Actual implementation status](status.md): verified work and outstanding release gates.
- [Local development](local-development.md): service runtime configuration and PostgreSQL tests.
- [Capture implementation](capture-implementation.md): durable flow, configuration and open gates.
- [Event delivery implementation](messaging-implementation.md): owning outboxes and Azure transport.
- [Calendar automation principals](automation-principals.md): consent and session-independent authority.
- [Calendar connections](calendar-connections.md): encrypted OAuth, selection, disconnect and setup.
- [Durable calendar snapshots](calendar-sync.md): resumable pages, complete publication and remaining orchestration.

## Approved scope

Fresh TypeScript web/services architecture, Azure, one regional cell, Recall managed capture,
English and text-only storage. Google Meet, Zoom and Teams; scheduled and pasted-link capture.
Five concurrent calls and 100 meeting hours/month are qualification inputs, not proven capacity.
Every project/customer assignment requires owner confirmation; assignment never grants access.
No desktop, extension, retained media or screenshots at launch.

Product loop: prepare → capture → review evidence → confirm commitments → approve actions →
execute → reconcile → prepare the next meeting.

## Working locally

Node >=22.19 (CI uses 24), pnpm 11.1.3. From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The root workspace covers only apps, packages and services. Legacy frontend/backend tooling
is independent. Current packages contain executable contracts and capture-domain/provider
foundations; they do not yet start the production service fleet. Follow status.md rather
than inferring readiness from a directory, passing unit tests or an API adapter.
