/** Local agents: the same read-only tools over stdio. Stdout is reserved for the protocol. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { db, closeDb } from '../store/db.ts';
import { createMcpServer } from './mcp.ts';

const sql = db();
const server = createMcpServer(sql);
await server.connect(new StdioServerTransport());
process.on('SIGINT', async () => {
  await server.close();
  await closeDb();
  process.exit(0);
});
