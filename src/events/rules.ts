/**
 * Deterministic event extraction: no network, no model. Finds one primary event per email
 * (single-event announcements are the common case on residential listservs); digests with
 * several events are left to the LLM extractor, which returns a list.
 */
import * as chrono from 'chrono-node';
import { CAMPUS_TZ, campusLocalString, campusLocalToUtc } from './time.ts';
import { resolveLocation, ONLINE_LOCATION_ID, getLocation, type LocationMatch } from './locations.ts';
import { tagsFromText, TAG_RULES } from './taxonomy.ts';
import type { ExtractedEvent, ExtractionInput, ExtractionResult } from './types.ts';

export const RULES_VERSION = 'rules-1';

const EVENT_WORDS =
  /\b(?:join us|come (?:to|out|by|join)|rsvp|event|talk|workshop|info(?:rmation)? session|study break|meeting|panel|screening|performance|concert|game night|tabling|open house|party|social|mixer|dinner|lunch|brunch|tournament|hackathon|lecture|seminar|colloquium|reading|exhibit(?:ion)? opening|tryouts?|auditions?|showcase|fair|celebration|vigil|service|mass|ceremony|kickoff|meetup|gathering)\b/i;
const NOT_EVENT =
  /\b(?:for sale|selling|sublet(?:ting)?|lost (?:and|&) found|lost my|found a|looking for (?:a |an )?(?:roommate|ride|tutor)|survey|paid (?:research )?study|participants? needed|job opening|now hiring|applications? (?:are )?(?:open|due)|apply (?:now|by|here)|deadline|newsletter|weekly digest|this week at|due (?:in|by|on|tonight|tomorrow|today)|apply (?:for|to)|applications?\b|register by|sign ?up by|submissions?\b|\[apply\]|call for (?:papers|submissions|applications))\b/i;
const ONLINE = /\bzoom\.us\/|\b(?:on|via|over|through) (?:zoom|google meet|microsoft teams|teams)\b|\bzoom (?:link|meeting|call)\b|\bwebinar\b|\blivestream(?:ed)? (?:at|on|via)\b/i;
/** 11:59 pm is a submission deadline, never an event start. */
const DEADLINE_TIME = /\b(?:11:59\s*(?:pm|p\.m\.)?|23:59)\b/i;
/** Relative durations ("in 24 hours") and "now" describe deadlines or urgency, not event times. */
const RELATIVE = /\b(?:in|within|next)\s+\d+\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?)\b|\bnow\b|\bago\b/i;
const RSVP_URL = /forms\.gle|docs\.google\.com\/forms|eventbrite\.|partiful\.com|lu\.ma\/|luma\.com|rsvp|tigerhub|my\.princeton\.edu\/rsvp|campusgroups/i;

/** Remove list tags, forwarding prefixes and shouty lead-ins from a subject. */
export function cleanTitle(subject: string): string {
  let title = subject.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++)
    title = title
      .replace(/^\s*\[[^\]]{1,40}\]\s*/, '')
      .replace(/^\s*(?:re|fwd?|fw)\s*:\s*/i, '')
      .trim();
  title = title.replace(/^(?:TODAY|TONIGHT|TOMORROW|TMRW|THIS \w+|REMINDER|LAST CHANCE|NOW|NEW)\s*[:!\-–—|]+\s*/i, '');
  // Drop trailing logistics ("… THIS Tuesday @4:30 in Frist 207") once the name has 2+ words.
  const logistics =
    /\s+(?:[-–—|:(]\s*)?(?:(?:this|next|on)\s+)?(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b|tonight\b|tomorrow\b|tmrw\b|today\b|(?:@|at)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\d{1,2}\/\d{1,2}\b)/i;
  const cut = logistics.exec(title);
  if (cut && title.slice(0, cut.index).trim().split(/\s+/).length >= 2) title = title.slice(0, cut.index);
  title = title.replace(/[\s!:,\-–—|(]+$/, '').trim();
  return (title || subject || 'Untitled event').slice(0, 200);
}

export function summarize(body: string, max = 600): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
  let out = '';
  for (const p of paragraphs) {
    if ((out + ' ' + p).length > max) break;
    out = out ? `${out}\n\n${p}` : p;
  }
  return (out || body.replace(/\s+/g, ' ').trim()).slice(0, max);
}

