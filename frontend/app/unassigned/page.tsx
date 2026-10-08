"use client";

import { MeetingHistory } from "@/features/founder/MeetingHistory";
export default function UnassignedPage() {
  return <main className="founder-shell"><h1>Unassigned meetings</h1><p>These meetings remain owner-private until you explicitly share them into a project.</p><MeetingHistory scope="&unassigned=true" /></main>;
}
