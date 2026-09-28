/**
 * Read model shared by the HTTP API and the MCP server. All reads return canonical
 * (deduplicated) messages; aliases resolve to their canonical copy.
 */
import type { Sql } from './store/db.ts';
import {
  organizations,
  getOrganization,
  searchDirectory,
  organizationGroupUrl,
  organizationLogo,
  forumCategory,
  type Organization
} from './orgs/index.ts';
import { isResidential } from './core/index.ts';

const INBOX_ORIGIN = () => (process.env.INBOX_ORIGIN || 'https://inbox.tigerapps.org').replace(/\/$/, '');
const PUBLIC_ORIGIN = () => (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');

export type MessageFilters = {
  query?: string;
  organization?: string;
  sender?: string;
  listserv?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sort?: 'relevance' | 'newest' | 'oldest';
};

type Row = Record<string, unknown>;

function messageSummary(r: Row) {
  return {
    id: String(r.id),
    subject: String(r.subject),
    sender: String(r.senderName),
    senderEmail: String(r.senderEmail || ''),
    sentAt: new Date(r.sentAt as string).toISOString(),
    listservs: (r.lists as string[] | null) ?? [String(r.listserv)],
    organization: r.organizationId ? { id: String(r.organizationId), name: String(r.organizationName) } : null,
    category: r.category ?? null,
    preview: String(r.preview || ''),
    complete: !!r.complete,
    isEvent: (r.isEvent as boolean | null) ?? null,
    url: `${INBOX_ORIGIN()}/email/${r.id}`,
    archiveUrl: (r.sourceUrl as string) ?? null,
    revision: Number(r.revision)
  };
}

export async function searchMessages(sql: Sql, f: MessageFilters) {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 100);
  const offset = Math.min(Math.max(f.offset ?? 0, 0), 5000);
  const q = (f.query || '').trim();
  const list = (f.listserv || 'all').toUpperCase();
  const org = f.organization ? (getOrganization(f.organization) ?? searchDirectory(f.organization)[0]) : undefined;
  const rows = await sql`
    SELECT m.*, (SELECT array_agg(listserv ORDER BY listserv) FROM message_lists l WHERE l.message_id = m.id) AS lists,
      ${q ? sql`ts_rank(m.search, websearch_to_tsquery('english', ${q}))` : sql`0`} AS rank,
      count(*) OVER () AS total
    FROM messages m
    WHERE m.canonical_id IS NULL
      ${q ? sql`AND m.search @@ websearch_to_tsquery('english', ${q})` : sql``}
      ${org ? sql`AND m.organization_id = ${org.id}` : f.organization ? sql`AND false` : sql``}
      ${f.sender ? sql`AND (m.sender_name ILIKE ${'%' + f.sender + '%'} OR m.sender_email ILIKE ${'%' + f.sender + '%'})` : sql``}
      ${f.from ? sql`AND m.sent_at >= ${f.from}::timestamptz` : sql``}
      ${f.to ? sql`AND m.sent_at < ${f.to}::timestamptz + interval '1 day'` : sql``}
      ${
        list === 'ALL'
          ? sql``
          : list === 'RESIDENTIAL'
            ? sql`AND EXISTS (SELECT 1 FROM message_lists l WHERE l.message_id = m.id AND l.listserv IN ('WHITMANWIRE','BUTLERBUZZ','ROCKYWIRE','RE-INNFORMER','MATHEYMAIL','HUOHUB','YEHYELLOWPAGES'))`
            : sql`AND EXISTS (SELECT 1 FROM message_lists l WHERE l.message_id = m.id AND l.listserv = ${list})`
      }
    ORDER BY ${
      f.sort === 'oldest' ? sql`m.sent_at ASC` : q && f.sort !== 'newest' ? sql`rank DESC, m.sent_at DESC` : sql`m.sent_at DESC`
    }
    LIMIT ${limit} OFFSET ${offset}`;
  return {
    total: Number(rows[0]?.total ?? 0),
    offset,
    results: rows.map(messageSummary)
  };
}

export async function readMessages(sql: Sql, ids: string[], opts: { offset?: number; length?: number } = {}) {
  const rows = await sql`
    SELECT c.*, (SELECT array_agg(listserv ORDER BY listserv) FROM message_lists l WHERE l.message_id = c.id) AS lists
    FROM messages m JOIN messages c ON c.id = COALESCE(m.canonical_id, m.id)
    WHERE m.id IN ${sql(ids)}`;
  const seen = new Set<string>();
  const offset = opts.offset ?? 0;
  const length = opts.length ?? 12000;
  return rows
    .filter((r) => !seen.has(String(r.id)) && seen.add(String(r.id)))
    .map((r) => {
      const body = String(r.bodyText || '');
      return {
        ...messageSummary(r),
        body: body.slice(offset, offset + length),
        bodyLength: body.length,
        nextOffset: offset + length < body.length ? offset + length : null,
        links: (r.links as string[]) ?? [],
        media: (r.media as unknown[]) ?? [],
        organizationEvidence: (r.orgEvidence as { evidence?: string[] } | null)?.evidence ?? []
      };
    });
}

