export type UsageTotals = {
  maxConcurrent: number;
  monthlySeconds: number;
  active: number;
  reservedSeconds: number;
  consumedSeconds: number;
};
export function reservationFailure(
  usage: UsageTotals,
  requestedSeconds: number,
): "CONCURRENCY_LIMIT" | "QUOTA_EXCEEDED" | null {
  if (!Number.isInteger(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > 14400)
    throw new Error("INVALID_RESERVATION");
  if (usage.active >= usage.maxConcurrent) return "CONCURRENCY_LIMIT";
  if (usage.reservedSeconds + usage.consumedSeconds + requestedSeconds > usage.monthlySeconds)
    return "QUOTA_EXCEEDED";
  return null;
}
