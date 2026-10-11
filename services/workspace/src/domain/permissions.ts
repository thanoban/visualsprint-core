export type MeetingAccess = { ownerId: string; readerIds: readonly string[]; blocked: boolean };
export function canReadMeeting(actorId: string, meeting: MeetingAccess): boolean {
  return !meeting.blocked && (meeting.ownerId === actorId || meeting.readerIds.includes(actorId));
}
export function canManageMeeting(actorId: string, meeting: MeetingAccess): boolean {
  return !meeting.blocked && meeting.ownerId === actorId;
}