export async function messageChanges(sql: Sql, after: number, limit = 200) {
  const rows = await sql`
    SELECT m.*, (SELECT array_agg(listserv ORDER BY listserv) FROM message_lists l WHERE l.message_id = COALESCE(m.canonical_id, m.id)) AS lists
    FROM messages m WHERE m.revision > ${after} ORDER BY m.revision LIMIT ${Math.min(limit, 1000)}`;
  return {
    changes: rows.map((r) => ({
      ...messageSummary(r),
      canonicalId: (r.canonicalId as string) ?? null,
      bodyText: String(r.bodyText || ''),
      bodyHtml: (r.bodyHtml as string) ?? null,
      links: r.links,
      media: r.media,
      rfcMessageId: r.rfcMessageId ?? null,
      deliveryKey: r.deliveryKey ?? null,
      headersComplete: !!r.headersComplete,
      via: r.via ?? null,
      senderAttribution: r.senderAttribution ?? null,
      organizationConfidence: r.orgConfidence ?? null,
      organizationEvidence: (r.orgEvidence as { evidence?: string[] } | null)?.evidence ?? [],
      classifierVersion: r.classifierVersion ?? null
    })),
    next: rows.length ? Number(rows.at(-1)!.revision) : after
  };
}

// ── Events ──────────────────────────────────────────────

export type EventFilters = {
  from?: string;
  to?: string;
  organization?: string;
  tag?: string;
  query?: string;
  publishableOnly?: boolean;
  limit?: number;
  offset?: number;
};

function eventPayload(r: Row) {
  const hostId = (r.hostOrgId as string) ?? null;
  const host = hostId ? getOrganization(hostId) : undefined;
  return {
    id: String(r.id),
    status: String(r.status) as 'active' | 'withdrawn' | 'duplicate',
    title: String(r.title),
    summary: String(r.summary || ''),
    startsAt: new Date(r.startsAt as string).toISOString(),
    endsAt: r.endsAt ? new Date(r.endsAt as string).toISOString() : null,
    timePrecision: String(r.timePrecision) as 'exact' | 'date',
    location: {
      text: (r.locationText as string) ?? null,
      id: (r.locationId as string) ?? null,
      name: (r.locationName as string) ?? null,
      latitude: (r.latitude as number) ?? null,
      longitude: (r.longitude as number) ?? null,
      room: (r.room as string) ?? null,
      online: !!r.online
    },
    tags: (r.tags as string[]) ?? [],
    freeFood: !!r.freeFood,
    rsvpUrl: (r.rsvpUrl as string) ?? null,
    host: hostId ? organizationPayload(host, hostId, (r.hostOrgName as string) ?? null) : null,
    confidence: Number(r.confidence),
    publishable: !!r.publishable,
    extractionVersion: String(r.extractionVersion),
    imageUrl: (r.imageUrl as string) ?? null,
    series: r.seriesId ? { id: String(r.seriesId), size: Number(r.seriesSize) } : null,
    duplicateOf: (r.duplicateOf as string) ?? null,
    source:
      r.source === 'myprincetonu'
        ? {
            kind: 'myprincetonu' as const,
            messageId: null,
            subject: null,
            sender: (r.hostOrgName as string) ?? null,
            sentAt: null,
            listservs: [],
            url: (r.externalUrl as string) ?? null,
            archiveUrl: null
          }
        : {
            kind: 'listserv' as const,
            messageId: String(r.messageId),
            subject: String(r.subject ?? ''),
            sender: String(r.senderName ?? ''),
            sentAt: r.sentAt ? new Date(r.sentAt as string).toISOString() : null,
            listservs: (r.lists as string[]) ?? [],
            url: `${INBOX_ORIGIN()}/email/${r.messageId}`,
            archiveUrl: (r.sourceUrl as string) ?? null
          },
    updatedAt: new Date(r.updatedAt as string).toISOString(),
    revision: Number(r.revision)
  };
}

const EVENT_COLUMNS = (sql: Sql) => sql`
  e.*, m.subject, m.sender_name, m.sent_at, m.source_url,
  (SELECT array_agg(listserv ORDER BY listserv) FROM message_lists l WHERE l.message_id = e.message_id) AS lists`;

export async function listEvents(sql: Sql, f: EventFilters) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.min(Math.max(f.offset ?? 0, 0), 5000);
  const from = f.from ?? new Date(Date.now() - 3 * 3600_000).toISOString();
  const org = f.organization ? (getOrganization(f.organization) ?? searchDirectory(f.organization)[0]) : undefined;
  const rows = await sql`
    SELECT ${EVENT_COLUMNS(sql)}, count(*) OVER () AS total
    FROM events e LEFT JOIN messages m ON m.id = e.message_id
    WHERE e.status = 'active' AND COALESCE(e.ends_at, e.starts_at) >= ${from}::timestamptz
      ${f.to ? sql`AND e.starts_at < ${f.to}::timestamptz + interval '1 day'` : sql``}
      ${org ? sql`AND e.host_org_id = ${org.id}` : f.organization ? sql`AND false` : sql``}
      ${f.tag ? sql`AND ${f.tag} = ANY(e.tags)` : sql``}
      ${f.query ? sql`AND (e.title ILIKE ${'%' + f.query + '%'} OR e.summary ILIKE ${'%' + f.query + '%'} OR e.host_org_name ILIKE ${'%' + f.query + '%'})` : sql``}
      ${f.publishableOnly ? sql`AND e.publishable` : sql``}
    ORDER BY e.starts_at, e.id LIMIT ${limit} OFFSET ${offset}`;
  return { total: Number(rows[0]?.total ?? 0), offset, results: rows.map(eventPayload) };
}

