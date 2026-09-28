/**
 * Source-agnostic ingestion: normalize → attribute sender → classify organization →
 * reconcile cross-posts → extract events → persist. Every source (LISTSERV archive poller,
 * TigerInbox JSON backfill, push API) funnels through ingestMessage().
 */
import { createHash } from 'node:crypto';
import {
  messageId,
  deliveryKey,
  readableText,
  messagePreview,
  extractLinks,
  extractMedia,
  resolveSender,
  isResidential,
  type HeaderIdentity
} from './core/index.ts';
import { classifyMessage, CLASSIFIER_VERSION, classificationFingerprint } from './orgs/index.ts';
import { extractEvents, extractorMode, type ExtractionResult } from './events/index.ts';
import type { Sql } from './store/db.ts';
import { markDuplicates } from './sources/mpu-events.ts';

export type RawMessage = {
  listserv: string;
  archiveId: string;
  sourceUrl?: string | null;
  subject: string;
  authorName: string;
  authorEmail: string;
  sentAt: Date;
  bodyHtml?: string | null;
  bodyText?: string | null;
  /** True when the body is the full message, not an RSS preview. */
  complete: boolean;
  headers?: HeaderIdentity | null;
  attachments?: { url: string; type: string }[];
  viaHoagie?: boolean;
};

export type IngestOptions = {
  /** Only extract events for mail sent within this many days (bounds backfill cost). */
  extractWithinDays?: number;
  extractor?: (input: Parameters<typeof extractEvents>[0]) => Promise<ExtractionResult>;
  now?: Date;
};

export type IngestOutcome = { id: string; canonicalId: string; created: boolean; extracted: boolean; events: number };

const eventId = (message: string, idx: number) =>
  createHash('sha256').update(`${message}#${idx}`).digest('hex').slice(0, 24);

