import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Api, errorMessage } from "./api.js";
import { Feedback, Form, useCommand, useData } from "./ui.js";
import { saveCalendarFlow, calendarFlow, removeCalendarFlow } from "./calendar-oauth.js";
export const connection = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  provider: z.enum(["google", "microsoft"]),
  status: z.string(),
  calendarId: z.string(),
  calendarName: z.string(),
  version: z.number().int().positive(),
  automatic: z.boolean(),
  errorCode: z.string().nullable(),
  cleanupPending: z.boolean(),
});
const startResult = z.object({
  connection,
  authorizationUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const calendarPage = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), primary: z.boolean() })),
  nextCursor: z.string().nullable(),
});
const occurrencePage = z.object({
  window: z.object({ startsAt: z.string(), endsAt: z.string() }),
  items: z
    .array(
      z.object({
        sourceKey: z.string(),
        providerEventId: z.string(),
        title: z.string(),
        status: z.string(),
        startsAt: z.string().nullable(),
        endsAt: z.string().nullable(),
        allDay: z.boolean(),
        declined: z.boolean(),
        joinUrl: z.string().nullable(),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});
const syncResult = z.object({
  id: z.string().uuid(),
  state: z.string(),
  pageCount: z.number().int(),
  errorCode: z.string().nullable(),
  window: z.object({ startsAt: z.string(), endsAt: z.string() }),
});
export function CalendarPanel({ api, workspaceId }: { api: Api; workspaceId: string }) {
  const [refresh, setRefresh] = useState(0),
    [provider, setProvider] = useState<"google" | "microsoft">("google");
  const start = useCommand();
  const path = `${api.scope(workspaceId)}/connections/calendar`;
  const data = useData(
    async (signal) => ({
      capabilities: await api.request(
        `${path}/providers`,
        z.object({
          providers: z.array(z.enum(["google", "microsoft"])),
          automaticCaptureReady: z.boolean(),
        }),
        { signal },
      ),
      connections: await api.request(`${path}/`, z.array(connection), { signal }),
    }),
    [api, path, refresh],
  );
  return (
    <section className="panel" aria-label="Calendar connections">
      <h2>Calendar connections</h2>
      <p>Read-only access. Tokens stay encrypted on the server, not in browser storage.</p>
      <Feedback data={data} />
      {data.value ? (
        <>
          <Form
            title="Connect a calendar account"
            button="Connect calendar"
            command={start}
            submit={() =>
              void start.run(
                { provider },
                (key) =>
                  api.request(`${path}/oauth/start`, startResult, {
                    method: "POST",
                    key,
                    body: { provider },
                  }),
                (result) => {
                  if (!result.authorizationUrl) {
                    setRefresh((value) => value + 1);
                    return;
                  }
                  const url = saveCalendarFlow(
                    sessionStorage,
                    workspaceId,
                    result.connection.id,
                    result.authorizationUrl,
                  );
                  window.location.assign(url);
                },
              )
            }
          >
            <label>
              Calendar provider
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as "google" | "microsoft")}
              >
                {(["google", "microsoft"] as const).map((name) => (
                  <option
                    key={name}
                    value={name}
                    disabled={!data.value!.capabilities.providers.includes(name)}
                  >
                    {name === "google" ? "Google Calendar" : "Microsoft Outlook"}
                    {data.value!.capabilities.providers.includes(name) ? "" : " — not configured"}
                  </option>
                ))}
              </select>
            </label>
            {!data.value.capabilities.automaticCaptureReady ? (
              <p>
                Calendar sign-in and selection are available. Automatic meeting capture is not
                enabled in this build yet.
              </p>
            ) : null}
          </Form>
          {data.value.connections.map((item) => (
            <CalendarEditor
              key={`${workspaceId}/${item.id}/${item.version}`}
              api={api}
              path={path}
              item={item}
              reload={() => setRefresh((value) => value + 1)}
            />
          ))}
          <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>
            Refresh calendar connections
          </button>
        </>
      ) : null}
    </section>
  );
}
function CalendarEditor({
  api,
  path,
  item,
  reload,
}: {
  api: Api;
  path: string;
  item: z.infer<typeof connection>;
  reload: () => void;
}) {
  const select = useCommand(),
    disconnect = useCommand(),
    initialize = useCommand();
  const [calendarId, setCalendarId] = useState(item.calendarId);
  const [pageCursor, setPageCursor] = useState<string>();
  const preview = useCommand();
  const synchronize = useCommand();
  const [sync, setSync] = useState<z.infer<typeof syncResult> | null>();
  const [occurrences, setOccurrences] = useState<z.infer<typeof occurrencePage>>();
  const loadOccurrences = (next = false) => {
    const parameters =
      next && occurrences?.nextCursor
        ? new URLSearchParams({ ...occurrences.window, cursor: occurrences.nextCursor }).toString()
        : "";
    void preview.run(
      parameters,
      () =>
        api.request(
          `${path}/${item.id}/occurrences${parameters ? `?${parameters}` : ""}`,
          occurrencePage,
        ),
      setOccurrences,
    );
  };
  const data = useData(
    (signal) =>
      item.status === "connected"
        ? api.request(
            `${path}/${item.id}/calendars${pageCursor ? `?cursor=${encodeURIComponent(pageCursor)}` : ""}`,
            calendarPage,
            { signal },
          )
        : Promise.resolve({ items: [], nextCursor: null }),
    [api, path, item.id, item.status, pageCursor],
  );
  return (
    <article className="panel">
      <h3>{item.calendarName}</h3>
      <p role="status">
        {item.provider}: {item.status.replaceAll("_", " ")}
        {item.errorCode ? ` — ${item.errorCode}` : ""}
      </p>
      {item.status === "initializing" ? (
        <Form
          title="Finish linking"
          button="Validate calendar"
          command={initialize}
          submit={() =>
            void initialize.run(
              item.id,
              () => api.request(`${path}/${item.id}/initialize`, connection, { method: "POST" }),
              reload,
            )
          }
        >
          <p>Credentials were saved. Validate calendar access to finish.</p>
        </Form>
      ) : null}
      {item.status === "connected" ? (
        <>
          <Feedback data={data} />
          <Form
            title="Choose calendar"
            disabled={data.loading || item.automatic || item.cleanupPending}
            button="Save calendar"
            command={select}
            submit={() =>
              void select.run(
                { calendarId, version: item.version },
                (key) =>
                  api.request(`${path}/${item.id}/calendar`, connection, {
                    method: "POST",
                    key,
                    body: { calendarId, expectedVersion: item.version },
                  }),
                reload,
              )
            }
          >
            <label>
              Calendar
              <select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
                <option value={item.calendarId}>{item.calendarName}</option>
                {data.value?.items
                  .filter((value) => value.id !== item.calendarId)
                  .map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
              </select>
            </label>
          </Form>
          {data.value?.nextCursor ? (
            <button onClick={() => setPageCursor(data.value!.nextCursor!)}>More calendars</button>
          ) : null}
          <Form
            title="Upcoming calendar events"
            disabled={data.loading}
            button="Preview upcoming events"
            command={preview}
            submit={() => loadOccurrences()}
          >
            <p>
              Read-only preview for the next 14 days. This does not schedule a bot or grant meeting
              access.
            </p>
            {occurrences ? (
              <>
                {occurrences.items.length === 0 ? (
                  <p>No events in this page.</p>
                ) : (
                  <ul>
                    {occurrences.items.map((event) => (
                      <li key={event.sourceKey}>
                        {event.title} — {event.status}
                        {event.declined ? " (declined)" : ""} —{" "}
                        {event.allDay ? "all day" : (event.startsAt ?? "no time")}
                        {event.joinUrl
                          ? " — meeting link available"
                          : " — no unambiguous supported link"}
                      </li>
                    ))}
                  </ul>
                )}
                {occurrences.nextCursor ? (
                  <button type="button" onClick={() => loadOccurrences(true)}>
                    Next event page
                  </button>
                ) : null}
              </>
            ) : null}
          </Form>
          <Form
            title="Durable calendar synchronization"
            button="Synchronize calendar"
            command={synchronize}
            submit={() =>
              void synchronize.run(
                item.id,
                (key) =>
                  api.request(`${path}/${item.id}/sync`, syncResult, { method: "POST", key }),
                setSync,
              )
            }
          >
            <p>
              Save a complete 14-day snapshot. Interrupted pages resume on the worker. Automatic
              capture is not enabled.
            </p>
            {sync ? (
              <p role="status">
                Calendar sync: {sync.state}; pages: {sync.pageCount}
                {sync.errorCode ? ` — ${sync.errorCode}` : ""}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void synchronize.run(
                  "status",
                  () => api.request(`${path}/${item.id}/sync`, syncResult.nullable()),
                  setSync,
                )
              }
            >
              Refresh sync status
            </button>
          </Form>
          <SavedCalendarMeetings
            api={api}
            path={`${path}/${item.id}`}
            workspaceId={item.workspaceId}
          />
          <BackgroundCalendarPolicy
            api={api}
            path={`${path}/${item.id}`}
            item={item}
            reload={reload}
          />
        </>
      ) : null}
      {item.status !== "disconnected" ? (
        <Form
          title="Disconnect calendar"
          button="Disconnect calendar"
          command={disconnect}
          submit={() =>
            void disconnect.run(
              { id: item.id, version: item.version },
              (key) =>
                api.request(`${path}/${item.id}/disconnect`, connection, {
                  method: "POST",
                  key,
                  body: { expectedVersion: item.version },
                }),
              reload,
            )
          }
        >
          <p>Remove stored credentials and prevent further calendar access.</p>
        </Form>
      ) : null}
    </article>
  );
}
function BackgroundCalendarPolicy({
  api,
  path,
  item,
  reload,
}: {
  api: Api;
  path: string;
  item: z.infer<typeof connection>;
  reload: () => void;
}) {
  const command = useCommand();
  const [consent, setConsent] = useState(false);
  return (
    <Form
      title="Background calendar policy"
      button={item.automatic ? "Disable background policy" : "Enable background policy"}
      command={command}
      submit={() =>
        void command.run(
          { enabled: !item.automatic, version: item.version, consent },
          async (key) => {
            if (item.automatic)
              return api.request(`${path}/automation`, connection, {
                method: "POST",
                key,
                body: { enabled: false, expectedVersion: item.version },
              });
            if (!consent) throw new Error("CONSENT_REQUIRED");
            const grant = await api.request(
              `${api.scope(item.workspaceId)}/automation-grants`,
              z.object({ id: z.string().uuid() }),
              {
                method: "POST",
                key: `${key}.grant`,
                body: { connectionId: item.id, consent: true },
              },
            );
            return api.request(`${path}/automation`, connection, {
              method: "POST",
              key,
              body: {
                enabled: true,
                grantId: grant.id,
                consent: true,
                expectedVersion: item.version,
              },
            });
          },
          reload,
        )
      }
    >
      <p>
        Background synchronization {item.automatic ? "enabled" : "disabled"}. The owner grant
        survives logout but can be revoked. Scheduled bot dispatch is not active in this build yet.
      </p>
      {!item.automatic ? (
        <label>
          <input
            type="checkbox"
            required
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I authorize background calendar synchronization and capture of eligible meetings under
          this policy.
        </label>
      ) : null}
    </Form>
  );
}
function SavedCalendarMeetings({
  api,
  path,
  workspaceId,
}: {
  api: Api;
  path: string;
  workspaceId: string;
}) {
  const load = useCommand();
  const schema = z.object({
    items: occurrencePage.shape.items.element
      .extend({ id: z.string().uuid(), version: z.number().int().positive() })
      .array()
      .max(100),
    nextCursor: z.string().nullable(),
  });
  const [page, setPage] = useState<z.infer<typeof schema>>();
  const fetchPage = (cursor?: string) =>
    void load.run(
      cursor ?? "first",
      () =>
        api.request(
          `${path}/stored-occurrences${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
          schema,
        ),
      setPage,
    );
  return (
    <section aria-label="Saved calendar events">
      <Form
        title="Saved calendar events"
        button="Load saved calendar events"
        command={load}
        submit={() => fetchPage()}
      >
        <p>
          Import a synchronized event as a private, unassigned meeting. Capture requires a separate
          command.
        </p>
      </Form>
      {page?.items.map((event) => (
        <CalendarMeetingImport
          key={`${event.id}/${event.version}`}
          api={api}
          path={path}
          workspaceId={workspaceId}
          event={event}
        />
      ))}
      {page && page.items.length === 0 ? (
        <p>No synchronized events. Complete synchronization first.</p>
      ) : null}
      {page?.nextCursor ? (
        <button onClick={() => fetchPage(page.nextCursor!)}>Next saved event page</button>
      ) : null}
    </section>
  );
}
function CalendarMeetingImport({
  api,
  path,
  workspaceId,
  event,
}: {
  api: Api;
  path: string;
  workspaceId: string;
  event: {
    id: string;
    version: number;
    title: string;
    status: string;
    allDay: boolean;
    declined: boolean;
  };
}) {
  const command = useCommand();
  const [meetingId, setMeetingId] = useState<string>();
  const eligible = event.status !== "cancelled" && !event.allDay && !event.declined;
  return (
    <article>
      <h4>{event.title}</h4>
      {eligible ? (
        <Form
          title="Private meeting"
          button="Import private meeting"
          command={command}
          submit={() =>
            void command.run(
              event,
              (key) =>
                api.request(
                  `${path}/meetings`,
                  z.object({ id: z.string().uuid(), version: z.number().int() }),
                  {
                    method: "POST",
                    key,
                    body: { occurrenceId: event.id, expectedVersion: event.version },
                  },
                ),
              (result) => setMeetingId(result.id),
            )
          }
        >
          <p>
            Existing imports keep the same meeting ID. This does not share access or start a bot.
          </p>
        </Form>
      ) : (
        <p>
          {event.status}; {event.allDay ? "all day" : ""}
          {event.declined ? "declined" : ""} — not eligible for a new meeting.
        </p>
      )}
      {meetingId ? (
        <a href={`/w/${workspaceId}?meetingId=${meetingId}`}>Open imported meeting</a>
      ) : null}
    </article>
  );
}
export function CalendarCallback({
  api,
  result,
}: {
  api: Api;
  result: { state: string; code: string } | null;
}) {
  const [message, setMessage] = useState("Linking your calendar…"),
    [workspaceId, setWorkspaceId] = useState<string>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!result) {
      setMessage(
        "Calendar consent was declined or the return link is invalid. Start a new connection from your workspace.",
      );
      return;
    }
    let context: ReturnType<typeof calendarFlow>;
    try {
      context = calendarFlow(sessionStorage, result.state);
      setWorkspaceId(context.workspaceId);
    } catch {
      setMessage(
        "This calendar connection has expired or belongs to a different browser session. Start again from your workspace.",
      );
      return;
    }
    const path = `${api.scope(context.workspaceId)}/connections/calendar`;
    void api
      .request(`${path}/oauth/finish`, connection, {
        method: "POST",
        body: { connectionId: context.connectionId, state: result.state, code: result.code },
      })
      .then(async (item) => {
        removeCalendarFlow(sessionStorage, result.state);
        if (item.status === "initializing")
          await api.request(`${path}/${item.id}/initialize`, connection, { method: "POST" });
        setMessage("Calendar connected. Return to your workspace to review the selected calendar.");
      })
      .catch((error) => setMessage(errorMessage(error)));
  }, [api, result]);
  return (
    <main className="welcome">
      <h1>Calendar connection</h1>
      <p role="status">{message}</p>
      {workspaceId ? (
        <a href={`/w/${workspaceId}`}>Return to workspace</a>
      ) : (
        <a href="/">Return to VisualSprint</a>
      )}
    </main>
  );
}
