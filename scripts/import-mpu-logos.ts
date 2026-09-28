/**
 * Download public MyPrincetonU group logos (no cookies) and write 256px WebP files to
 * assets/organization-logos/ plus src/orgs/data/logos.json. Input: pull-mpu-directory output.
 *   npx tsx scripts/import-mpu-logos.ts <raw.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const raw = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { clubs: Record<string, any>[] };
const dir = new URL('../assets/logos/', import.meta.url);
mkdirSync(dir, { recursive: true });
const logosPath = new URL('../src/orgs/data/logos.json', import.meta.url);
const logos: Record<string, { src: string; sourceUrl: string }> = {};
const GENERIC = /default|placeholder|no[-_]?image/i;
let saved = 0;
const queue = raw.clubs.filter((c) => c.logoFileName && !GENERIC.test(c.logoFileName));
async function worker() {
  for (let club = queue.shift(); club; club = queue.shift()) {
    const sourceUrl = `https://my.princeton.edu/upload/${club.logoSubFolder}${club.logoFileName}`;
    try {
      const res = await fetch(sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      const final = new URL(res.url);
      if (!res.ok || final.hostname !== 'static-prod-us-east-1.campusgroups.com' || !final.pathname.startsWith('/upload/princeton/'))
        continue;
      const input = Buffer.from(await res.arrayBuffer());
      const webp = await sharp(input).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      const name = `${club.id}-${createHash('sha256').update(webp).digest('hex').slice(0, 10)}.webp`;
      writeFileSync(new URL(name, dir), webp);
      logos[`mpu:${club.id}`] = { src: `/organization-logos/${name}`, sourceUrl };
      saved++;
    } catch {
      /* skip unreadable images */
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
writeFileSync(logosPath, JSON.stringify(Object.fromEntries(Object.entries(logos).sort()), null, 2) + '\n');
console.log(`Saved ${saved} logos; ${Object.keys(logos).length} organizations have logos.`);
