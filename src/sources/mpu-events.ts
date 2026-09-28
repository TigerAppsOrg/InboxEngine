/**
 * Official MyPrincetonU (CampusGroups) events from the public RSS feed
 * https://my.princeton.edu/rss_events — no authentication. These are authoritative: listserv
 * extractions that repeat an official event are marked `duplicate` of it.
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { htmlToText } from '../core/index.ts';
import { getOrganization } from '../orgs/index.ts';
import { resolveLocation, getLocation, ONLINE_LOCATION_ID, tagsFromText, type EventTag, EVENT_TAGS } from '../events/index.ts';
import type { Sql } from '../store/db.ts';

export const MPU_EVENTS_URL = 'https://my.princeton.edu/rss_events';
export const MPU_VERSION = 'mpu-1';

type Item = Record<string, string | number | undefined>;

const TOPIC_TAGS: Record<string, EventTag> = {
  'Career Development': 'career',
  Networking: 'career',
  'Information Session': 'career',
  'Lecture/Talk': 'speaker event',
  'Speaker/Lecture': 'speaker event',
  'Social Event': 'social event',
  Social: 'social event',
  'Performance': 'performing arts',
  'Arts & Culture': 'culture',
  Cultural: 'culture',
  'Athletics/Recreation': 'athletics',
  Sports: 'athletics',
  'Community Service': 'community service',
  Service: 'community service',
  'Health & Wellness': 'wellness',
  Wellness: 'wellness',
  Religious: 'religion',
  'Religious/Spiritual': 'religion',
  Academic: 'academics',
  'Training/Workshop': 'academics',
  Research: 'research',
  Political: 'politics',
  Sustainability: 'sustainability',
  Food: 'free food'
};

export const mpuEventId = (eventId: string) => createHash('sha256').update(`mpu#${eventId}`).digest('hex').slice(0, 24);

export function parseMpuFeed(xml: string): Item[] {
  const parsed = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true, parseTagValue: false }).parse(xml);
  const raw = parsed?.rss?.channel?.item;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

export function mapMpuItem(item: Item) {
  const eventId = str(item.eventId);
  const start = new Date(str(item.eventStartDateTime) || str(item.start));
  const endRaw = str(item.eventEndDateTime) || str(item.end);
  const end = endRaw ? new Date(endRaw) : null;
  if (!eventId || !Number.isFinite(start.getTime())) return null;
  const hours = end && Number.isFinite(end.getTime()) ? (end.getTime() - start.getTime()) / 3600_000 : 0;
  const locationText = str(item.eventLocation);
  const hidden = /private location|sign in to display/i.test(locationText) || !locationText || /^tbd$/i.test(locationText);
  const online = /virtual|online/i.test(str(item.locationType)) || /zoom|virtual|online/i.test(locationText);
  const match = hidden ? null : resolveLocation(locationText);
  const loc = match?.location ?? (online ? getLocation(ONLINE_LOCATION_ID) : undefined);
  const description = htmlToText(str(item.fullDescription) || str(item.description));
  const topics = str(item.eventTopics).split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  const title = str(item.title) || 'Untitled event';
  const freeFood = str(item.foodProvided) === '1';
  const tags = [
    ...new Set<EventTag>([
      ...(freeFood ? (['free food'] as EventTag[]) : []),
      ...topics.map((t) => TOPIC_TAGS[t]).filter((t): t is EventTag => !!t && (EVENT_TAGS as readonly string[]).includes(t)),
      ...tagsFromText(`${title}\n${description}`)
    ])
  ].slice(0, 4);
  const groupId = str(item.groupId);
  const host = groupId ? getOrganization(`mpu:${groupId}`) : undefined;
  const allDay = str(item.allDayEvent) === '1';
  // Multi-day spans ("ongoing" interest lists, semester-long meetings) aren't single events.
  const ongoing = hours > 36;
  return {
    id: mpuEventId(eventId),
    source: 'myprincetonu',
    messageId: null,
    idx: 0,
    externalId: eventId,
    externalUrl: str(item.eventLink) || str(item.link) || null,
    imageUrl: str(item.eventPhotoFullUrl) || str(item.eventFlyerFullUrl) || null,
    status: str(item.eventDelete) === '1' ? 'withdrawn' : 'active',
    title: title.slice(0, 200),
    summary: description.slice(0, 1500),
    startsAt: start,
    endsAt: end && Number.isFinite(end.getTime()) && end > start ? end : null,
    timePrecision: allDay ? 'date' : 'exact',
    locationText: hidden ? null : locationText,
    locationId: loc?.id ?? null,
    locationName: loc?.name ?? null,
    latitude: loc && loc.latitude !== 0 ? loc.latitude : null,
    longitude: loc && loc.longitude !== 0 ? loc.longitude : null,
    room: match?.room ?? null,
    online,
    tags: tags as string[],
    freeFood,
    rsvpUrl: str(item.externalRegistrationLink) || str(item.eventExternalRegistrationLink) || str(item.eventLink) || null,
    hostOrgId: host?.id ?? (groupId ? `mpu:${groupId}` : null),
    hostOrgName: host?.name ?? (str(item.group) || null),
    confidence: 1,
    publishable: !ongoing && str(item.eventDelete) !== '1',
    extractionVersion: MPU_VERSION
  };
}

/**
 * MyPrincetonU fills missing event photos with platform defaults (e.g. the "MyPrinceton" banner on
 * ~400 events). An image shared by five or more different host groups is treated as a default.
 */
