const sans = "'IBM Plex Sans', sans-serif";

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

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px", fontFamily: sans }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#14171d", margin: "0 0 6px" }}>Terms of Service</h1>
      <p style={{ fontSize: 13, color: "#6b6558", margin: "0 0 8px" }}>Last updated {LAST_UPDATED}</p>
      <p style={{ fontSize: 14, lineHeight: 1.7, color: "#3a3a3a" }}>
        These terms govern your use of VisualSprint, a meeting-intelligence service currently
        operated by its founder, Thanoban Kamalendran. By creating an account or connecting a
        meeting platform, you agree to these terms.
      </p>

      <Section title="What the service does">
        <p>
          VisualSprint captures meetings you or your organization host (via manual upload or a
          connected platform such as Google Meet, Microsoft Teams, or Zoom), transcribes them,
          and extracts decisions, commitments, and blockers with cited evidence — a transcript
          span, a speaker, and where available, a screen capture. Every claim the product
          surfaces is meant to be traceable back to that evidence; if a meeting has a capture
          gap, the product discloses it rather than silently guessing.
        </p>
      </Section>

      <Section title="Your responsibilities">
        <ul style={{ margin: "0 0 0 18px", padding: 0 }}>
          <li>You must have the right to record and process any meeting you connect or upload — this includes obtaining any consent required by your organization&apos;s policies or applicable law from other participants</li>
          <li>You&apos;re responsible for keeping your account and any connected third-party credentials secure</li>
          <li>You won&apos;t use the service to capture meetings you don&apos;t have authorization to record</li>
        </ul>
      </Section>

      <Section title="Third-party platforms">
        <p>
          Connecting Google, Microsoft, Zoom, Slack, Jira, GitHub, or Linear is optional and
          governed by that vendor&apos;s own terms in addition to these. VisualSprint accesses only
          the scopes you explicitly authorize during that connection, and you can revoke access
          at any time — see the Privacy Policy for details.
        </p>
      </Section>

      <Section title="Automated actions require your approval">
        <p>
          The product can propose actions derived from meeting content (e.g., a task in a
          connected tracker, a message to a channel). No proposed action is ever sent or
          executed automatically — every one requires your explicit approval first.
        </p>
      </Section>

      <Section title="Service availability">
        <p>
          VisualSprint is an early-stage product operated by a single founder. It&apos;s provided
          &ldquo;as is,&rdquo; without uptime guarantees, while it&apos;s actively being built. Features
          described in the product may be partially implemented — the Privacy Policy and
          in-product disclosures aim to be honest about what&apos;s actually working at any given
          time rather than overstating capability.
        </p>
      </Section>

      <Section title="Data ownership">
        <p>
          You retain ownership of your meeting content and everything derived from it. You can
          export or permanently delete it at any time from Settings → Data rights.
        </p>
      </Section>

      <Section title="Termination">
        <p>
          You can stop using the service and disconnect all integrations at any time. We may
          suspend accounts that violate these terms, in particular the recording-authorization
          requirement above.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          If these terms change materially, the &ldquo;Last updated&rdquo; date above will change and,
          where practical, connected organizations will be notified.
        </p>
      </Section>

      <Section title="Contact">
        <p>Questions about these terms: {CONTACT_EMAIL}</p>
      </Section>
    </div>
  );
}
