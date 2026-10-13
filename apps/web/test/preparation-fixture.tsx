// Separate browser-test root; never included in the production identity entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { PreparationPanel } from "../src/preparation-panel.js";
const workspaceId = "11111111-1111-4111-8111-111111111111",
  ownerId = "33333333-3333-4333-8333-333333333333";
const api = new Api(async () => "controlled-preparation-fixture");
function Fixture() {
  const [changed, setChanged] = useState(false);
  return (
    <>
      <button onClick={() => setChanged(true)}>Switch preparation meeting</button>
      <PreparationPanel
        api={api}
        workspaceId={workspaceId}
        owner={!new URL(location.href).searchParams.has("reader")}
        meeting={{
          id: changed
            ? "77777777-7777-4777-8777-777777777777"
            : "55555555-5555-4555-8555-555555555555",
          workspaceId,
          ownerId,
          title: "Next customer meeting",
          notes: "",
          joinUrl: null,
          version: 1,
          blocked: false,
          createdAt: "2026-10-14T00:00:00Z",
        }}
        projects={[
          {
            id: "44444444-4444-4444-8444-444444444444",
            workspaceId,
            ownerId,
            name: "Customer onboarding",
            customerId: null,
            version: 1,
          },
        ]}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
