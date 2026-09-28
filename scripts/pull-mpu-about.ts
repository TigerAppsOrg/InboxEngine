/**
 * Enrich a pull-mpu-directory output with each group's public "about" text and social links.
 * Officer arrays in the response are discarded, never written.
 *   MPU_COOKIE=… npx tsx scripts/pull-mpu-about.ts <raw.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
const cookie = process.env.MPU_COOKIE;
const file = process.argv[2];
if (!cookie || !file) throw new Error('MPU_COOKIE and <raw.json> are required');
const raw = JSON.parse(readFileSync(file, 'utf8')) as { clubs: Record<string, unknown>[] };
const FIELDS = ['mission', 'whatWeDo', 'goals', 'tagline', 'websiteUrl', 'facebook', 'twitter', 'linkedin', 'youtube', 'instagram', 'discord', 'email'];
let done = 0;
const queue = [...raw.clubs];
async function worker() {
  for (let club = queue.shift(); club; club = queue.shift()) {
    try {
      const res = await fetch(`https://my.princeton.edu/mobile_ws/v18/mobile_club_about?id=${club.id}`, {
        headers: { Cookie: cookie!, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(30_000)
      });
      const about = ((await res.json()) as { club?: Record<string, unknown> }).club ?? {};
      for (const f of FIELDS) if (about[f] != null && about[f] !== '') club[f] = about[f];
    } catch {
      club.aboutError = true;
    }
    if (++done % 100 === 0) console.log(`  ${done}/${raw.clubs.length}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
await Promise.all([worker(), worker()]);
writeFileSync(file, JSON.stringify(raw, null, 1));
console.log('enriched', done);
