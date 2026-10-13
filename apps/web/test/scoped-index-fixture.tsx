// Controlled test root only; no production identity bypass.
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { ScopedIndexPanel, type IndexReadiness } from "../src/scoped-index-panel.js";
const api = new Api(async () => "controlled-index-fixture");
function Fixture() {
  const [changed, setChanged] = useState(false),
    [ready, setReady] = useState<IndexReadiness>();
  const scope = {
    kind: "project" as const,
    id: changed ? "77777777-7777-4777-8777-777777777777" : "44444444-4444-4444-8444-444444444444",
  };
  const onReady = useCallback((state: IndexReadiness) => setReady(state), []);
  return (
    <>
      <button onClick={() => setChanged(true)}>Switch index scope</button>
      <p>Indexed answers: {ready?.ready && ready.scope.id === scope.id ? "enabled" : "disabled"}</p>
      <ScopedIndexPanel
        api={api}
        workspaceId="11111111-1111-4111-8111-111111111111"
        scope={scope}
        onReadiness={onReady}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
