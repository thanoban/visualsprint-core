// Controlled identity, excluded from the production entrypoint.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { WorkflowPanel } from "../src/workflow-panel.js";
const api = new Api(async () => "controlled-accepted-action");
function Fixture() {
  const [switched, setSwitched] = useState(false);
  const workspaceId = "11111111-1111-4111-8111-111111111111",
    meetingId = switched
      ? "66666666-6666-4666-8666-666666666666"
      : "55555555-5555-4555-8555-555555555555";
  return (
    <>
      <button onClick={() => setSwitched(true)}>Switch action scope</button>
      <WorkflowPanel
        key={meetingId}
        api={api}
        workspaceId={workspaceId}
        owner={!location.search.includes("reader")}
        meeting={{
          id: meetingId,
          workspaceId,
          ownerId: "33333333-3333-4333-8333-333333333333",
          title: "Customer call",
          version: 1,
          notes: "",
          joinUrl: null,
          blocked: false,
          createdAt: "2026-10-14T00:00:00Z",
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
