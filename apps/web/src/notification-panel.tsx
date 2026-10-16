import { useEffect, useState } from "react";
import { z } from "zod";
import { Api } from "./api.js";
import { Feedback, Form, useCommand, useData } from "./ui.js";
import { NotificationLive } from "./notification-live.js";
const preferences = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  inApp: z.boolean(),
  email: z.boolean(),
  deliveryHourUtc: z.number().int().min(0).max(23).nullable(),
});
const notification = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  kind: z.enum(["summary_ready", "action_completed", "capture_updated"]),
  channel: z.enum(["in_app", "email"]),
  state: z.string(),
  version: z.number().int().positive(),
  availableAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
});
const page = z.object({ items: z.array(notification), nextCursor: z.string().uuid().nullable() });
export function NotificationPanel({ api, workspaceId }: { api: Api; workspaceId: string }) {
  const path = api.scope(workspaceId);
  const [revision, setRevision] = useState(0);
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const [after, setAfter] = useState<string>();
  const settings = useData(
    (signal) => api.request(`${path}/notification-preferences`, preferences, { signal }),
    [api, workspaceId, preferencesRevision],
  );
  const items = useData(
    (signal) =>
      api.request(`${path}/notifications${after ? `?after=${after}` : ""}`, page, { signal }),
    [api, workspaceId, revision, after],
  );
  const changed = () => setRevision((value) => value + 1);
  const refreshAll = () => {
    changed();
    setPreferencesRevision((value) => value + 1);
  };
  useEffect(() => {
    // A hint is optional, never the source of permission or notification content.
    if (items.loading || items.error) return;
    const timer = setTimeout(changed, 30000);
    return () => clearTimeout(timer);
  }, [items.loading, items.error, workspaceId, revision, after]);
  return (
    <section className="panel" aria-label="Workspace notifications">
      <h2>Updates and notification preferences</h2>
      <p>
        Updates are private to your current meeting access. Email never contains meeting titles,
        customer names, transcripts or task text.
      </p>
      <Feedback data={settings} />
      {settings.value ? (
        <Settings
          key={`${workspaceId}:${settings.value.version}`}
          api={api}
          path={path}
          initial={settings.value}
          changed={refreshAll}
        />
      ) : null}
      <p>
        Email delivery is held until an administrator configures an approved email provider and
        Account supplies your verified email. Saving a preference does not prove email delivery.
      </p>
      <button type="button" onClick={refreshAll}>
        Refresh updates
      </button>
      <NotificationLive
        key={workspaceId}
        api={api}
        workspaceId={workspaceId}
        changed={changed}
        available={!items.error && !settings.error}
      />
      <Feedback data={items} />
      {items.value?.items.length === 0 ? (
        <p>No currently authorized updates in this page.</p>
      ) : null}
      {items.value?.items.map((item) => (
        <Update
          key={`${workspaceId}:${item.id}:${item.version}`}
          api={api}
          path={path}
          workspaceId={workspaceId}
          item={item}
          changed={changed}
        />
      ))}
      {after ? (
        <button type="button" onClick={() => setAfter(undefined)}>
          First updates page
        </button>
      ) : null}
      {items.value?.nextCursor ? (
        <button type="button" onClick={() => setAfter(items.value!.nextCursor!)}>
          Next updates page
        </button>
      ) : null}
    </section>
  );
}
function Settings({
  api,
  path,
  initial,
  changed,
}: {
  api: Api;
  path: string;
  initial: z.infer<typeof preferences>;
  changed: () => void;
}) {
  const [inApp, setInApp] = useState(initial.inApp),
    [email, setEmail] = useState(initial.email),
    [hour, setHour] = useState(
      initial.deliveryHourUtc === null ? "" : String(initial.deliveryHourUtc),
    ),
    [consent, setConsent] = useState(false);
  const command = useCommand();
  const body = {
    expectedVersion: initial.version,
    inApp,
    email,
    deliveryHourUtc: hour === "" ? null : Number(hour),
    emailConsent: consent,
  };
  return (
    <Form
      title="Choose your update channels"
      button="Save notification preferences"
      command={command}
      submit={() =>
        void command.run(
          body,
          (key) =>
            api.request(`${path}/notification-preferences`, preferences, {
              method: "POST",
              key,
              body,
            }),
          changed,
        )
      }
    >
      <label>
        <input
          type="checkbox"
          checked={inApp}
          onChange={(event) => setInApp(event.target.checked)}
        />
        Enable in-app updates
      </label>
      <label>
        <input
          type="checkbox"
          checked={email}
          onChange={(event) => setEmail(event.target.checked)}
        />
        Enable generic email updates
      </label>
      <label>
        Email delivery time (UTC)
        <select value={hour} onChange={(event) => setHour(event.target.value)}>
          <option value="">As soon as authorized</option>
          {Array.from({ length: 24 }, (_, value) => (
            <option key={value} value={value}>
              {String(value).padStart(2, "0")}:00 UTC
            </option>
          ))}
        </select>
      </label>
      {email ? (
        <label>
          <input
            type="checkbox"
            required
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I consent to generic updates sent only to my verified account email.
        </label>
      ) : null}
      <p>
        Scheduled emails are individual updates, not a combined digest. Capture-status changes are
        in-app only.
      </p>
    </Form>
  );
}
function Update({
  api,
  path,
  workspaceId,
  item,
  changed,
}: {
  api: Api;
  path: string;
  workspaceId: string;
  item: z.infer<typeof notification>;
  changed: () => void;
}) {
  const command = useCommand();
  const title =
    item.kind === "summary_ready"
      ? "A meeting summary is ready"
      : item.kind === "action_completed"
        ? "An approved action was confirmed"
        : "Meeting capture status changed";
  return (
    <article className="panel">
      <h3>{title}</h3>
      <p>
        {item.readAt ? "Read" : "Unread"}. Ready {new Date(item.availableAt).toLocaleString()}.
      </p>
      {item.state === "provider_sent" ? (
        <p>Email accepted by the provider; recipient delivery is not yet confirmed.</p>
      ) : null}
      <a href={`/w/${workspaceId}?meetingId=${item.meetingId}`}>Open authorized meeting</a>
      {item.readAt ? null : (
        <Form
          title="Mark this update read"
          button="Mark read"
          command={command}
          submit={() =>
            void command.run(
              { id: item.id, expectedVersion: item.version },
              (key) =>
                api.request(`${path}/notifications/${item.id}/read`, notification, {
                  method: "POST",
                  key,
                  body: { expectedVersion: item.version },
                }),
              changed,
            )
          }
        >
          <p>No external action is performed.</p>
        </Form>
      )}
    </article>
  );
}
