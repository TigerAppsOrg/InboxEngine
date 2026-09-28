import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';

export type Sql = postgres.Sql<Record<string, unknown>>;

let shared: Sql | undefined;

/** Shared connection pool. DATABASE_URL is required (e.g. postgres://…/inbox_engine). */
export function db(): Sql {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    shared = postgres(url, {
      max: Number(process.env.DATABASE_POOL_SIZE) || 10,
      idle_timeout: 30,
      onnotice: () => {},
      transform: postgres.camel
    });
  }
  return shared;
}

export async function closeDb() {
  await shared?.end({ timeout: 5 });
  shared = undefined;
}

/** Apply pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(sql = db()): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const dir = new URL('./migrations/', import.meta.url);
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => String(r.name)));
  const ran: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const text = readFileSync(new URL(name, dir), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    ran.push(name);
  }
  return ran;
}
