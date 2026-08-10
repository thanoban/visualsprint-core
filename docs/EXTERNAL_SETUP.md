# External setup — accounts, apps, and env vars

Everything VisualSprint's code needs from the outside world, with exact
steps. This is a one-time setup done by the platform operator (not
something end customers ever do — see "Who does this" at the bottom).

All variables go in `backend/.env` (copy from `backend/.env.example`),
prefixed `VS_`. Nothing here is hardcoded anywhere in the codebase —
every value is read from environment via `backend/app/config.py`.

Status before any of this is filled in: the full pipeline (orchestrator,
all five agents, all ASR vendors, all seven connectors, Mode A1 Zoom
RTMS capture) is built and passes 429 tests against fakes. Filling in
the values below is what turns that into a live system — no further
code work is required for any of it to run end to end.

---

## 1. Core infrastructure (already done, no external account)

- **Postgres**: runs via `infra/docker-compose.yml`. Default connection
  string already matches it:
  ```
  VS_DATABASE_URL=postgresql+psycopg://visualsprint:visualsprint_dev@localhost:5433/visualsprint
  ```
  Change only if running Postgres yourself instead of via docker compose.
- **Blob storage**: defaults to local disk (`VS_BLOB_BACKEND=local`,
  `VS_BLOB_LOCAL_DIR=.blobstore`). Fine for dev and early pilot. See
  §5 for the production S3/R2 alternative.

No action needed to run the system locally beyond `docker compose up`
in `infra/`.

---

## 2. OAuth connectors (7 vendors, 8 apps)

