import { db, migrate, closeDb } from './db.ts';
const ran = await migrate(db());
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
await closeDb();
