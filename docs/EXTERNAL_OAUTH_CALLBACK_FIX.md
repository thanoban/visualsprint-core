# Fix vendor OAuth redirect URLs — one-time console updates

Our server already sends the correct production callback URL for every provider
(`VS_OAUTH_REDIRECT_BASE_URL=https://visualsprint-api-5ieahiycsa-uw.a.run.app`, confirmed
live in production). The remaining risk is entirely on each vendor's own dashboard: these
apps were originally registered against `http://localhost:8000/...` before production
existed, and that stale value needs replacing.

Until each is updated, a real user clicking "Connect X" on the live site will get a
`redirect_uri_mismatch`-style error from that vendor, not from us.

## The exact value each vendor needs

| Provider | Exact redirect URL to set |
|---|---|
| Slack | `https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/oauth/slack/callback` |
| Zoom | `https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/oauth/zoom/callback` |
| Microsoft | `https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/oauth/microsoft/callback` |
| Jira | `https://visualsprint-api-5ieahiycsa-uw.a.run.app/api/v1/oauth/jira/callback` |

## Where to update each one

### Slack
1. Go to **api.slack.com/apps**
2. Select the VisualSprint app
3. **OAuth & Permissions** (left sidebar)
4. Under **Redirect URLs**, remove the old `localhost` entry (or add alongside it if you
   still want local dev to work) and add the URL above
5. Click **Save URLs**

### Zoom
1. Go to **marketplace.zoom.us** → **Develop** → **Build App** (or manage existing apps)
2. Select the VisualSprint General App (the OAuth app, not the Server-to-Server app used
   for RTMS — those are separate registrations)
3. Under **App Credentials** / **Redirect URL for OAuth**, replace the localhost value
4. Save

### Microsoft
1. Go to **entra.microsoft.com**
2. **App registrations** → select the VisualSprint app
3. **Authentication** (left sidebar)
4. Under **Redirect URIs**, edit or add the URL above (type: Web)
5. Save

### Jira (Atlassian)
1. Go to **developer.atlassian.com/console**
2. Select the VisualSprint app
3. **Authorization** (left sidebar) → OAuth 2.0 (3LO)
4. Update the **Callback URL** field
5. Save

## How to verify it worked

Once updated, on the live site (**https://visualsprint-web-5ieahiycsa-uw.a.run.app**):
1. Sign in
2. Go to **Settings → Connections**
3. Click **Connect** on the provider you just fixed
4. You should land on that vendor's real consent screen, not an error page

If you still see an error after updating, note the exact message — a mismatch error
means the console value doesn't exactly match the URL above (trailing slash, http vs
https, and typos all count), and an "app not verified"/"unauthorized" error is a
different, unrelated issue (e.g. Zoom's app review status) worth flagging separately.

## Not on this list

**GitHub and Linear** have no app registered yet at all — no account has been created for
either, so there's no callback URL to fix until that happens.
**Groq** (English ASR fallback) is unrelated to OAuth and also has no account yet.