Each of these is **one app registration**, made once, under the
operator's own developer/organization account. After that, every
customer org authorizes it individually through the vendor's own
consent screen (from the product's `Settings → Connections` page) — no
customer ever sees a client ID/secret or registers anything themselves.

The callback URL registered with each vendor must match:
```
VS_OAUTH_REDIRECT_BASE_URL=http://localhost:8000   # dev
# VS_OAUTH_REDIRECT_BASE_URL=https://api.yourdomain.com   # prod
```
The exact callback path per vendor is fixed in `backend/app/api/oauth.py`
(`/api/v1/orgs/{org_id}/oauth/{provider}/callback`).

Also required before any real (non-test) traffic:
```bash
# generate once, keep secret
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
```
VS_OAUTH_STATE_SECRET=<generated value>
```

### 2.1 Google — Calendar, Meet recordings, Gmail drafts

1. Go to **Google Cloud Console → APIs & Services → Credentials**.
2. Create an **OAuth client ID** of type "Web application".
3. Add authorized redirect URI:
   `{VS_OAUTH_REDIRECT_BASE_URL}/api/v1/orgs/{org_id}/oauth/google/callback`
   (use a wildcard-safe pattern or your prod domain; the `{org_id}` segment
   is dynamic per org).
4. Enable the APIs this app needs: Google Calendar API, Google Meet API,
   Gmail API.
5. Set:
   ```
   VS_GOOGLE_OAUTH_CLIENT_ID=
   VS_GOOGLE_OAUTH_CLIENT_SECRET=
   ```

### 2.2 Microsoft — Calendar watch, Teams recordings

1. Go to **Microsoft Entra admin center → App registrations → New
   registration**.
2. Supported account type: **"Accounts in this organizational directory
   only"** (single tenant) — this product has no use for personal
   Microsoft accounts.
3. Add the redirect URI (same pattern as above, provider `microsoft`).
4. Under **API permissions**, add Microsoft Graph delegated permissions
   for Calendars.Read and OnlineMeetings/CallRecords (Teams recordings).
5. Under **Certificates & secrets**, create a client secret.
6. Set:
   ```
   VS_MICROSOFT_OAUTH_CLIENT_ID=
   VS_MICROSOFT_OAUTH_CLIENT_SECRET=
   ```

### 2.3 Slack — post decision recaps to a channel

1. Go to **api.slack.com/apps → Create New App → From scratch**.
2. Under **OAuth & Permissions**, add the redirect URL (provider `slack`).
3. Add bot token scopes needed to post to a channel (e.g.
   `chat:write`, `channels:read`).
4. Install the app to a workspace to generate credentials, then take the
   **Client ID / Client Secret** from **Basic Information**.
5. Set:
   ```
   VS_SLACK_OAUTH_CLIENT_ID=
   VS_SLACK_OAUTH_CLIENT_SECRET=
   ```

### 2.4 Jira — create tasks from verified commitments

Uses Atlassian's OAuth 2.0 (3LO). The site's cloud ID is resolved
automatically at connect time — no manual step for that.

1. Go to **developer.atlassian.com/console → Create → OAuth 2.0
   integration**.
2. Add the redirect URL (provider `jira`).
3. Under **Permissions**, add the Jira API scopes needed to create issues
   (e.g. `write:jira-work`, `read:jira-user`).
4. Set:
   ```
   VS_JIRA_OAUTH_CLIENT_ID=
   VS_JIRA_OAUTH_CLIENT_SECRET=
   ```

### 2.5 GitHub — open issues from verified commitments

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New
   OAuth App**.
2. Set the authorization callback URL (provider `github`).
3. Set:
   ```
   VS_GITHUB_OAUTH_CLIENT_ID=
   VS_GITHUB_OAUTH_CLIENT_SECRET=
   ```

### 2.6 Linear — create issues from verified commitments

1. Go to **Linear → Settings → API → OAuth applications → Create new**.
2. Set the redirect URL (provider `linear`).
3. Set:
   ```
   VS_LINEAR_OAUTH_CLIENT_ID=
   VS_LINEAR_OAUTH_CLIENT_SECRET=
   ```

### 2.7 Zoom — two separate apps

**General App (OAuth)** — lets a customer authorize VisualSprint against
their own Zoom account (Cloud Recording fetch, Mode A2):

1. Go to **Zoom App Marketplace → Develop → Build App → General App**.
2. Add the redirect URL (provider `zoom`).
3. Add scopes for reading cloud recordings.
4. Set:
   ```
   VS_ZOOM_OAUTH_CLIENT_ID=
   VS_ZOOM_OAUTH_CLIENT_SECRET=
   ```

**Server-to-Server OAuth app** — authenticates the real-time media
handshake for live-meeting capture (Mode A1 / RTMS). Single-account
only, by design: it identifies your own app to Zoom's infrastructure,
not a customer, so it cannot be the multi-tenant capture path.

1. Go to **Zoom App Marketplace → Develop → Build App →
   Server-to-Server OAuth**.
2. Under **Feature → Event Subscriptions** on the same app, subscribe to
   the RTMS webhook events and copy the **Webhook Secret Token**.
3. Set:
   ```
   VS_ZOOM_CLIENT_ID=
   VS_ZOOM_CLIENT_SECRET=
   VS_ZOOM_WEBHOOK_SECRET_TOKEN=
   ```

---

## 3. Transcription & voice-ID vendors

Google and Azure are a locked primary/fallback pair for Sinhala and
Tamil — the ASR cascade (`backend/app/asr/cascade.py`) retries on Azure
automatically whenever Google errors, times out, or returns a
low-confidence/empty result. Groq handles English spans separately
(Whisper-family models freeze their detected language after ~30s and
can't code-switch mid-segment, which is exactly the gap Google/Azure
routing exists to cover).

### 3.1 Google Speech-to-Text (chirp_2) — Sinhala/Tamil primary

1. In the same GCP project as §2.1/§4 (one set of cloud credentials
   covers Google OAuth, Speech-to-Text, and Vertex AI).
2. Enable the **Cloud Speech-to-Text API**.
3. Create a service account with Speech-to-Text access, generate a JSON
   key, and save it locally.
4. Set:
   ```
   VS_GOOGLE_CREDENTIALS_JSON=/path/to/service-account.json
   ```

### 3.2 Azure Speech — Sinhala/Tamil fallback

1. In the **Azure Portal**, create a **Speech** resource.
2. Copy its key and region.
3. Set:
   ```
   VS_AZURE_SPEECH_KEY=
   VS_AZURE_SPEECH_REGION=
   ```

### 3.3 Groq — English transcription (whisper-large-v3-turbo)

1. Go to the **Groq console** and create an API key.
2. Set:
   ```
   VS_GROQ_API_KEY=
   ```

### 3.4 HuggingFace — speaker diarization (optional)

Gates the pyannote diarization pipeline (who-said-what). Without it,
speaker separation is skipped honestly rather than guessed — not a
blocker for the rest of the pipeline.

1. Create a HuggingFace account, accept the pyannote model's terms of
   use on its model card.
2. Generate a **read** token under account settings.
3. Set:
   ```
   VS_HUGGINGFACE_TOKEN=
   ```

---

## 4. Agent runtime — Claude via Vertex AI

All five agents (extract, verify, memory, propose, report) run on
Claude through Vertex AI, not the direct Anthropic API — so
authentication is a GCP project, not an API key. There is no API-key
setting for this by design (`AnthropicVertex` doesn't take one).

1. Use the **same GCP project** as §3.1 (Google Speech) — one set of
   cloud credentials covers both.
2. Enable Vertex AI and request access to the Claude models you need in
   that project/region.
3. Authenticate:
   - Dev: `gcloud auth application-default login`
   - Prod: a service account attached to the deploy environment.
4. Set:
   ```
   VS_VERTEX_PROJECT_ID=your-gcp-project-id
   VS_VERTEX_REGION=us-east5
   ```
   Per-agent model tiers already have sensible defaults in
   `backend/app/config.py` — only override individual
   `VS_MODEL_*` vars if you want to change one.

---

## 5. End-user authentication (Supabase)

Every other section above is platform-operator setup — this one is what
lets actual people (individuals and teams both) sign up and log in.
Backend verifies tokens only; it never calls the Supabase Admin API, so
no service-role key is needed.

1. Create a project at **supabase.com** (free tier is enough to start).
2. **Project Settings → API**: copy the **Project URL** and the **anon
   public key**.
3. **Authentication → Sign In / Providers**: Email is on by default;
   enable **Google** too — it needs its own OAuth client ID/secret from
   Google Cloud Console (a *new, separate* client from the §2.1 Calendar/
   Meet/Gmail connector one — different purpose, different redirect URI,
   which Supabase's provider page shows you).
4. Set:
   ```
   VS_SUPABASE_URL=https://<project-ref>.supabase.co
   ```
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
   ```
   (the last two go in `frontend/.env.local`, copied from
   `frontend/.env.example` — the anon key is meant to be public, not a
   secret, same as any other `NEXT_PUBLIC_` value.)

Until this is set, the frontend degrades honestly: every page redirects
to `/login`, which shows "Sign-in isn't set up yet" instead of a broken
form or a crash.

---

## 6. Optional production hardening

Everything above is enough to run the full pipeline end to end in dev.
These only matter once real customer traffic is involved.

### 6.1 S3-compatible blob storage (Cloudflare R2 or similar)

Swaps local-disk audio/screenshot storage for a real object store.

```
VS_BLOB_BACKEND=s3
VS_S3_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
VS_S3_BUCKET=visualsprint
VS_S3_ACCESS_KEY_ID=
VS_S3_SECRET_ACCESS_KEY=
```

### 6.2 GCP Secret Manager (OAuth token storage)

Swaps the local plaintext-on-disk OAuth token store
(`VS_SECRETSTORE_BACKEND=local`) for real Secret Manager, in the same
GCP project as Vertex AI.

```
VS_SECRETSTORE_BACKEND=gcp
```

### 6.3 CORS allowed origins (prod frontend domain)

```
VS_CORS_ALLOWED_ORIGINS=["https://app.yourdomain.com"]
```

---

## Who does this

- **§2 (connectors)**: the platform operator registers each app once.
  Customers never see a client ID/secret — they click "Connect" in
  `Settings → Connections` and go through the vendor's own consent
  screen (same UX as "Sign in with Google").
- **§3 and §4 (ASR + agent runtime)**: platform-level paid
  infrastructure. Customers never interact with these at all.
- **§5 (Supabase)**: operator sets up the project once; after that,
  every individual and team signs up and logs in through it directly —
  this is the one section above that's genuinely customer-facing, not
  operator-only.
- **§6**: operator-only, deployment configuration.

## After filling these in

1. Restart the backend API and worker process.
2. Go to `/settings/connections` for an org and connect the vendors you
   configured.
3. Run a real meeting through the relevant capture mode (upload, Mode
   A2 artifact fetch, or Mode A1 Zoom RTMS) and confirm it reaches
   `report` stage end to end.
