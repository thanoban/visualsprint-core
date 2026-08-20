const serif = "'Source Serif 4', serif";
const mono = "'IBM Plex Mono', monospace";
const sans = "'IBM Plex Sans', sans-serif";
const CONTACT_EMAIL = "thanobansk@gmail.com";

const TOPICS = [
  {
    title: "Capture issues",
    body: "A Zoom, Meet, or Teams meeting that didn't capture or only partially captured.",
  },
  {
    title: "Platform connections",
    body: "Trouble connecting an integration — calendar, task tracker, or comms platform.",
  },
  {
    title: "Data requests",
    body: "Export or erase your organisation's data. We follow through, no run-around.",
  },
  {
    title: "Anything else",
    body: "Feedback, partnership interest, or something that doesn't fit a category.",
  },
];

export default function SupportPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: sans,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* Slim header */}
      <header
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "14px clamp(20px,4vw,40px)",
        }}
      >
        <div
          style={{
            maxWidth: 900,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <a
            href="/welcome"
            style={{
              fontFamily: mono,
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            <span style={{ color: "var(--accent-strong)" }}>[</span>
            VisualSprint
            <span style={{ color: "var(--accent-strong)" }}>]</span>
          </a>
          <span style={{ color: "var(--border-strong)", fontSize: 18, lineHeight: 1 }}>›</span>
          <span style={{ fontFamily: mono, fontSize: 13, color: "var(--text-muted)" }}>
            Support
          </span>
        </div>
      </header>

      <main
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "clamp(40px,6vw,72px) clamp(20px,4vw,40px) clamp(56px,8vw,96px)",
        }}
      >
        {/* Eyebrow + headline */}
        <p
          style={{
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--accent)",
            margin: "0 0 14px",
          }}
        >
          Support
        </p>
        <h1
          style={{
            fontFamily: serif,
            fontSize: "clamp(28px,3.8vw,42px)",
            lineHeight: 1.1,
            fontWeight: 600,
            letterSpacing: "-.022em",
            margin: "0 0 18px",
            color: "var(--text)",
          }}
        >
          A direct line, not a ticket queue.
        </h1>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.7,
            color: "var(--text-muted)",
            margin: "0 0 44px",
            maxWidth: 560,
          }}
        >
          VisualSprint is operated by its founder. Email directly and you&apos;ll get a real reply
          — not an autoresponder.
        </p>

        {/* Contact card */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "24px 28px",
            marginBottom: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
          }}
        >
          <div>
            <p
              style={{
                fontFamily: mono,
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "var(--text-faint)",
                margin: "0 0 8px",
              }}
            >
              Founder — direct inbox
            </p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              style={{
                fontFamily: mono,
                fontSize: 16,
                fontWeight: 600,
                color: "var(--accent-strong)",
                textDecoration: "none",
              }}
            >
              {CONTACT_EMAIL}
            </a>
          </div>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--surface)",
              background: "var(--accent)",
              borderRadius: 8,
              padding: "12px 22px",
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Open email app →
          </a>
        </div>

        {/* Topics */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 36,
            marginBottom: 44,
          }}
        >
          <p
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              margin: "0 0 24px",
            }}
          >
            What to write about
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {TOPICS.map((item) => (
              <div key={item.title} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    marginTop: 8,
                    flexShrink: 0,
                    display: "block",
                  }}
                />
                <div>
                  <p
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: "var(--text)",
                      margin: "0 0 4px",
                    }}
                  >
                    {item.title}
                  </p>
                  <p
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.65,
                      color: "var(--text-muted)",
                      margin: 0,
                    }}
                  >
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Legal */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 28 }}>
          <p
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              margin: "0 0 14px",
            }}
          >
            Legal
          </p>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-muted)", margin: 0 }}>
            See also the{" "}
            <a href="/privacy" style={{ color: "var(--accent-strong)", fontWeight: 600 }}>
              Privacy Policy
            </a>{" "}
            and{" "}
            <a href="/terms" style={{ color: "var(--accent-strong)", fontWeight: 600 }}>
              Terms of Service
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
