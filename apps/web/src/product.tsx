import { useMemo, useState } from "react";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { Api, ApiError, errorMessage } from "./api.js";
import { useData, useCommand, Feedback, Form } from "./ui.js";
import { OrganizationForms, MeetingForm } from "./organization-forms.js";
import { MeetingPanel } from "./meeting-detail.js";
import { CalendarPanel } from "./calendar-panel.js";
import { IntelligencePanel } from "./intelligence-panel.js";
import { NotificationPanel } from "./notification-panel.js";
import { DeletionStatus } from "./deletion-status.js";

type Context = { api: Api; email: string; signOut: () => void };
const rootRoute = createRootRouteWithContext<Context>()({ component: Frame });
function Frame() {
  const { api, email, signOut } = rootRoute.useRouteContext();
  const logout = useCommand();
  const [refresh, setRefresh] = useState(0);
  const data = useData((signal) => api.me(signal), [api, refresh]);
  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="brand">
          [ VisualSprint ]
        </Link>
        <p className="identity">{email}</p>
        <span className="eyebrow">WORKSPACES</span>
        <Feedback data={data} />
        <nav aria-label="Workspaces">
          {data.value?.workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              to="/w/$workspaceId"
              params={{ workspaceId: workspace.id }}
              search={{}}
            >
              {workspace.name}
            </Link>
          ))}
        </nav>
        <Link to="/" className="subtle">
          Create workspace
        </Link>
        <div className="sidebar-footer">
          <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>
            Refresh access
          </button>
          <button
            className="secondary"
            disabled={logout.busy}
            onClick={() => {
              window.dispatchEvent(new Event("visualsprint-session-ending"));
              void logout.run("logout", () => api.logout(), signOut);
            }}
          >
            Sign out
          </button>
          {logout.error ? <p role="alert">{errorMessage(logout.error)}</p> : null}
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
function Home() {
  const { api } = rootRoute.useRouteContext();
  const navigate = indexRoute.useNavigate();
  const [name, setName] = useState("");
  const command = useCommand();
  return (
    <>
      <header>
        <span className="eyebrow">PRIVATE BY DEFAULT</span>
        <h1>A home for every conversation.</h1>
        <p>
          Separate customer and team projects. Organize meetings deliberately; share them only when
          you choose.
        </p>
      </header>
      <Form
        title="Create your workspace"
        button="Create workspace"
        command={command}
        submit={() =>
          void command.run(
            { name },
            (key) => api.createWorkspace(name, key),
            (workspace) => {
              void navigate({
                to: "/w/$workspaceId",
                params: { workspaceId: workspace.id },
                search: {},
              });
            },
          )
        }
      >
        <label>
          Workspace name
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Acme founders"
          />
        </label>
      </Form>
    </>
  );
}
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$workspaceId",
  validateSearch: (input: Record<string, unknown>) =>
    z
      .object({ projectId: id.optional(), meetingId: id.optional(), deletionId: id.optional() })
      .parse(input),
  component: WorkspacePage,
});
function WorkspacePage() {
  const { workspaceId } = workspaceRoute.useParams();
  const parsed = id.safeParse(workspaceId);
  if (!parsed.success) return <p role="alert">Invalid workspace link.</p>;
  return <WorkspacePanel key={workspaceId} workspaceId={parsed.data} />;
}
function WorkspacePanel({ workspaceId }: { workspaceId: string }) {
  const [showCalendars, setShowCalendars] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const { api } = rootRoute.useRouteContext();
  const { projectId, meetingId, deletionId } = workspaceRoute.useSearch();
  const navigate = workspaceRoute.useNavigate();
  const [refresh, setRefresh] = useState(0);
  const data = useData(
    async (signal) => {
      const [me, customers, projects, meetings] = await Promise.all([
        api.me(signal),
        api.customers(workspaceId, signal),
        api.projects(workspaceId, signal),
        api.meetings(workspaceId, projectId, signal),
      ]);
      const workspace = me.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new ApiError("FORBIDDEN", 403);
      return { userId: me.userId, workspace, customers, projects, meetings };
    },
    [api, workspaceId, projectId, refresh],
  );
  const reload = () => setRefresh((value) => value + 1);
  const value = data.value;
  return (
    <>
      <header className="row">
        <div>
          <span className="eyebrow">MEETING WORKSPACE</span>
          <h1>{value?.workspace.name ?? "Workspace"}</h1>
          <p>Meetings remain private unless explicitly shared.</p>
        </div>
        <button className="secondary" onClick={reload}>
          Refresh
        </button>
      </header>
      <Feedback data={data} />
      {value ? (
        <>
          <button className="secondary" onClick={() => setShowCalendars((value) => !value)}>
            Calendar connections
          </button>
          {showCalendars ? (
            <CalendarPanel key={workspaceId} api={api} workspaceId={workspaceId} />
          ) : null}
          <button className="secondary" onClick={() => setShowNotifications((value) => !value)}>
            Notifications
          </button>
          {showNotifications ? (
            <NotificationPanel key={workspaceId} api={api} workspaceId={workspaceId} />
          ) : null}
          {deletionId ? (
            <DeletionStatus
              key={`${workspaceId}/${deletionId}`}
              api={api}
              workspaceId={workspaceId}
              deletionId={deletionId}
            />
          ) : null}
          <IntelligencePanel
            key={`${workspaceId}/${projectId ?? "workspace"}`}
            api={api}
            workspaceId={workspaceId}
            scope={projectId ? { kind: "project", id: projectId } : { kind: "workspace", id: null }}
            contexts={[
              { label: "Workspace", scope: { kind: "workspace", id: null } },
              ...value.projects.map((project) => ({
                label: `Project: ${project.name}`,
                scope: { kind: "project" as const, id: project.id },
              })),
              ...value.customers.map((customer) => ({
                label: `Customer: ${customer.name}`,
                scope: { kind: "customer" as const, id: customer.id },
              })),
            ]}
          />
          <div className="workspace-grid">
            <section className="projects">
              <h2>Projects</h2>
              <nav aria-label="Projects">
                <Link
                  to="/w/$workspaceId"
                  params={{ workspaceId }}
                  search={{}}
                  className={!projectId ? "selected" : ""}
                >
                  All accessible meetings
                </Link>
                {value.projects.map((project) => (
                  <Link
                    key={project.id}
                    to="/w/$workspaceId"
                    params={{ workspaceId }}
                    search={{ projectId: project.id }}
                    className={projectId === project.id ? "selected" : ""}
                  >
                    <strong>{project.name}</strong>
                    <small>
                      {value.customers.find((customer) => customer.id === project.customerId)
                        ?.name ?? "Internal team"}
                    </small>
                  </Link>
                ))}
              </nav>
              <OrganizationForms
                api={api}
                workspaceId={workspaceId}
                customers={value.customers}
                reload={reload}
              />
            </section>
            <section>
              <h2>
                {value.projects.find((project) => project.id === projectId)?.name ?? "Meetings"}
              </h2>
              {value.meetings.length ? (
                <ul className="meetings">
                  {value.meetings.map((meeting) => (
                    <li key={meeting.id}>
                      <Link
                        to="/w/$workspaceId"
                        params={{ workspaceId }}
                        search={{ ...(projectId ? { projectId } : {}), meetingId: meeting.id }}
                      >
                        <strong>{meeting.title}</strong>
                        <span>
                          {new Date(meeting.createdAt).toLocaleDateString()} ·{" "}
                          {meeting.ownerId === value.userId ? "Owned by you" : "Shared with you"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty">
                  <h3>No meetings here yet</h3>
                  <p>Create a private meeting, then confirm its project assignment.</p>
                </div>
              )}
              <MeetingForm api={api} workspaceId={workspaceId} reload={reload} />
            </section>
          </div>
          {meetingId ? (
            <MeetingPanel
              key={`${workspaceId}/${meetingId}`}
              api={api}
              workspaceId={workspaceId}
              meetingId={meetingId}
              userId={value.userId}
              projects={value.projects}
              reload={reload}
              onDeleted={(jobId) => {
                void navigate({
                  to: "/w/$workspaceId",
                  params: { workspaceId },
                  search: { ...(projectId ? { projectId } : {}), deletionId: jobId },
                });
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute]);
export function Product(context: Context) {
  const router = useMemo(
    () =>
      createRouter({
        routeTree,
        context,
        defaultPreload: false,
        defaultErrorComponent: () => (
          <main>
            <h1>This page could not be loaded</h1>
            <p>Check the link or refresh your workspace.</p>
            <a href="/">Back to workspaces</a>
          </main>
        ),
      }),
    [context.api, context.email, context.signOut],
  );
  return <RouterProvider router={router} />;
}
type AppRouter = ReturnType<typeof createRouter<typeof routeTree>>;
declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