export function withoutGenericImages<T extends { imageUrl: string | null; hostOrgId: string | null }>(rows: T[]): T[] {
  const hosts = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.imageUrl) continue;
    const set = hosts.get(r.imageUrl) ?? new Set<string>();
    set.add(r.hostOrgId ?? '');
    hosts.set(r.imageUrl, set);
  }
  return rows.map((r) =>
    r.imageUrl && ((hosts.get(r.imageUrl)?.size ?? 0) >= 5 || /MyPrinceton_\d+x\d+/i.test(r.imageUrl)) ? { ...r, imageUrl: null } : r
  );
}

/** Series key: same host and the same title once dates, numbers and weekdays are removed. */
export function seriesKey(hostOrgId: string | null, title: string): string {
  const norm = title
    .toLowerCase()
    .replace(/\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, ' ')
    .replace(/[\d/:.#-]+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return createHash('sha256').update(`${hostOrgId ?? ''}|${norm}`).digest('hex').slice(0, 16);
}

type MpuRow = NonNullable<ReturnType<typeof mapMpuItem>>;
export function withSeries(rows: MpuRow[]): (MpuRow & { seriesId: string | null; seriesSize: number | null })[] {
  const keys = rows.map((r) => seriesKey(r.hostOrgId, r.title));
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return rows.map((r, i) => {
    const size = counts.get(keys[i]) ?? 1;
    return { ...r, seriesId: size > 1 ? keys[i] : null, seriesSize: size > 1 ? size : null };
  });
}

/** Pull the feed, upsert official events, and withdraw future events that disappeared from it. */
export async function syncMpuEvents(sql: Sql, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(MPU_EVENTS_URL, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'InboxEngine/0.1 (+https://tigerapps.org)' } });
  if (!res.ok) throw new Error(`MyPrincetonU feed ${res.status}`);
  const mapped = parseMpuFeed(await res.text()).map(mapMpuItem).filter((r) => r !== null);
  if (mapped.length < 20) throw new Error(`MyPrincetonU feed returned only ${mapped.length} events; refusing to withdraw`);
  const rows = withSeries(withoutGenericImages(mapped));
  let changed = 0;
  for (const row of rows) {
    const [out] = await sql`
      INSERT INTO events ${sql(row)}
      ON CONFLICT (source, external_id) DO UPDATE SET
        external_url = excluded.external_url, image_url = excluded.image_url, status = excluded.status,
        title = excluded.title, summary = excluded.summary, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        time_precision = excluded.time_precision, location_text = excluded.location_text, location_id = excluded.location_id,
        location_name = excluded.location_name, latitude = excluded.latitude, longitude = excluded.longitude,
        room = excluded.room, online = excluded.online, tags = excluded.tags, free_food = excluded.free_food,
        rsvp_url = excluded.rsvp_url, host_org_id = excluded.host_org_id, host_org_name = excluded.host_org_name,
        publishable = excluded.publishable, extraction_version = excluded.extraction_version,
        series_id = excluded.series_id, series_size = excluded.series_size,
        updated_at = now(), revision = nextval('revision_seq')
      WHERE (events.title, events.summary, events.starts_at, events.ends_at, events.location_text, events.status, events.image_url, events.publishable, events.series_size)
        IS DISTINCT FROM (excluded.title, excluded.summary, excluded.starts_at, excluded.ends_at, excluded.location_text, excluded.status, excluded.image_url, excluded.publishable, excluded.series_size)
      RETURNING id`;
    if (out) changed++;
  }
  const seen = rows.map((r) => r.externalId);
  const withdrawn = await sql`
    UPDATE events SET status = 'withdrawn', updated_at = now(), revision = nextval('revision_seq')
    WHERE source = 'myprincetonu' AND status = 'active' AND starts_at > now() AND external_id <> ALL(${seen})
    RETURNING id`;
  const duplicates = await markDuplicates(sql);
  return { fetched: rows.length, changed, withdrawn: withdrawn.length, duplicates };
}