export async function getEvent(sql: Sql, id: string) {
  const [row] = await sql`SELECT ${EVENT_COLUMNS(sql)} FROM events e LEFT JOIN messages m ON m.id = e.message_id WHERE e.id = ${id}`;
  return row ? eventPayload(row) : null;
}

/** Incremental feed for consumers: every insert/update/withdrawal after `after`, in order. */
export async function eventChanges(sql: Sql, after: number, limit = 200) {
  const rows = await sql`
    SELECT ${EVENT_COLUMNS(sql)} FROM events e LEFT JOIN messages m ON m.id = e.message_id
    WHERE e.revision > ${after} ORDER BY e.revision LIMIT ${Math.min(limit, 1000)}`;
  return { changes: rows.map(eventPayload), next: rows.length ? Number(rows.at(-1)!.revision) : after };
}

// ── Organizations ───────────────────────────────────────

export function organizationPayload(org: Organization | undefined, id: string, fallbackName: string | null = null) {
  const logo = org ? organizationLogo(org) : undefined;
  return {
    id,
    name: org?.name ?? fallbackName ?? id,
    aliases: org?.aliases ?? [],
    groupType: org?.groupType ?? null,
    categories: org?.categories ?? [],
    forumCategory: org ? forumCategory(org) : null,
    // MyPrincetonU "login" slugs are only acronyms when written that way (ACM, not ptonacm).
    acronym: org?.profile.acronym && /^[A-Z][A-Z0-9&-]{1,11}$/.test(org.profile.acronym) ? org.profile.acronym : null,
    tagline: org?.profile.tagline ?? null,
    description: org?.profile.description ?? null,
    whatWeDo: org?.profile.whatWeDo ?? null,
    website: org?.profile.website ?? null,
    contactEmail: org?.profile.email ?? null,
    socials: org
      ? Object.fromEntries(
          (['instagram', 'facebook', 'linkedin', 'twitter', 'youtube'] as const)
            .filter((k) => org.profile[k])
            .map((k) => [k, org.profile[k]!])
        )
      : {},
    memberCount: org?.profile.memberCount ?? null,
    websites: org?.urls ?? [],
    groupUrl: org ? (organizationGroupUrl(org) ?? null) : null,
    logoUrl: logo ? `${PUBLIC_ORIGIN()}/${logo.path}` : null,
    logoSourceUrl: logo?.sourceUrl ?? null
  };
}

export async function searchOrganizations(sql: Sql | null, query: string, limit = 20) {
  const matches = (query ? searchDirectory(query) : [...organizations]).slice(0, Math.min(limit, 1000));
  const counts = new Map<string, number>();
  if (sql && matches.length) {
    for (const r of await sql`
      SELECT organization_id, count(*)::int AS n FROM messages
      WHERE canonical_id IS NULL AND organization_id IN ${sql(matches.map((m) => m.id))} GROUP BY 1`)
      counts.set(String(r.organizationId), Number(r.n));
  }
  return matches.map((o) => ({ ...organizationPayload(o, o.id), emailCount: counts.get(o.id) ?? 0 }));
}

export async function status(sql: Sql) {
  const [m] = await sql`
    SELECT count(*) FILTER (WHERE canonical_id IS NULL)::int AS messages, count(*)::int AS copies,
      count(*) FILTER (WHERE complete AND canonical_id IS NULL)::int AS full_bodies,
      min(sent_at) AS earliest, max(sent_at) AS latest, max(ingested_at) AS last_ingested
    FROM messages`;
  const [e] = await sql`
    SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status = 'active' AND starts_at >= now())::int AS upcoming,
      count(*) FILTER (WHERE status = 'active' AND starts_at >= now() AND publishable)::int AS upcoming_publishable,
      count(*) FILTER (WHERE status = 'active' AND source = 'myprincetonu' AND starts_at >= now())::int AS upcoming_official,
      count(*) FILTER (WHERE status = 'duplicate')::int AS duplicates_of_official
    FROM events`;
  const sources = await sql`SELECT * FROM sources ORDER BY listserv`;
  return {
    messages: { ...m, residentialNote: 'Residential lists cross-post; counts are deduplicated.' },
    events: e,
    organizations: organizations.length,
    sources: sources.map((s) => ({ ...s, residential: isResidential(String(s.listserv)) }))
  };
}
