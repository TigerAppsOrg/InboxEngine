/** Standalone LISTSERV poller process. */
import { db, migrate, closeDb } from '../store/db.ts';
import { runPoller } from '../worker.ts';

const sql = db();
await migrate(sql);
const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
await runPoller(sql, abort.signal);
await closeDb();
