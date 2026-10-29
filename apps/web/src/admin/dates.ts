/**
 * Calendar dates (`YYYY-MM-DD`) for the admin screens. Dates are computed in UTC so the browser's
 * own time zone never moves a day; times from the API are shown in Australian English.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function utc(date: string): Date {
  if (!ISO.test(date)) throw new RangeError(`not a calendar date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the ISO week holding `date`. */
export function mondayOf(date: string): string {
  const dow = utc(date).getUTCDay(); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(utc(date))
    .replace(',', '');
}

/** A timestamp from the API for reading: "23 Oct 2026, 10:30 am" in the given or browser zone. */
export function timeLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
