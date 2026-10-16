import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { NotificationPanel } from "../src/notification-panel.js";
const api = new Api(async () => "controlled-live-fixture");
function Fixture() {
  const [workspaceId, setWorkspace] = useState("11111111-1111-4111-8111-111111111111"),
    [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setWorkspace("22222222-2222-4222-8222-222222222222")}>
        Switch workspace
      </button>
      <button onClick={() => window.dispatchEvent(new Event("visualsprint-session-ending"))}>
        Begin logout
      </button>
      <button onClick={() => setShown(false)}>Close updates</button>
      {shown ? <NotificationPanel key={workspaceId} api={api} workspaceId={workspaceId} /> : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
