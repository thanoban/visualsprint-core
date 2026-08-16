const sans = "'IBM Plex Sans', sans-serif";
const CONTACT_EMAIL = "thanobansk@gmail.com";

export default function SupportPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px 80px", fontFamily: sans }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#14171d", margin: "0 0 12px" }}>Support</h1>
      <p style={{ fontSize: 14, lineHeight: 1.7, color: "#3a3a3a" }}>
        VisualSprint is an early-stage product operated by its founder. For any question —
        connecting a meeting platform, a capture that didn&apos;t work as expected, data export
        or deletion requests, or anything else — email{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "#1f7a5c" }}>
          {CONTACT_EMAIL}
        </a>{" "}
        and you&apos;ll get a direct reply, not a ticket queue.
      </p>
      <p style={{ fontSize: 14, lineHeight: 1.7, color: "#3a3a3a", marginTop: 16 }}>
        See also the{" "}
        <a href="/privacy" style={{ color: "#1f7a5c" }}>
          Privacy Policy
        </a>{" "}
        and{" "}
        <a href="/terms" style={{ color: "#1f7a5c" }}>
          Terms of Service
        </a>
        .
      </p>
    </div>
  );
}