export async function ingestMessage(sql: Sql, raw: RawMessage, options: IngestOptions = {}): Promise<IngestOutcome> {
  const list = raw.listserv.toUpperCase();
  const id = messageId(list, raw.archiveId);
  const subject = (raw.subject || '(No subject)').replace(new RegExp(`^\\[${list}\\]\\s*`, 'i'), '').trim() || '(No subject)';
  const [existing] = await sql`SELECT * FROM messages WHERE id = ${id}`;

  // Never downgrade a full body to an RSS preview.
  const keepBody = !!existing?.complete && !raw.complete;
  const bodyHtml = keepBody ? (existing.bodyHtml as string | null) : (raw.bodyHtml ?? null);
  const bodyText = keepBody ? String(existing.bodyText) : readableText(raw.bodyText || '', bodyHtml);
  const complete = keepBody || raw.complete;
  const sender = resolveSender({
    name: raw.authorName,
    email: raw.authorEmail,
    bodyHtml,
    body: bodyText,
    viaHoagie: raw.viaHoagie || existing?.via === 'HoagieMail'
  });
  const classInput = { subject, body: bodyText, sender: sender.name, senderEmail: sender.email, listserv: list };
  const unchanged =
    existing &&
    existing.classifierVersion === CLASSIFIER_VERSION &&
    existing.subject === subject &&
    existing.bodyText === bodyText &&
    existing.complete === complete &&
    (!raw.headers?.rfcMessageId || existing.rfcMessageId === raw.headers.rfcMessageId) &&
    (existing.orgEvidence as { hash?: string } | null)?.hash === classificationFingerprint(classInput);
  const classification = classifyMessage(classInput);
  const headers = raw.headers ?? null;
  const key = complete && headers && bodyHtml ? deliveryKey(headers, bodyHtml) : null;

  if (!unchanged) {
    const row = {
      id,
      listserv: list,
      archiveId: raw.archiveId,
      sourceUrl: raw.sourceUrl ?? null,
      subject,
      senderName: sender.name,
      senderEmail: sender.email,
      via: sender.via,
      senderAttribution: sender.attribution,
      sentAt: raw.sentAt,
      preview: messagePreview(bodyText, bodyHtml),
      bodyText,
      bodyHtml,
      complete,
      links: sql.json(bodyHtml ? extractLinks(bodyHtml) : ((existing?.links as string[]) ?? [])),
      media: sql.json(
        (keepBody ? existing?.media : bodyHtml ? extractMedia(bodyHtml, raw.attachments ?? []) : existing?.media ?? []) as never
      ),
      rfcMessageId: headers?.rfcMessageId ?? existing?.rfcMessageId ?? null,
      deliveryKey: key ?? existing?.deliveryKey ?? null,
      headersComplete: !!headers?.headersComplete || !!existing?.headersComplete,
      category: classification.category,
      organizationId: classification.organizationId,
      organizationName: classification.organizationId ? classification.organization : null,
      orgConfidence: classification.confidence,
      orgEvidence: sql.json({ evidence: classification.evidence, hash: classification.inputHash }),
      classifierVersion: classification.version
    };
    await sql`
      INSERT INTO messages ${sql(row)}
      ON CONFLICT (id) DO UPDATE SET
        source_url = excluded.source_url, subject = excluded.subject, sender_name = excluded.sender_name,
        sender_email = excluded.sender_email, via = excluded.via, sender_attribution = excluded.sender_attribution,
        sent_at = excluded.sent_at, preview = excluded.preview, body_text = excluded.body_text,
        body_html = excluded.body_html, complete = excluded.complete, links = excluded.links, media = excluded.media,
        rfc_message_id = excluded.rfc_message_id, delivery_key = excluded.delivery_key,
        headers_complete = excluded.headers_complete, category = excluded.category,
        organization_id = excluded.organization_id, organization_name = excluded.organization_name,
        org_confidence = excluded.org_confidence, org_evidence = excluded.org_evidence,
        classifier_version = excluded.classifier_version, updated_at = now(), revision = nextval('revision_seq')`;
  }

  const canonicalId = await reconcile(sql, id, list, headers);
  const outcome: IngestOutcome = { id, canonicalId, created: !existing, extracted: false, events: 0 };

  // Extract once per canonical message with a full body, and again only when the body or
  // extractor version changes.
  const [row] = await sql`SELECT * FROM messages WHERE id = ${canonicalId}`;
  const now = options.now ?? new Date();
  const withinDays = options.extractWithinDays ?? Number(process.env.EXTRACT_WITHIN_DAYS || 45);
  const recent = now.getTime() - new Date(row.sentAt as string).getTime() <= withinDays * 86400_000;
  const mode = extractorMode();
  const needs =
    row.complete && recent && (!row.extractionVersion || !String(row.extractionVersion).startsWith(mode === 'llm' ? 'llm' : 'rules') || !unchanged);
  if (needs) {
    const extractor = options.extractor ?? ((input) => extractEvents(input, mode));
    const result = await extractor({
      subject: String(row.subject),
      body: String(row.bodyText),
      sentAt: new Date(row.sentAt as string),
      links: row.links as string[],
      listserv: String(row.listserv),
      organizationId: (row.organizationId as string) ?? null,
      organizationName: (row.organizationName as string) ?? null
    });
    await saveExtraction(sql, canonicalId, result);
    if (result.events.length) await markDuplicates(sql);
    outcome.extracted = true;
    outcome.events = result.events.length;
  }
  return outcome;
}

