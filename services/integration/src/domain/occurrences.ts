export type Occurrence = {
  sourceKey: string;
  providerEventId: string;
  title: string;
  status: "confirmed" | "tentative" | "cancelled";
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  declined: boolean;
  joinUrl: string | null;
};
export type CalendarWindow = { startsAt: string; endsAt: string };
export type OccurrencePage = { items: Occurrence[]; nextCursor: string | null };
