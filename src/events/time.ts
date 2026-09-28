/** Princeton wall-clock time helpers (America/New_York), dependency-free. */
export const CAMPUS_TZ = 'America/New_York';

function offsetMinutes(utc: Date, timeZone = CAMPUS_TZ): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utc.getTime()) / 60000);
}

/** Convert a local "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD") in campus time to a UTC Date. */
export function campusLocalToUtc(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Two passes handle DST boundaries.
  let utc = guess - offsetMinutes(new Date(guess)) * 60000;
  utc = guess - offsetMinutes(new Date(utc)) * 60000;
  const date = new Date(utc);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Format a UTC instant as campus-local "YYYY-MM-DDTHH:mm (Weekday)" for prompts and display. */
export function campusLocalString(date: Date): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAMPUS_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long'
  }).formatToParts(date);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')} (${get('weekday')})`;
}