/**
 * Listserv extractions that repeat an official event (same host or no host, start within 45
 * minutes, overlapping title words) become `duplicate` of the official record.
 */
export async function markDuplicates(sql: Sql): Promise<number> {
  const official = await sql`
    UPDATE events l SET status = 'duplicate', duplicate_of = o.id, updated_at = now(), revision = nextval('revision_seq')
    FROM events o
    WHERE l.source = 'listserv' AND l.status = 'active' AND o.source = 'myprincetonu' AND o.status = 'active'
      AND l.starts_at > now() - interval '1 day'
      AND abs(extract(epoch FROM l.starts_at - o.starts_at)) <= 2700
      AND (l.host_org_id IS NULL OR l.host_org_id = o.host_org_id)
      AND (
        l.host_org_id = o.host_org_id
        OR similarity_words(l.title, o.title) >= 0.5
      )
    RETURNING l.id`;
  // Reminder emails ("final call", "tomorrow!") re-announce the same event: keep the earliest
  // extraction and mark later ones as its duplicates.
  const reminders = await sql`
    UPDATE events l SET status = 'duplicate', duplicate_of = o.id, updated_at = now(), revision = nextval('revision_seq')
    FROM events o
    WHERE l.source = 'listserv' AND o.source = 'listserv' AND l.id <> o.id
      AND l.status = 'active' AND o.status = 'active'
      AND (o.created_at, o.id) < (l.created_at, l.id)
      AND l.starts_at > now() - interval '1 day'
      AND abs(extract(epoch FROM l.starts_at - o.starts_at)) <= 1800
      AND (l.host_org_id IS NULL OR o.host_org_id IS NULL OR l.host_org_id = o.host_org_id)
      AND (
        similarity_words(l.title, o.title) >= 0.4
        OR (l.host_org_id IS NOT NULL AND l.host_org_id = o.host_org_id AND l.location_id IS NOT DISTINCT FROM o.location_id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM events p WHERE p.id <> o.id AND p.source = 'listserv' AND p.status = 'active'
          AND (p.created_at, p.id) < (o.created_at, o.id)
          AND abs(extract(epoch FROM p.starts_at - o.starts_at)) <= 1800
          AND similarity_words(p.title, o.title) >= 0.4
      )
    RETURNING l.id`;
  return official.length + reminders.length;
}
