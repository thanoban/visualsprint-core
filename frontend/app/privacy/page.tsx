const sans = "'Plus Jakarta Sans', sans-serif";

const LAST_UPDATED = "2026-08-15";
const CONTACT_EMAIL = "thanobansk@gmail.com";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "#14171d", margin: "0 0 8px" }}>{title}</h2>
      <div style={{ fontSize: 14, lineHeight: 1.7, color: "#3a3a3a" }}>{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px", fontFamily: sans }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#14171d", margin: "0 0 6px" }}>Privacy Policy</h1>
      <p style={{ fontSize: 13, color: "#6b6558", margin: "0 0 8px" }}>Last updated {LAST_UPDATED}</p>
      <p style={{ fontSize: 14, lineHeight: 1.7, color: "#3a3a3a" }}>
        VisualSprint is a meeting-intelligence product that captures meetings you or your
        organization host, transcribes them (including Sinhala/Tamil/English code-switched
        speech), and extracts decisions, commitments, and blockers with cited evidence. This
        page describes what data we collect, why, and how you can control or delete it.
        VisualSprint is currently operated by its founder, Thanoban Kamalendran, not a
        registered company — treat this policy as binding regardless.
      </p>

      <Section title="What we collect">
        <ul style={{ margin: "0 0 0 18px", padding: 0 }}>
          <li>Meeting audio and, where the platform provides it, screen/keyframe captures</li>
          <li>Transcripts and speaker-attributed utterances derived from that audio</li>
          <li>Calendar metadata (event titles, times, attendees) from any calendar you connect</li>
          <li>Account information: name and email, from your sign-in provider</li>
          <li>OAuth tokens for any third-party service you explicitly connect (see below)</li>
        </ul>
      </Section>

      <Section title="Why we collect it">
        <p>
          Every piece of data above exists to answer one question honestly: what was said,
          decided, or committed to in your meetings, with cited evidence a person can check —
          never a claim without a traceable source. We do not use your meeting content for
          advertising, and we do not sell data to third parties.
        </p>
      </Section>

      <Section title="Where it goes — subprocessors">
        <p>We rely on the following third parties to operate the service. Each receives only what it needs to do its job:</p>
        <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
          <li><strong>Google Cloud (Speech-to-Text, Vertex AI/Gemini)</strong> — speech transcription and meeting-content analysis</li>
          <li><strong>Microsoft Azure Speech</strong> — fallback transcription for Sinhala/Tamil</li>
          <li><strong>Supabase</strong> — authentication and primary database hosting</li>
          <li>
            <strong>Meeting platforms you connect</strong> (Google Meet, Microsoft Teams, Zoom) —
            used only to retrieve recordings/transcripts/participant rosters for meetings you
            authorize, via each platform&apos;s official API
          </li>
          <li>
            <strong>Optional integrations you connect</strong> (Slack, Jira, GitHub, Linear) —
            used only if you explicitly connect them, to post recaps or create tracked work
            items you&apos;ve approved
          </li>
        </ul>
      </Section>

      <Section title="Data residency and retention">
        <p>
          Data is scoped per organization and never shared across organizations. You control how
          long raw evidence (audio, transcript text, keyframe images) is retained via
          Settings → Data rights — the default is to keep it indefinitely, but you can set an
          automatic purge window in days. Extracted knowledge (decisions, commitments, etc.)
          persists independently of raw-evidence retention so your organizational memory survives
          even after raw recordings are purged.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          From Settings → Data rights, you can export everything derived from any meeting as a
          JSON file, or permanently delete a meeting and everything derived from it. Deletion is
          irreversible. If you&apos;d rather we handle a request directly (including full account
          deletion), email {CONTACT_EMAIL}.
        </p>
      </Section>

      <Section title="Third-party OAuth connections">
        <p>
          When you connect Google, Microsoft, Zoom, Slack, Jira, GitHub, or Linear, we request
          only the specific scopes each integration needs (e.g., calendar read access, meeting
          recording access) — never broader account access than the feature requires. You can
          revoke any connection at any time from Settings → Connections, which deletes the stored
          token on our side immediately; you can also revoke access from the vendor&apos;s own
          connected-apps settings.
        </p>
      </Section>

      <Section title="Security">
        <p>
          OAuth tokens and other credentials are stored in Google Cloud Secret Manager, not in
          our application database. Access to production data is limited to the founder during
          this early stage of the product.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          If this policy changes materially, the &ldquo;Last updated&rdquo; date above will change and, where
          practical, connected organizations will be notified.
        </p>
      </Section>

      <Section title="Contact">
        <p>Questions about this policy or your data: {CONTACT_EMAIL}</p>
      </Section>
    </div>
  );
}