/** Candidate location phrases, most explicit first. */
const tidy = (phrase: string) => phrase.replace(/[\s.,;:!]+$/, '').trim();

export function locationCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:📍|\*?\s*(?:location|where|place|venue|room)\s*\*?\s*[:\-–—])\s*([^\n]{2,120})/gi))
    out.push(m[1].trim());
  for (const m of text.matchAll(/📍\s*([^\n]{2,120})/g)) out.push(m[1].trim());
  const prepositional =
    /\b(?:in|at|@|by|outside|inside|near|on)\s+((?:the\s+)?(?:[A-Z][\w'’&.\-/]*|\d{1,4}[A-Z]?)(?:\s+(?:[A-Z0-9][\w'’&.\-/]*|of|and|for|the|&|[A-Z]?\d{1,4}[A-Z]?))*)/g;
  for (const m of text.matchAll(prepositional)) out.push(m[1].trim());
  return out.map(tidy).filter(Boolean);
}

export function findLocation(text: string): { phrase: string; match: LocationMatch | null; online: boolean } | null {
  const candidates = locationCandidates(text);
  for (const phrase of candidates) {
    const match = resolveLocation(phrase);
    if (match) return { phrase, match, online: match.location.id === ONLINE_LOCATION_ID };
  }
  const label = /(?:^|\n)\s*(?:📍|\*?\s*(?:location|where|place|venue|room)\s*\*?\s*[:\-–—])\s*([^\n]{2,120})/i.exec(text);
  if (label) return { phrase: tidy(label[1]), match: null, online: ONLINE.test(label[1]) || /^(?:zoom|online|virtual)/i.test(label[1].trim()) };
  if (ONLINE.test(text)) return { phrase: 'Online', match: null, online: true };
  return null;
}

type Pick = { start: Date; end: Date | null; exact: boolean; index: number; inSubject: boolean };

/** A Date whose *host-local* wall clock equals the campus wall clock at `instant`. */
function campusWallClock(instant: Date): Date {
  const [date, time] = campusLocalString(instant).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.slice(0, 5).split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
}

