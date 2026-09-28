/**
 * Organization registry: 727 MyPrincetonU groups (metadata only) plus a curated alias/identity
 * layer. Ported from TigerInbox packages/classifier/registry.ts; this repo is now the source of
 * truth for both apps. Stable IDs are `mpu:<club_id>` for directory groups.
 */
import logos from './data/logos.json' with { type: 'json' };
import directory from './data/directory.json' with { type: 'json' };
import overrides from './data/overrides.json' with { type: 'json' };
import profileData from './data/profiles.json' with { type: 'json' };

export type Organization = {
  id: string;
  name: string;
  aliases: string[];
  groupType: string;
  categories: string[];
  urls: string[];
  sources: string[];
  profile: OrganizationProfile;
};

/** Organization-authored public fields from MyPrincetonU group pages. No rosters. */
export type OrganizationProfile = {
  tagline?: string;
  description?: string;
  whatWeDo?: string;
  goals?: string;
  website?: string;
  email?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
  acronym?: string;
  memberCount?: number;
};
const profiles = profileData.profiles as Record<string, OrganizationProfile>;

type Override = {
  id: string;
  name?: string;
  aliases?: string[];
  groupType?: string;
  categories?: string[];
  urls?: string[];
  sources?: string[];
};

export function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const records = new Map<string, Organization>();
for (const org of directory.organizations) {
  const aliases = [org.name];
  // The directory often uses inverted names: "Players, Princeton University".
  const inverted = org.name.match(/^(.+), (Princeton(?: University)?)$/);
  if (inverted) aliases.push(`${inverted[2]} ${inverted[1]}`);
  if (org.name.startsWith('Princeton ')) aliases.push(org.name.slice(10));
  const acronym = org.name.match(/\(([A-Z][A-Za-z]{2,9})\)/)?.[1];
  if (acronym) aliases.push(acronym);
  const profile = profiles[org.id] ?? {};
  if (profile.acronym && /^[A-Za-z][A-Za-z0-9&-]{2,11}$/.test(profile.acronym) && !/^\d/.test(profile.acronym))
    aliases.push(profile.acronym);
  const urls = profile.website && /^https?:\/\/(?!(?:www\.)?(?:princeton\.edu|my\.princeton\.edu|instagram\.com|facebook\.com|linktr\.ee|docs\.google\.com|forms\.gle|sites\.google\.com)\/?$)/i.test(profile.website) ? [profile.website] : [];
  records.set(org.id, { ...org, aliases, urls, sources: [directory.source], profile });
}
for (const override of overrides as Override[]) {
  const old = records.get(override.id);
  const name = override.name || old?.name;
  if (!name) throw new Error(`Override ${override.id} needs a name`);
  records.set(override.id, {
    id: override.id,
    name,
    groupType: override.groupType || old?.groupType || 'Student organization',
    categories: override.categories || old?.categories || [],
    aliases: [...new Set([...(old?.aliases || []), ...(override.aliases || []), name])],
    urls: override.urls || old?.urls || [],
    sources: [...(old?.sources || []), ...(override.sources || [])],
    profile: old?.profile ?? profiles[override.id] ?? {}
  });
}
// Duplicate names in MyPrincetonU sometimes represent different group types.
const counts = new Map<string, number>();
for (const org of records.values()) counts.set(org.name, (counts.get(org.name) || 0) + 1);
for (const org of records.values()) if (counts.get(org.name)! > 1) org.name += ` (${org.groupType})`;

export const organizations: readonly Organization[] = [...records.values()];
const byId = new Map(organizations.map((o) => [o.id, o]));

// Include curated changes in the version so incremental imports cannot reuse stale results.
let registryHash = 2166136261;
for (const char of JSON.stringify(overrides))
  registryHash = Math.imul(registryHash ^ char.charCodeAt(0), 16777619);
export const registryVersion = `${directory.retrievedAt}:${(registryHash >>> 0).toString(16)}`;

export function getOrganization(id: string): Organization | undefined {
  return byId.get(id);
}

const byEmail = new Map<string, Organization[]>();
for (const org of organizations) {
  const email = org.profile.email?.toLowerCase();
  if (email && /@princeton\.edu$/.test(email)) byEmail.set(email, [...(byEmail.get(email) ?? []), org]);
}
/** Organization whose MyPrincetonU contact address is exactly this email (unique matches only). */
export function organizationByEmail(email: string): Organization | undefined {
  const matches = byEmail.get(email.trim().toLowerCase());
  return matches?.length === 1 ? matches[0] : undefined;
}

export function findOrganization(value: string): Organization | undefined {
  const key = normalize(value);
  const exact = byId.get(value) || organizations.find((o) => normalize(o.name) === key);
  if (exact) return exact;
  const matches = organizations.filter((o) => o.aliases.some((a) => normalize(a) === key));
  return matches.length === 1 ? matches[0] : undefined;
}

export function searchDirectory(query = ''): Organization[] {
  const key = normalize(query);
  return organizations.filter(
    (o) => !key || [o.name, ...o.aliases, ...o.categories].some((a) => normalize(a).includes(key))
  );
}

/** MyPrincetonU group page, only for directory-backed identities. */
export function organizationGroupUrl(org: Organization | string): string | undefined {
  const id = (typeof org === 'string' ? findOrganization(org)?.id : org.id)?.match(/^mpu:(\d+)$/)?.[1];
  return id ? `https://my.princeton.edu/feeds?type=club&type_id=${id}&tab=about` : undefined;
}

export type OrganizationLogo = { path: string; sourceUrl: string };
/** Optimized ≤256px WebP under assets/logos, plus its public provenance URL. */
export function organizationLogo(org: Organization | string): OrganizationLogo | undefined {
  const id = typeof org === 'string' ? findOrganization(org)?.id : org.id;
  const entry = id ? (logos as Record<string, { src: string; sourceUrl: string }>)[id] : undefined;
  return entry ? { path: entry.src.replace(/^\//, ''), sourceUrl: entry.sourceUrl } : undefined;
}

/**
 * Coarse category in The Forum's org_category taxonomy. Derived from MyPrincetonU group type and
 * category tags; consumers with their own taxonomy should map `categories` themselves.
 */
export type ForumOrgCategory =
  | 'career'
  | 'affinity'
  | 'performing arts'
  | 'academics'
  | 'athletics'
  | 'social event'
  | 'culture'
  | 'religion'
  | 'politics'
  | 'community service';

export function forumCategory(org: Organization): ForumOrgCategory {
  const c = new Set(org.categories);
  const has = (...names: string[]) => names.some((n) => c.has(n));
  if (org.groupType === 'Academic Department' || org.groupType === 'McGraw Center') return 'academics';
  if (org.groupType.startsWith('ORL') || has('Religious', 'Chaplaincies')) return 'religion';
  if (org.groupType === 'Campus Rec' || has('Sports/Recreation')) return 'athletics';
  if (org.groupType.startsWith('Pace Center') || has('Service', 'Sustained Volunteering', 'Community Immersion'))
    return 'community service';
  if (has('Performing Arts', 'Dance', 'Music', 'A Cappella', 'Arts')) return 'performing arts';
  if (has('Political', 'Advocacy & Activism', 'Student Government', 'Social Justice', 'Racial Justice'))
    return 'politics';
  if (has('Career Opportunity', 'Professional', 'Finance', 'Entrepreneurship/Innovation', 'Professional Development'))
    return 'career';
  if (has('Cultural/Identity')) return org.groupType === 'Graduate Student Organizations' ? 'affinity' : 'culture';
  if (has('Academic', 'Educational', 'Research', 'Public Lectures')) return 'academics';
  return 'social event';
}
