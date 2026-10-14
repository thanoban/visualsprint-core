// Test-only identity, never imported by production AuthKit entry.
import { useState } from "react";
import { z } from "zod";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { CapturePanel } from "../src/capture-panel.js";
import {
  CaptureProcessingControls,
  captureProcessingSchema,
} from "../src/capture-processing-controls.js";
const api = new Api(async () => "controlled-processing-fixture"),
  captureId = "99999999-9999-4999-8999-999999999999",
  workspaceId = "11111111-1111-4111-8111-111111111111";
function Fixture() {
  const [processing, setProcessing] = useState<z.infer<typeof captureProcessingSchema> | null>(
    null,
  );
  if (location.search.includes("mounted"))
    return (
      <CapturePanel
        api={api}
        workspaceId={workspaceId}
        owner={!location.search.includes("reader")}
        meeting={{
          id: "22222222-2222-4222-8222-222222222222",
          workspaceId,
          ownerId: "33333333-3333-4333-8333-333333333333",
          title: "Customer call",
          notes: "",
          joinUrl: "https://meet.google.com/abc-defg-hij",
          version: 1,
          blocked: false,
          createdAt: "2026-10-14T00:00:00Z",
        }}
      />
    );
  return (
    <>
      <button
        onClick={() =>
          void api
            .request(
              `${api.scope(workspaceId)}/captures/${captureId}`,
              z.object({ processing: captureProcessingSchema.nullable() }),
            )
            .then((value) => setProcessing(value.processing))
        }
      >
        Refresh consent status
      </button>
      <CaptureProcessingControls
        api={api}
        workspaceId={workspaceId}
        captureId={captureId}
        owner={!location.search.includes("reader")}
        processing={processing}
        onChanged={() =>
          void api
            .request(
              `${api.scope(workspaceId)}/captures/${captureId}`,
              z.object({ processing: captureProcessingSchema.nullable() }),
            )
            .then((value) => setProcessing(value.processing))
        }
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
