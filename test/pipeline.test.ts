/** Integration test; runs only when TEST_DATABASE_URL points at a disposable database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;

test('ingest merges residential cross-posts and extracts once', { skip: !url }, async () => {
  process.env.DATABASE_URL = url;
  const { db, migrate, closeDb } = await import('../src/store/db.ts');
  const { ingestMessage } = await import('../src/pipeline.ts');
  const sql = db();
  await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.simple();
  await migrate(sql);
  const headers = {
    identityFields: ['A <a@princeton.edu>', '', 'Study break', '2026-09-28T14:00:00.000Z'] as [string, string, string, string],
    rfcMessageId: 'x1@princeton.edu',
    recipientLists: ['BUTLERBUZZ', 'WHITMANWIRE'],
    headersComplete: true
  };
  const base = {
    subject: 'Free boba study break tonight',
    authorName: 'A',
    authorEmail: 'a@princeton.edu',
    sentAt: new Date('2026-09-28T14:00:00Z'),
    bodyHtml: '<p>Free boba tonight at 9pm in Frist MPR!</p>',
    complete: true,
    headers
  };
  const now = new Date('2026-09-28T15:00:00Z');
  const a = await ingestMessage(sql, { ...base, listserv: 'WHITMANWIRE', archiveId: 'w1' }, { now });
  const b = await ingestMessage(sql, { ...base, listserv: 'BUTLERBUZZ', archiveId: 'b1' }, { now });
  assert.equal(b.canonicalId, a.id);
  const events = await sql`SELECT * FROM events WHERE status = 'active'`;
  assert.equal(events.length, 1);
  assert.equal(events[0].locationId, 'frist-campus-center');
  const lists = await sql`SELECT listserv FROM message_lists WHERE message_id = ${a.id} ORDER BY 1`;
  assert.deepEqual(lists.map((l) => l.listserv), ['BUTLERBUZZ', 'WHITMANWIRE']);
  // Re-ingesting a preview never downgrades the full body.
  await ingestMessage(sql, { ...base, listserv: 'WHITMANWIRE', archiveId: 'w1', bodyHtml: '<p>Free boba…</p>', complete: false }, { now });
  const [row] = await sql`SELECT complete, body_text FROM messages WHERE id = ${a.id}`;
  assert.ok(row.complete && String(row.bodyText).includes('Frist MPR'));
  await closeDb();
});
void postgres;
