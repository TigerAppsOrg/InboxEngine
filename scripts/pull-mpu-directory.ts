/**
 * One-time (or occasional) refresh of organization metadata from MyPrincetonU (CampusGroups).
 * Requires a signed-in session cookie; never commit it:
 *   MPU_COOKIE='cg_uid=…; CG.SessionID=…' npx tsx scripts/pull-mpu-directory.ts <raw-out.json>
 * Writes only organization-level fields. Officer/member rosters are deliberately NOT fetched.
 */
import { writeFileSync } from 'node:fs';

const cookie = process.env.MPU_COOKIE;
if (!cookie) throw new Error('MPU_COOKIE is required');
const out = process.argv[2];
if (!out) throw new Error('Usage: pull-mpu-directory <raw-out.json>');

const KEEP = [
  'id', 'name', 'login', 'email', 'published', 'hideFromGroupsList', 'deleted', 'websiteUrl', 'tagline', 'mission',
  'whatWeDo', 'goals', 'facebook', 'twitter', 'linkedin', 'youtube', 'instagram', 'discord', 'groupTypeValue',
  'categories', 'logoFileName', 'logoSubFolder', 'coverFileName', 'coverSubFolder', 'parentClubId', 'parentClubName',
  'countMembers', 'countOfficers', 'countEvents', 'updatedOn', 'createdOn'
] as const;

const rows: Record<string, unknown>[] = [];
for (let page = 1; page < 100; page++) {
  const res = await fetch(`https://my.princeton.edu/mobile_ws/v18/mobile_clubs_listing?page=${page}&pageSize=100`, {
    headers: { Cookie: cookie, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(30_000)
  });
  const data = (await res.json()) as { data?: Record<string, unknown>[] };
  if (!data.data?.length) break;
  for (const club of data.data) rows.push(Object.fromEntries(KEEP.map((k) => [k, club[k] ?? null])));
  await new Promise((r) => setTimeout(r, 300));
}
writeFileSync(out, JSON.stringify({ retrievedAt: new Date().toISOString(), clubs: rows }, null, 1));
console.log(`Saved ${rows.length} groups to ${out}`);
