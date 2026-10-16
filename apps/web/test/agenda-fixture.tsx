// Test-only identity, excluded from the production entrypoint.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api, type Meeting } from "../src/api.js";
import { AgendaPanel } from "../src/agenda-panel.js";
import { DataRightsPanel } from "../src/data-rights-panel.js";
const api = new Api(async () => "controlled-agenda-fixture"),
  workspaceId = "11111111-1111-4111-8111-111111111111";
function Fixture() {
  const [meeting, setMeeting] = useState<Meeting>({
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId,
      ownerId: "33333333-3333-4333-8333-333333333333",
      title: "Customer call",
      notes: "",
      version: 1,
      blocked: false,
      joinUrl: null,
      createdAt: "2026-10-15T00:00:00Z",
    }),
    [reloads, setReloads] = useState(0);
  if (location.search.includes("exports"))
    return <DataRightsPanel api={api} workspaceId={workspaceId} meeting={meeting} owner={false} />;
  return (
    <>
      <button
        onClick={() => setMeeting({ ...meeting, id: "66666666-6666-4666-8666-666666666666" })}
      >
        Switch agenda scope
      </button>
      <p>
        Meeting reloads: {reloads}; current revision {meeting.version}.
      </p>
      <AgendaPanel
        api={api}
        workspaceId={workspaceId}
        meeting={meeting}
        owner={!location.search.includes("reader")}
        onMeetingReload={(fresh) => {
          setMeeting(fresh);
          setReloads((value) => value + 1);
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
