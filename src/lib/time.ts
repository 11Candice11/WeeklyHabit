// South Africa is UTC+2 all year (no daylight saving), so a fixed offset is exact.
// Orders are stored in UTC; "which day / month is this order in" is answered in SAST.

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

function toSast(iso: string): Date {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${iso}`);
  return new Date(t + SAST_OFFSET_MS);
}

/** "2026-11-17" for the SAST calendar day of an ISO timestamp. */
export function localDay(iso: string): string {
  return toSast(iso).toISOString().slice(0, 10);
}

/** "2026-11" for the SAST calendar month of an ISO timestamp. */
export function localMonth(iso: string): string {
  return toSast(iso).toISOString().slice(0, 7);
}

export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function daysInMonth(month: string): number {
  if (!isMonthKey(month)) throw new Error(`Invalid month: ${month}`);
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

export function currentMonth(now: Date = new Date()): string {
  return localMonth(now.toISOString());
}
