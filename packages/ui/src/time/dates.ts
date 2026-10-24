/**
 * Calendar arithmetic on whole days. Dates are ISO `YYYY-MM-DD` strings and are treated as
 * calendar days (UTC), never as instants, so the machine's time zone can never shift a due date.
 * Labels use fixed English names (en-AU style "Tue 27 Oct"), not Intl, so they are identical in
 * every browser and in tests.
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

interface Ymd {
  y: number;
  m: number; // 1..12
  d: number;
}

function parts(iso: string): Ymd {
  const m = ISO_RE.exec(iso);
  if (!m) throw new RangeError(`Not an ISO date (YYYY-MM-DD): ${JSON.stringify(iso)}`);
  const y = Number.parseInt(m[1] ?? '', 10);
  const mo = Number.parseInt(m[2] ?? '', 10);
  const d = Number.parseInt(m[3] ?? '', 10);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new RangeError(`No such date: ${iso}`);
  }
  return { y, m: mo, d };
}

/** Days since 1970-01-01. */
export function dayNumber(iso: string): number {
  const { y, m, d } = parts(iso);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function isoFromDay(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Not a whole day number: ${String(n)}`);
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday (ISO 8601). */
export function weekday(iso: string): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((dayNumber(iso) + 3) % 7) + 7) % 7;
}

export function addDays(iso: string, n: number): string {
  return isoFromDay(dayNumber(iso) + n);
}

/** The Monday that starts the ISO week holding `iso`. */
export function weekStart(iso: string): string {
  return addDays(iso, -weekday(iso));
}

/** ISO week key, e.g. `2026-W43`. Week 1 is the week holding 4 January. */
export function isoWeekKey(iso: string): string {
  const thursday = addDays(iso, 3 - weekday(iso));
  const year = parts(thursday).y;
  const week1Monday = weekStart(`${String(year)}-01-04`);
  const week = (dayNumber(thursday) - dayNumber(week1Monday) - 3) / 7 + 1;
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

/** Calendar month key, e.g. `2026-10`. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function monthStart(iso: string): string {
  parts(iso);
  return `${iso.slice(0, 7)}-01`;
}

/** Last day of the month holding `iso`. */
export function monthEnd(iso: string): string {
  const { y, m } = parts(iso);
  const next =
    m === 12 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

export function addMonths(iso: string, n: number): string {
  const { y, m } = parts(monthStart(iso));
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return `${String(ny)}-${String(nm).padStart(2, '0')}-01`;
}

export function monthName(iso: string): string {
  return MONTHS[parts(iso).m - 1] ?? '';
}

/** "Tue 27 Oct" (default) or "27 Oct" without the weekday. */
export function dayLabel(iso: string, opts: { weekday?: boolean; month?: boolean } = {}): string {
  const { d } = parts(iso);
  const out: string[] = [];
  if (opts.weekday !== false) out.push(WEEKDAYS[weekday(iso)] ?? '');
  out.push(String(d));
  if (opts.month !== false) out.push(monthName(iso));
  return out.join(' ');
}
