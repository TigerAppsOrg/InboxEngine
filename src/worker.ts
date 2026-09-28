/**
 * LISTSERV archive poller. Each cycle: read the newest RSS window per list, store new messages
 * as previews, then fetch full bodies + original headers for a bounded number of recent
 * previews, which triggers classification, cross-post reconciliation and event extraction.
 * Never sends mail.
 */
import { ListservClient } from './listserv/index.ts';
import { DEFAULT_LISTSERVS } from './core/index.ts';
import { ingestMessage, type IngestOptions } from './pipeline.ts';
import type { Sql } from './store/db.ts';
import { syncMpuEvents } from './sources/mpu-events.ts';

export type PollConfig = {
  lists: string[];
  rssLimit: number;
  bodiesPerList: number;
  bodyWindowDays: number;
};

export function pollConfigFromEnv(): PollConfig {
  return {
    lists: (process.env.LISTSERV_LISTS || DEFAULT_LISTSERVS.join(','))
      .split(',')
      .map((l) => l.trim().toUpperCase())
      .filter(Boolean),
    rssLimit: Number(process.env.RSS_LIMIT) || 100,
    bodiesPerList: Number(process.env.BODIES_PER_LIST) || 25,
    bodyWindowDays: Number(process.env.BODY_WINDOW_DAYS) || 14
  };
}

export type PollStats = { list: string; seen: number; created: number; bodies: number; events: number; error?: string };

export async function pollList(
  sql: Sql,
  client: ListservClient,
  list: string,
  config: PollConfig,
  options: IngestOptions = {}
): Promise<PollStats> {
  const stats: PollStats = { list, seen: 0, created: 0, bodies: 0, events: 0 };
  await sql`INSERT INTO sources (listserv, last_polled_at) VALUES (${list}, now())
            ON CONFLICT (listserv) DO UPDATE SET last_polled_at = now()`;
  try {
    const items = await client.fetchRss(list, config.rssLimit);
    stats.seen = items.length;
    const known = new Set(
      (await sql`SELECT archive_id FROM messages WHERE listserv = ${list} AND archive_id IN ${sql(items.map((i) => i.archiveId))}`).map(
        (r) => String(r.archiveId)
      )
    );
    for (const item of items) {
      if (known.has(item.archiveId)) continue;
      const out = await ingestMessage(
        sql,
        {
          listserv: list,
          archiveId: item.archiveId,
          sourceUrl: item.url,
          subject: item.subject,
          authorName: item.authorName,
          authorEmail: item.authorEmail,
          sentAt: new Date(item.date),
          bodyHtml: item.previewHtml,
          complete: false
        },
        options
      );
      if (out.created) stats.created++;
    }
    const pending = await sql`
      SELECT id, archive_id, source_url, subject, sender_name, sender_email, sent_at FROM messages
      WHERE listserv = ${list} AND complete = false AND source_url IS NOT NULL
        AND sent_at > now() - make_interval(days => ${config.bodyWindowDays})
      ORDER BY sent_at DESC LIMIT ${config.bodiesPerList}`;
    if (pending.length) await client.enableFullHeaders();
    for (const p of pending) {
      const full = await client.fetchMessage(String(p.sourceUrl));
      if (!full) continue;
      const out = await ingestMessage(
        sql,
        {
          listserv: list,
          archiveId: String(p.archiveId),
          sourceUrl: String(p.sourceUrl),
          subject: String(p.subject),
          authorName: String(p.senderName),
          authorEmail: String(p.senderEmail),
          sentAt: new Date(p.sentAt as string),
          bodyHtml: full.bodyHtml,
          bodyText: full.bodyPlain,
          complete: true,
          headers: full.headers,
          attachments: full.attachments
        },
        options
      );
      stats.bodies++;
      stats.events += out.events;
    }
    await sql`UPDATE sources SET last_success_at = now(), last_error = NULL, failures = 0 WHERE listserv = ${list}`;
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
    await sql`UPDATE sources SET last_error = ${stats.error.slice(0, 500)}, failures = failures + 1 WHERE listserv = ${list}`;
  }
  return stats;
}

/** Run forever with per-list exponential backoff; resolves when `signal` aborts. */
export async function runPoller(sql: Sql, signal: AbortSignal, config = pollConfigFromEnv()) {
  const client = new ListservClient();
  const interval = Math.max(15, Number(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000;
  const backoff = new Map<string, number>();
  const mpuEvery = Math.max(5, Number(process.env.MPU_EVENTS_INTERVAL_MINUTES) || 15) * 60_000;
  let nextMpu = 0;
  while (!signal.aborted) {
    const started = Date.now();
    if (process.env.MPU_EVENTS !== 'false' && Date.now() >= nextMpu) {
      try {
        const r = await syncMpuEvents(sql);
        console.log(`[mpu] ${r.fetched} official events (${r.changed} changed, ${r.withdrawn} withdrawn, ${r.duplicates} listserv duplicates)`);
        nextMpu = Date.now() + mpuEvery;
      } catch (error) {
        console.error(`[mpu] ${error instanceof Error ? error.message : error}`);
        nextMpu = Date.now() + mpuEvery / 3;
      }
    }
    for (const list of config.lists) {
      if (signal.aborted) break;
      if ((backoff.get(list) ?? 0) > Date.now()) continue;
      const stats = await pollList(sql, client, list, config);
      if (stats.error) {
        const [row] = await sql`SELECT failures FROM sources WHERE listserv = ${list}`;
        const failures = Number(row?.failures ?? 1);
        backoff.set(list, Date.now() + Math.min(30 * 60_000, interval * 2 ** Math.min(failures, 5)));
        console.error(`[poll] ${list}: ${stats.error} (retrying with backoff)`);
      } else {
        backoff.delete(list);
        if (stats.created || stats.bodies)
          console.log(`[poll] ${list}: +${stats.created} new, ${stats.bodies} bodies, ${stats.events} events`);
      }
    }
    const delay = Math.max(1000, interval - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