/** Merge residential cross-posts on RFC Message-ID, or deliveryKey within 120 s. */
async function reconcile(sql: Sql, id: string, list: string, headers: HeaderIdentity | null): Promise<string> {
  const [me] = await sql`SELECT id, canonical_id, rfc_message_id, delivery_key, sent_at, complete FROM messages WHERE id = ${id}`;
  let canonical = (me.canonicalId as string) ?? id;
  if (!me.canonicalId && isResidential(list) && (me.rfcMessageId || me.deliveryKey)) {
    const [match] = await sql`
      SELECT COALESCE(canonical_id, id) AS root FROM messages
      WHERE id <> ${id} AND listserv <> ${list}
        AND (
          (${me.rfcMessageId as string | null}::text IS NOT NULL AND rfc_message_id = ${me.rfcMessageId as string | null})
          OR (${me.deliveryKey as string | null}::text IS NOT NULL AND delivery_key = ${me.deliveryKey as string | null}
              AND abs(extract(epoch FROM sent_at - ${me.sentAt as string}::timestamptz)) <= 120)
        )
      ORDER BY ingested_at, id LIMIT 1`;
    if (match && match.root !== id) {
      canonical = String(match.root);
      await sql`UPDATE messages SET canonical_id = ${canonical}, updated_at = now(), revision = nextval('revision_seq') WHERE id = ${id} OR canonical_id = ${id}`;
      await sql`UPDATE events SET status = 'withdrawn', updated_at = now(), revision = nextval('revision_seq') WHERE message_id = ${id} AND status = 'active'`;
      // The canonical copy inherits the best body.
      if (me.complete)
        await sql`
          UPDATE messages c SET body_text = m.body_text, body_html = m.body_html, links = m.links, media = m.media,
            complete = true, updated_at = now(), revision = nextval('revision_seq')
          FROM messages m WHERE c.id = ${canonical} AND m.id = ${id} AND c.complete = false`;
    }
  }
  const lists = [list, ...(headers?.recipientLists ?? []).filter(isResidential)];
  for (const l of new Set(lists))
    await sql`INSERT INTO message_lists (message_id, listserv) VALUES (${canonical}, ${l}) ON CONFLICT DO NOTHING`;
  return canonical;
}

export async function saveExtraction(sql: Sql, messageIdValue: string, result: ExtractionResult) {
  await sql.begin(async (tx) => {
    for (const [idx, e] of result.events.entries()) {
      const row = {
        id: eventId(messageIdValue, idx),
        messageId: messageIdValue,
        idx,
        status: 'active',
        title: e.title,
        summary: e.summary,
        startsAt: new Date(e.startsAt),
        endsAt: e.endsAt ? new Date(e.endsAt) : null,
        timePrecision: e.timePrecision,
        locationText: e.locationText,
        locationId: e.locationId,
        locationName: e.locationName,
        latitude: e.latitude,
        longitude: e.longitude,
        room: e.room,
        online: e.online,
        tags: e.tags as string[],
        freeFood: e.freeFood,
        rsvpUrl: e.rsvpUrl,
        hostOrgId: e.hostOrganizationId,
        hostOrgName: e.hostOrganizationName,
        confidence: e.confidence,
        publishable: e.publishable,
        extractionVersion: result.version
      };
      await tx`
        INSERT INTO events ${tx(row)}
        ON CONFLICT (message_id, idx) DO UPDATE SET
          status = CASE WHEN events.status = 'duplicate' THEN 'duplicate' ELSE 'active' END, title = excluded.title, summary = excluded.summary, starts_at = excluded.starts_at,
          ends_at = excluded.ends_at, time_precision = excluded.time_precision, location_text = excluded.location_text,
          location_id = excluded.location_id, location_name = excluded.location_name, latitude = excluded.latitude,
          longitude = excluded.longitude, room = excluded.room, online = excluded.online, tags = excluded.tags,
          free_food = excluded.free_food, rsvp_url = excluded.rsvp_url, host_org_id = excluded.host_org_id,
          host_org_name = excluded.host_org_name, confidence = excluded.confidence, publishable = excluded.publishable,
          extraction_version = excluded.extraction_version, updated_at = now(), revision = nextval('revision_seq')`;
    }
    await tx`
      UPDATE events SET status = 'withdrawn', updated_at = now(), revision = nextval('revision_seq')
      WHERE message_id = ${messageIdValue} AND idx >= ${result.events.length} AND status = 'active'`;
    await tx`
      UPDATE messages SET extraction_version = ${result.version}, extraction_method = ${result.method},
        is_event = ${result.isEventAnnouncement}, extraction_notes = ${tx.json(result.notes)},
        updated_at = now(), revision = nextval('revision_seq')
      WHERE id = ${messageIdValue}`;
  });
}
