// Test-only identity, never imported by the production entrypoint.
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { IntelligencePanel } from "../src/intelligence-panel.js";
createRoot(document.getElementById("root")!).render(
  <IntelligencePanel
    api={new Api(async () => "controlled-indexed-chat-fixture")}
    workspaceId="11111111-1111-4111-8111-111111111111"
    scope={{ kind: "project", id: "44444444-4444-4444-8444-444444444444" }}
    contexts={[
      {
        label: "Separate customer",
        scope: { kind: "customer", id: "77777777-7777-4777-8777-777777777777" },
      },
    ]}
  />,
);
