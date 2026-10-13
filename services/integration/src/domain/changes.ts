export type CalendarChangePage = {
  changed: boolean;
  nextCursor: string | null;
  finalCursor: string | null;
};
export type CalendarChangeRound = {
  syncId: string;
  phase: "detecting" | "snapshot" | "unchanged";
  sourceCursor: string | null;
  pageCursor: string | null;
  candidateCursor: string | null;
  baseGeneration: string | null;
  changed: boolean;
  pageCount: number;
};
