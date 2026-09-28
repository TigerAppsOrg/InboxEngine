/** HTTP API + MCP. Set RUN_WORKER=true to run the LISTSERV poller in the same process. */
import { serve } from '@hono/node-server';
import { db, migrate, closeDb } from '../store/db.ts';
import { createApp } from './http.ts';
import { runPoller } from '../worker.ts';

const sql = db();
const ran = await migrate(sql);
if (ran.length) console.log(`[db] applied ${ran.join(', ')}`);
const port = Number(process.env.PORT) || 8300;
const server = serve({ fetch: createApp(sql).fetch, port, hostname: process.env.HOST || '127.0.0.1' });
console.log(`[http] InboxEngine listening on ${process.env.HOST || '127.0.0.1'}:${port}`);

const abort = new AbortController();
const worker = process.env.RUN_WORKER === 'true' ? runPoller(sql, abort.signal) : Promise.resolve();
const stop = async () => {
  abort.abort();
  server.close();
  await worker;
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
