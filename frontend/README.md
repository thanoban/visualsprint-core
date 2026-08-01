# VisualSprint frontend

Next.js 14 (App Router) + TypeScript + Tailwind CSS scaffold for the VisualSprint MVP.

## Setup

```bash
cd frontend
npm install
npm run dev
```

Opens on http://localhost:3000. The backend is expected on **http://localhost:8000**
(override with `NEXT_PUBLIC_API_BASE_URL` in a `.env.local` file if needed).

## Pages

- `/` — landing page with links to Upload and Chat.
- `/upload` — real upload form. Submits to `POST /api/v1/meetings/upload` (multipart:
  `file`, optional `title`, optional `org_id`), then polls
  `GET /api/v1/meetings/sessions/{id}` every 2s and renders pipeline progress through
  the capture-session FSM states (`scheduled → acquiring → acquired → transcribing →
  understanding → verifying → remembering → proposing → reporting → done`, or `failed`).
- `/meetings/[id]/report` — meeting report view (Decisions/Commitments/Requirements/
  Blockers/Questions), confidence badges, inline screenshot thumbnails for screen
  evidence, and a coverage-gap banner. **Backed by mock data** — the real report
  endpoint doesn't exist yet on the backend.
- `/chat` — org-memory chat stub. Posts to `POST /api/v1/chat` (not yet implemented on
  the backend); on fetch failure it shows a "not connected yet" banner and falls back
  to a demo response so the UI is still exercisable.

## Mock data boundary

`lib/mock-data.ts` is the **only** file containing fixture data, clearly marked with
`TODO: replace with real API once ... endpoint exists`. All backend-facing types live
in `lib/types.ts`, including the *expected future* shapes for the report and chat
endpoints (derived from `docs/01-vision-and-competitive.md` and
`docs/05-data-model.md`). When those endpoints ship:

1. Delete the two `mock*` functions in `lib/mock-data.ts`.
2. In `app/meetings/[id]/report/page.tsx`, replace the `getMockMeetingReport(params.id)`
   call with `fetch(\`${API_BASE_URL}/api/v1/meetings/${params.id}/report\`)`.
3. In `app/chat/page.tsx`, the real `fetch(\`${API_BASE_URL}/api/v1/chat\`)` call is
   already wired up — the mock is only a catch-block fallback, so nothing else changes
   there once the endpoint responds successfully.

## Build

```bash
npm run build
```
