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
  let calls = 0;
  const { extractWithRules } = await import('../src/events/index.ts');
  const extractor = async (input: Parameters<typeof extractWithRules>[0]) => (calls++, extractWithRules(input));
  const a = await ingestMessage(sql, { ...base, listserv: 'WHITMANWIRE', archiveId: 'w1' }, { now, extractor });
  const b = await ingestMessage(sql, { ...base, listserv: 'BUTLERBUZZ', archiveId: 'b1' }, { now, extractor });
  assert.equal(b.canonicalId, a.id);
  assert.equal(calls, 1, 'a cross-posted copy must not re-run extraction');
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

test('reminder emails for the same event collapse to the first announcement', { skip: !url }, async () => {
  process.env.DATABASE_URL = url;
  const { db, closeDb } = await import('../src/store/db.ts');
  const { ingestMessage } = await import('../src/pipeline.ts');
  const sql = db();
  const now = new Date('2026-09-28T15:00:00Z');
  const mk = (id: string, subject: string, sentAt: string) => ({
    listserv: 'FREEFOOD', archiveId: id, subject, authorName: 'MealMates', authorEmail: 'm@princeton.edu',
    sentAt: new Date(sentAt), bodyHtml: '<p>MealMates dinner tonight at 5:30pm in Whitman College. Free food!</p>', complete: true
  });
  await ingestMessage(sql, mk('r1', 'MealMates Dinner tonight', '2026-09-28T13:00:00Z'), { now });
  await ingestMessage(sql, mk('r2', 'REMINDER: MealMates Dinner tonight', '2026-09-28T14:00:00Z'), { now });
  const active = await sql`SELECT title FROM events WHERE status = 'active' AND title ILIKE '%MealMates%'`;
  const dupes = await sql`SELECT duplicate_of FROM events WHERE status = 'duplicate' AND title ILIKE '%MealMates%'`;
  assert.equal(active.length, 1);
  assert.equal(dupes.length, 1);
  await closeDb();
});
