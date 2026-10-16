import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { CommitmentReview } from "../src/commitment-review.js";
const api = new Api(async () => "controlled-extraction-fixture");
function Fixture() {
  const [meetingId, setMeeting] = useState("55555555-5555-4555-8555-555555555555"),
    [workspaceId, setWorkspace] = useState("11111111-1111-4111-8111-111111111111"),
    [owner, setOwner] = useState(!new URL(location.href).searchParams.has("reader"));
  return (
    <>
      <button onClick={() => setMeeting("66666666-6666-4666-8666-666666666666")}>
        Switch meeting
      </button>
      <button onClick={() => setWorkspace("22222222-2222-4222-8222-222222222222")}>
        Switch workspace
      </button>
      <button onClick={() => setOwner(false)}>Become reader</button>
      <CommitmentReview
        api={api}
        workspaceId={workspaceId}
        owner={owner}
        meeting={{
          id: meetingId,
          workspaceId,
          ownerId: "33333333-3333-4333-8333-333333333333",
          title: "Meeting",
          notes: "",
          joinUrl: null,
          version: 1,
          blocked: false,
          createdAt: "2026-10-16T00:00:00Z",
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
