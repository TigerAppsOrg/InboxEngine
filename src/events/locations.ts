/**
 * Campus location gazetteer: named Princeton venues (from The Forum's campus map export) plus
 * curated aliases. resolveLocation() maps a short location phrase such as "McCosh 50" or
 * "Frist MPR" to a stable venue ID with coordinates. It is never run over arbitrary body text:
 * callers pass an extracted location phrase, because venue names double as ordinary words.
 */
import generated from './data/campus-locations.json' with { type: 'json' };
import overrides from './data/location-overrides.json' with { type: 'json' };
import { normalize } from '../orgs/registry.ts';

export type LocationCategory =
  | 'academic'
  | 'residential'
  | 'athletic'
  | 'social'
  | 'administrative'
  | 'library'
  | 'dining'
  | 'other';

export type CampusLocation = {
  id: string;
  name: string;
  aliases: string[];
  category: LocationCategory;
  latitude: number;
  longitude: number;
  source: string;
};

type Override = { name?: string; category?: string; aliases?: string[]; drop?: boolean };

const drop = new Set<string>(overrides.drop);
const map = new Map<string, CampusLocation>();
for (const loc of generated.locations as CampusLocation[]) {
  const o = (overrides.overrides as Record<string, Override>)[loc.id];
  if (drop.has(loc.id) || o?.drop) continue;
  const name = o?.name ?? loc.name;
  map.set(loc.id, {
    ...loc,
    name,
    category: (o?.category ?? loc.category) as LocationCategory,
    aliases: [...new Set([...loc.aliases, ...(o?.aliases ?? []), ...(name !== loc.name ? [loc.name] : [])])]
  });
}
for (const add of overrides.additions as CampusLocation[]) if (!map.has(add.id)) map.set(add.id, add);

export const campusLocations: readonly CampusLocation[] = [...map.values()];
export const ONLINE_LOCATION_ID = 'online';

type Entry = { loc: CampusLocation; text: string };
const entries: Entry[] = [];
for (const loc of campusLocations)
  for (const text of new Set([loc.name, ...loc.aliases].map(normalize)))
    if (text.length >= 2) entries.push({ loc, text });
// Longest alias first, so "Frist Film/Performance Theatre" beats "Frist".
entries.sort((a, b) => b.text.length - a.text.length);

export type LocationMatch = { location: CampusLocation; matched: string; room: string | null };

/** Resolve an extracted location phrase to a campus venue, or null when nothing matches. */
export function resolveLocation(phrase: string | null | undefined): LocationMatch | null {
  if (!phrase) return null;
  const text = ` ${normalize(phrase)} `;
  if (text.trim().length < 2) return null;
  for (const entry of entries) {
    const at = text.indexOf(` ${entry.text} `);
    if (at < 0) continue;
    // Short, ambiguous aliases (≤3 chars, e.g. "CS", "TI", "GC") must be most of the phrase.
    if (entry.text.length <= 3 && text.trim().split(' ').length > 3) continue;
    const after = text.slice(at + entry.text.length + 2);
    const room = /^(?:room |rm )?([a-z]?\d{1,4}[a-z]?)\b/.exec(after)?.[1] ?? null;
    const validRoom = room && /[1-9]/.test(room) ? room : null;
    return { location: entry.loc, matched: entry.text, room: validRoom ? validRoom.toUpperCase() : null };
  }
  return null;
}

export function getLocation(id: string): CampusLocation | undefined {
  return map.get(id);
}