/** Convert chrono components (campus wall clock unless the text named a zone) to a UTC instant. */
function toInstant(c: chrono.ParsedComponents, addHours: number): Date {
  if (c.isCertain('timezoneOffset')) return new Date(c.date().getTime() + addHours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hour = (c.get('hour') ?? 12) + addHours;
  const local = `${c.get('year')}-${pad(c.get('month') ?? 1)}-${pad(c.get('day') ?? 1)}T${pad(hour % 24)}:${pad(c.get('minute') ?? 0)}`;
  const utc = campusLocalToUtc(local)!;
  return hour >= 24 ? new Date(utc.getTime() + 86400_000) : utc;
}

function pickDate(subject: string, body: string, sentAt: Date): Pick | null {
  const ref = campusWallClock(sentAt);
  const opts = { forwardDate: true };
  const from = sentAt.getTime() - 6 * 3600_000;
  const until = sentAt.getTime() + 180 * 86400_000;
  const results: Pick[] = [];
  const scan = (text: string, inSubject: boolean) => {
    for (const r of chrono.parse(text, ref, opts)) {
      if (RELATIVE.test(r.text) || DEADLINE_TIME.test(r.text)) continue;
      // "5:30" with no am/pm: campus events between 1 and 7 o'clock are afternoon/evening.
      const hour = r.start.get('hour');
      const shift = r.start.isCertain('hour') && !r.start.isCertain('meridiem') && hour !== null && hour >= 1 && hour <= 7 ? 12 : 0;
      const start = toInstant(r.start, shift);
      // Relative weekday or time alone: meaningful only near the send date.
      const hasDay = r.start.isCertain('day') || r.start.isCertain('weekday') || /\b(?:today|tonight|tomorrow)\b/i.test(r.text);
      const exact = r.start.isCertain('hour');
      if (!hasDay && !exact) continue;
      if (start.getTime() < from || start.getTime() > until) continue;
      let end = r.end ? toInstant(r.end, r.end.isCertain('meridiem') ? 0 : shift && (r.end.get('hour') ?? 0) <= 11 ? 12 : 0) : null;
      if (end && end.getTime() <= start.getTime()) end = null;
      results.push({ start, end, exact, index: r.index, inSubject });
    }
  };
  scan(subject, true);
  scan(body.slice(0, 6000), false);
  if (!results.length) return null;
  // Prefer an exact time. A subject date with no time borrows the body's first exact time that
  // falls on the same campus-local day.
  const exact = results.filter((r) => r.exact);
  const subj = results.find((r) => r.inSubject);
  if (subj && !subj.exact) {
    const day = subj.start.toLocaleDateString('en-CA', { timeZone: CAMPUS_TZ });
    const same = exact.find((r) => r.start.toLocaleDateString('en-CA', { timeZone: CAMPUS_TZ }) === day);
    if (same) return same;
  }
  return exact[0] ?? results[0];
}

export function extractWithRules(input: ExtractionInput): ExtractionResult {
  const notes: string[] = [];
  const text = `${input.subject}\n${input.body}`;
  const when = pickDate(input.subject, input.body, input.sentAt);
  const where = findLocation(input.body) ?? findLocation(input.subject);
  const freeFood = TAG_RULES['free food'].test(text) || input.listserv === 'FREEFOOD';

  let score = 0;
  if (when?.exact) score += 2;
  if (when) score += 1;
  if (where?.match || where?.online) score += 2;
  else if (where) score += 1;
  if (EVENT_WORDS.test(text)) score += 1;
  if (freeFood) score += 1;
  if (NOT_EVENT.test(input.subject)) score -= 3;
  else if (NOT_EVENT.test(input.body.slice(0, 1500))) score -= 1;

  const isEvent = !!when && score >= 4;
  if (!when) notes.push('no future date or time found');
  if (!isEvent) return { version: RULES_VERSION, method: 'rules', isEventAnnouncement: false, events: [], notes };

  const loc = where?.match?.location ?? (where?.online ? getLocation(ONLINE_LOCATION_ID) : undefined);
  const rsvpUrl = (input.links ?? []).find((l) => RSVP_URL.test(l)) ?? null;
  const confidence = Math.min(1, 0.35 + 0.1 * score + (when!.exact ? 0.1 : 0) - (NOT_EVENT.test(text) ? 0.15 : 0));
  const event: ExtractedEvent = {
    title: cleanTitle(input.subject),
    summary: summarize(input.body),
    startsAt: when!.start.toISOString(),
    endsAt: when!.end?.toISOString() ?? null,
    timePrecision: when!.exact ? 'exact' : 'date',
    locationText: where?.phrase ?? null,
    locationId: loc?.id ?? null,
    locationName: loc?.name ?? null,
    latitude: loc && loc.latitude !== 0 ? loc.latitude : null,
    longitude: loc && loc.longitude !== 0 ? loc.longitude : null,
    room: where?.match?.room ?? null,
    online: !!where?.online,
    tags: [...new Set([...(freeFood ? (['free food'] as const) : []), ...tagsFromText(text)])].slice(0, 4),
    freeFood,
    rsvpUrl,
    hostOrganizationId: input.organizationId ?? null,
    hostOrganizationName: input.organizationName ?? null,
    confidence: Number(confidence.toFixed(2)),
    publishable: false
  };
  event.publishable = event.timePrecision === 'exact' && !!event.locationText && event.confidence >= 0.7;
  return { version: RULES_VERSION, method: 'rules', isEventAnnouncement: true, events: [event], notes };
}
