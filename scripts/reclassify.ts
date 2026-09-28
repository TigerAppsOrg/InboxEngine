/**
 * Re-run organization classification for messages labelled by an older classifier version.
 * Idempotent and local (no network); deploys run it after migrations.
 */
import { db, closeDb } from '../src/store/db.ts';
import { classifyMessage, CLASSIFIER_VERSION } from '../src/orgs/index.ts';

const sql = db();
let changed = 0;
let seen = 0;
for (;;) {
  const rows = await sql`
    SELECT id, subject, body_text, sender_name, sender_email, listserv, organization_id FROM messages
    WHERE classifier_version IS DISTINCT FROM ${CLASSIFIER_VERSION} ORDER BY id LIMIT 1000`;
  if (!rows.length) break;
  for (const r of rows) {
    const c = classifyMessage({
      subject: String(r.subject),
      body: String(r.bodyText || ''),
      sender: String(r.senderName || ''),
      senderEmail: String(r.senderEmail || ''),
      listserv: String(r.listserv)
    });
    if (c.organizationId !== r.organizationId) changed++;
    await sql`
      UPDATE messages SET category = ${c.category}, organization_id = ${c.organizationId},
        organization_name = ${c.organizationId ? c.organization : null}, org_confidence = ${c.confidence},
        org_evidence = ${sql.json({ evidence: c.evidence, hash: c.inputHash })}, classifier_version = ${c.version},
        updated_at = now(), revision = nextval('revision_seq')
      WHERE id = ${String(r.id)}`;
    seen++;
  }
}
console.log(`Reclassified ${seen} messages (${changed} changed organization) to ${CLASSIFIER_VERSION}.`);
await closeDb();
