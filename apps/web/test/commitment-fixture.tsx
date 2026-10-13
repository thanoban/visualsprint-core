// Isolated test entry; never imported by the production AuthKit entrypoint.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { CommitmentReview } from "../src/commitment-review.js";
const api = new Api(async () => "controlled-review-fixture");
function Fixture() {
  const [switched, setSwitched] = useState(false);
  return (
    <>
      <button onClick={() => setSwitched(true)}>Switch meeting scope</button>
      <CommitmentReview
        api={api}
        workspaceId="11111111-1111-4111-8111-111111111111"
        owner={!new URL(location.href).searchParams.has("reader")}
        meeting={{
          id: switched
            ? "66666666-6666-4666-8666-666666666666"
            : "55555555-5555-4555-8555-555555555555",
          workspaceId: "11111111-1111-4111-8111-111111111111",
          ownerId: "33333333-3333-4333-8333-333333333333",
          title: "Founder customer call",
          notes: "",
          joinUrl: null,
          version: 1,
          blocked: false,
          createdAt: "2026-10-13T00:00:00Z",
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
