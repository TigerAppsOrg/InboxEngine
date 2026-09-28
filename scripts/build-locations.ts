/**
 * Build src/events/data/campus-locations.json from The Forum's campus map POI export
 * (apps/web/src/app/(app)/map/_assets/campus-data/pois.json).
 *
 *   npm run build:locations -- /path/to/campus-data/pois.json
 *
 * Only named, event-capable venues are kept (buildings, halls, theatres, dining, libraries,
 * athletics, eating clubs, parks). Offices and departments are dropped: they share their
 * building's coordinates and would only add ambiguous aliases. Curated aliases live in
 * src/events/data/location-aliases.json and are merged at load time, not here.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Poi = {
  id: number;
  name: string | null;
  alt_name: string | null;
  class: string;
  type: string;
  lat: number;
  long: number;
  parent_id: number | null;
};

const CATEGORY: Record<string, string> = {
  university: 'academic',
  residential_college: 'residential',
  library: 'library',
  theatre: 'social',
  events_venue: 'social',
  gallery: 'social',
  museum: 'social',
  cafeteria: 'dining',
  cafe: 'dining',
  food_court: 'dining',
  restaurant: 'dining',
  sports_centre: 'athletic',
  athletics: 'athletic',
  pitch: 'athletic',
  tennis: 'athletic',
  basketball: 'athletic',
  football: 'athletic',
  baseball: 'athletic',
  park: 'other',
  building: 'social'
};
const EATING_CLUBS = new Set([
  'Cap & Gown',
  'Charter',
  'Cloister',
  'Colonial',
  'Cottage',
  'Ivy',
  'Quadrangle',
  'Terrace',
  'Tiger',
  'Tower'
]);

const source = process.argv[2];
if (!source) throw new Error('Usage: build-locations <pois.json>');
const pois = JSON.parse(readFileSync(source, 'utf8')) as Poi[];

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const out = new Map<string, { id: string; name: string; aliases: string[]; category: string; latitude: number; longitude: number; source: string }>();
for (const p of pois) {
  const short = (p.name || '').replace(/\s+/g, ' ').trim();
  const long = (p.alt_name || '').replace(/\s+/g, ' ').trim();
  if (!short || !/[A-Za-z]{3}/.test(short) || /^[#\d]/.test(short)) continue;
  const category = CATEGORY[p.type];
  if (!category) continue;
  if (p.type === 'building' && !EATING_CLUBS.has(short) && !/Club|Inn|Church|Swim|Morven/.test(short))
    continue;
  // Prefer the fuller name ("Blair Hall" over "Blair"); keep the other as an alias.
  const name = long && long.length > short.length && long.includes(short.split(' ')[0]) ? long : short;
  const id = slug(name);
  if (!id || out.has(id)) continue;
  const aliases = [...new Set([short, long].filter((a) => a && a !== name))];
  out.set(id, {
    id,
    name: EATING_CLUBS.has(short) && !/Club/.test(name) ? `${name} Club` : name,
    aliases: EATING_CLUBS.has(short) ? [...aliases, short] : aliases,
    category: EATING_CLUBS.has(short) ? 'social' : category,
    latitude: Number(p.lat.toFixed(6)),
    longitude: Number(p.long.toFixed(6)),
    source: `princeton-campus-map:poi:${p.id}`
  });
}
const locations = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  new URL('../src/events/data/campus-locations.json', import.meta.url),
  JSON.stringify({ source: 'TheForum campus map pois.json', generatedAt: new Date().toISOString(), locations }, null, 1) + '\n'
);
console.log(`Wrote ${locations.length} locations.`);
