/**
 * HTTP API. Every /v1 and /mcp route requires `Authorization: Bearer <token>` where tokens are
 * configured per client: API_TOKENS="forum:<secret>,tigerinbox:<secret>,pi:<secret>".
 * Organization logos are public static assets.
 */
import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Sql } from '../store/db.ts';
import {
  searchMessages,
  readMessages,
  messageChanges,
  listEvents,
  getEvent,
  eventChanges,
  searchOrganizations,
  organizationPayload,
  status
} from '../queries.ts';
import { getOrganization } from '../orgs/index.ts';
import { campusLocations } from '../events/index.ts';
import { analyzeEmail } from '../analyze.ts';
import { createMcpServer } from './mcp.ts';
import { ListservClient } from '../listserv/index.ts';
import { ingestMessage } from '../pipeline.ts';

type Env = { Variables: { client: string } };

const digest = (value: string) => createHash('sha256').update(value).digest();

export function parseTokens(spec = process.env.API_TOKENS || ''): Map<string, Buffer> {
  const tokens = new Map<string, Buffer>();
  for (const pair of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf(':');
    const name = pair.slice(0, at).trim();
    const secret = pair.slice(at + 1).trim();
    if (at < 1 || secret.length < 24) throw new Error(`API_TOKENS entry for "${name || '?'}" needs name:secret (≥24 chars)`);
    tokens.set(name, digest(secret));
  }
  return tokens;
}

export function createApp(sql: Sql, tokens = parseTokens()) {
  const app = new Hono<Env>();
  const windows = new Map<string, { start: number; count: number }>();
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE) || 600;

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  });

  app.get('/organization-logos/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[0-9]+-[a-f0-9]{6,}\.webp$/.test(file)) return c.notFound();
    try {
      const bytes = await readFile(new URL(`../../assets/logos/${file}`, import.meta.url));
      return c.body(bytes, 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, immutable' });
    } catch {
      return c.notFound();
    }
  });

  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const hash = digest(token);
    let client: string | undefined;
    for (const [name, expected] of tokens) if (timingSafeEqual(hash, expected)) client = name;
    if (!token || !client)
      return c.json({ error: 'A valid InboxEngine client token is required' }, 401, { 'WWW-Authenticate': 'Bearer realm="InboxEngine"' });
    const now = Date.now();
    let w = windows.get(client);
    if (!w || now - w.start > 60_000) windows.set(client, (w = { start: now, count: 0 }));
    if (++w.count > perMinute) return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
    c.set('client', client);
    await next();
  };
  app.use('/v1/*', authed);
  app.use('/mcp', authed);

  const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

  app.get('/v1/status', async (c) => c.json(await status(sql)));

  app.get('/v1/messages', async (c) => {
    const q = c.req.query();
    return c.json(
      await searchMessages(sql, {
        query: q.q,
        organization: q.organization,
        sender: q.sender,
        listserv: q.listserv,
        from: q.from,
        to: q.to,
        sort: q.sort as never,
        limit: int(q.limit, 20),
        offset: int(q.offset, 0)
      })
    );
  });
  app.get('/v1/messages/changes', async (c) => c.json(await messageChanges(sql, int(c.req.query('after'), 0), int(c.req.query('limit'), 200))));
  // Full bodies are fetched from the LISTSERV archive on demand (as TigerInbox does) when a
  // reader opens a message that was only stored as an RSS preview. Bounded concurrency.
  let listserv: ListservClient | undefined;
  let inflight = 0;
  const completeBody = async (id: string) => {
    if (inflight >= 3) return;
    const [row] = await sql`SELECT m.* FROM messages m JOIN messages c ON c.id = COALESCE(m.canonical_id, m.id) WHERE c.id = ${id} AND m.source_url IS NOT NULL ORDER BY m.ingested_at LIMIT 1`;
    if (!row || row.complete) return;
    listserv ??= new ListservClient();
    if (!listserv.configured) return;
    inflight++;
    try {
      const full = await listserv.fetchMessage(String(row.sourceUrl));
      if (!full) return;
      await ingestMessage(
        sql,
        {
          listserv: String(row.listserv),
          archiveId: String(row.archiveId),
          sourceUrl: String(row.sourceUrl),
          subject: String(row.subject),
          authorName: String(row.senderName),
          authorEmail: String(row.senderEmail),
          sentAt: new Date(row.sentAt as string),
          bodyHtml: full.bodyHtml,
          bodyText: full.bodyPlain,
          complete: true,
          headers: full.headers,
          attachments: full.attachments,
          viaHoagie: row.via === 'HoagieMail'
        },
        {}
      );
    } catch (error) {
      console.error('[http] full body fetch failed', error instanceof Error ? error.message : error);
    } finally {
      inflight--;
    }
  };

  app.get('/v1/messages/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[a-f0-9]{24}$/.test(id)) return c.notFound();
    let [message] = await readMessages(sql, [id], { length: 1_000_000 });
    if (message && !message.complete && c.req.query('full') !== 'false') {
      await completeBody(message.id);
      [message] = await readMessages(sql, [id], { length: 1_000_000 });
    }
    return message ? c.json(message) : c.notFound();
  });

  app.get('/v1/events', async (c) => {
    const q = c.req.query();
    return c.json(
      await listEvents(sql, {
        from: q.from,
        to: q.to,
        organization: q.organization,
        tag: q.tag,
        query: q.q,
        publishableOnly: q.publishable === 'true',
        limit: int(q.limit, 50),
        offset: int(q.offset, 0)
      })
    );
  });
  app.get('/v1/events/changes', async (c) => c.json(await eventChanges(sql, int(c.req.query('after'), 0), int(c.req.query('limit'), 200))));
  app.get('/v1/events/:id', async (c) => {
    const event = await getEvent(sql, c.req.param('id'));
    return event ? c.json(event) : c.notFound();
  });

  app.get('/v1/organizations', async (c) =>
    c.json({ organizations: await searchOrganizations(sql, c.req.query('q') || '', int(c.req.query('limit'), 1000)) })
  );
  app.get('/v1/organizations/:id', (c) => {
    const org = getOrganization(c.req.param('id'));
    return org ? c.json(organizationPayload(org, org.id)) : c.notFound();
  });
  app.get('/v1/locations', (c) => c.json({ locations: campusLocations }));

  const AnalyzeBody = z.object({
    subject: z.string().max(500),
    body: z.string().max(200_000),
    sentAt: z.string(),
    senderName: z.string().max(200).optional(),
    senderEmail: z.string().max(200).optional(),
    listserv: z.string().max(40).optional()
  });
  app.post('/v1/analyze', async (c) => {
    const parsed = AnalyzeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
    return c.json(await analyzeEmail(parsed.data));
  });

  // Stateless Streamable HTTP MCP endpoint.
  app.post('/mcp', async (c) => {
    if (c.req.header('origin')) return c.json({ error: 'Browser origins are not allowed' }, 403);
    const text = await c.req.text();
    if (text.length > 256_000) return c.json({ error: 'Request too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const server = createMcpServer(sql);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } finally {
      await server.close();
    }
  });
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));

  app.onError((error, c) => {
    console.error('[http]', error);
    return c.json({ error: 'Internal error' }, 500);
  });
  return app;
}
