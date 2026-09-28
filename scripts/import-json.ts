/**
 * Backfill from TigerInbox/Forum scraper JSON archives (data/<list>.json from sync_listserv.py):
 *   npm run import:json -- ../TigerMail/data/whitmanwire.json [...more files]
 * Idempotent. Events are extracted only for mail inside EXTRACT_WITHIN_DAYS (default 45).
 */
import { readFileSync } from 'node:fs';
import { db, migrate, closeDb } from '../src/store/db.ts';
import { ingestMessage } from '../src/pipeline.ts';
import type { HeaderIdentity } from '../src/core/index.ts';

type ArchiveJson = { listserv?: string; messages?: Record<string, any>[] };

const sql = db();
await migrate(sql);
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as ArchiveJson;
  let n = 0;
  let events = 0;
  for (const m of data.messages ?? []) {
    const list = String(m.listserv || data.listserv || '').toUpperCase();
    const sentAt = new Date(m.date);
    if (!list || !m.message_id || !Number.isFinite(sentAt.getTime())) continue;
    const fields = (m.identity_fields as string[]) ?? ['', '', '', ''];
    const headers: HeaderIdentity | null = m.rfc_message_id
      ? {
          identityFields: [fields[0] ?? '', fields[1] ?? '', fields[2] ?? '', fields[3] ?? ''],
          rfcMessageId: m.rfc_message_id,
          recipientLists: m.recipient_lists ?? [],
          headersComplete: !!m.headers_complete
        }
      : null;
    const out = await ingestMessage(sql, {
      listserv: list,
      archiveId: String(m.message_id),
      sourceUrl: m.listserv_url ?? null,
      subject: String(m.subject || ''),
      authorName: String(m.hoagiemail_sender_name || m.author_name || ''),
      authorEmail: String(m.hoagiemail_sender_email || m.author_email || ''),
      sentAt,
      bodyHtml: m.body_html ?? null,
      bodyText: m.body_text ?? null,
      complete: !!m.body_complete,
      headers,
      viaHoagie: !!m.is_hoagiemail
    });
    events += out.events;
    if (++n % 1000 === 0) console.log(`  ${file}: ${n} messages…`);
  }
  console.log(`${file}: imported ${n} messages, extracted ${events} events`);
}
await closeDb();
