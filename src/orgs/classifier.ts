/**
 * Explainable multi-signal organization resolver. Ported verbatim (same algorithm and version
 * string) from TigerInbox packages/classifier/index.ts so stored classifications stay valid.
 * Abstains ("Campus community") unless one organization clearly wins; see README for policy.
 */
import { createHash } from 'node:crypto';
import { organizations, normalize, registryVersion, organizationByEmail, type Organization } from './registry.ts';
import { classifyCategory } from './category.ts';
// 2.3: exact MyPrincetonU contact-email sender signal; org websites from group pages.
// 2.4: owned-URL subdomain matching can be disabled per organization (shared hosting domains).
export const CLASSIFIER_VERSION = `2.4:${registryVersion}`;
export type ClassificationInput = {
  subject: string;
  body: string;
  sender: string;
  senderEmail?: string;
  listserv?: string;
};
export type Classification = {
  category: string;
  organization: string;
  organizationId: string | null;
  confidence: 'high' | 'medium' | 'unresolved';
  evidence: string[];
  version: string;
  inputHash: string;
};
export function classificationFingerprint(input: ClassificationInput) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.subject,
        input.body,
        input.sender,
        input.senderEmail || '',
        input.listserv || ''
      ])
    )
    .digest('hex');
}
// Build an inverted alias index once. Matching work scales with message tokens,
// rather than scanning every directory entry for every imported message.
type Alias = { org: Organization; text: string; strong: boolean };
const index = new Map<string, Alias[]>();
const senderIndex = new Map<string, Organization[]>();
const tokenFrequency = new Map<string, number>();
const aliases: Alias[] = [];
for (const org of organizations)
  for (const text of new Set([org.name, ...org.aliases].map(normalize))) {
    if (!text) continue;
    const tokens = text.split(' ');
    const strong =
      ([
        'tigerapps',
        'hackprinceton',
        'bodyhype',
        'disiac',
        'naacho',
        'wprb',
        'sympoh',
        'dorobucci'
      ].includes(text) ||
        (tokens.length >= 2 && text.length >= 10 && !/^(princeton|university) \w+$/.test(text))) &&
      ![
        'all nighter',
        'public lectures',
        'academic advising',
        'research computing',
        'campus club'
      ].includes(text);
    const genericShortAlias =
      org.name.startsWith('Princeton ') &&
      text === normalize(org.name.slice(10)) &&
      tokens.length < 3;
    aliases.push({ org, text, strong: strong && !genericShortAlias });
    for (const token of new Set(tokens))
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    senderIndex.set(text, [...(senderIndex.get(text) || []), org]);
  }
for (const alias of aliases) {
  const key = alias.text
    .split(' ')
    .sort((a, b) => tokenFrequency.get(a)! - tokenFrequency.get(b)!)[0];
  index.set(key, [...(index.get(key) || []), alias]);
}
export function messageContent(body: string) {
  // Delivery boilerplate and quoted older emails do not identify this message's author.
  return body
    .split(
      /This email was instantly sent|You are receiving this email because|To unsubscribe from|Sent (?:using|via) HoagieMail|Powered by (?:Hoagie|TigerApps)|\nOn .{1,160}wrote:|-----Original Message-----/i
    )[0]
    .slice(0, 24000);
}
function aliasesIn(text: string): Alias[] {
  const normalized = ` ${normalize(text.replace(/https?:\/\/[^\s<>\[\]"]+/gi, ' '))} `;
  const candidates = new Set<Alias>();
  for (const token of new Set(normalized.trim().split(' ')))
    for (const a of index.get(token) || []) candidates.add(a);
  const matches = [...candidates].filter((a) => normalized.includes(` ${a.text} `));
  // A child group's complete name is stronger evidence than its parent's substring.
  return matches.filter(
    (a) =>
      !matches.some(
        (b) =>
          b.org.id !== a.org.id &&
          b.text.length > a.text.length &&
          ` ${b.text} `.includes(` ${a.text} `)
      )
  );
}
export function classifyMessage(input: ClassificationInput): Classification {
  const body = messageContent(input.body);
  const scores = new Map<
    string,
    { org: Organization; signals: Map<string, number>; evidence: Set<string> }
  >();
  const add = (org: Organization, signal: string, score: number, detail: string) => {
    const entry = scores.get(org.id) || { org, signals: new Map(), evidence: new Set() };
    entry.signals.set(signal, Math.max(entry.signals.get(signal) || 0, score));
    entry.evidence.add(detail);
    scores.set(org.id, entry);
  };
  const sender = normalize(input.sender);
  // Transport addresses (HoagieMail, LISTSERV) are never organization identities.
  if (!/^(hoagie ?mail|hoagie|listserv|princeton community)$/.test(sender)) {
    for (const org of senderIndex.get(sender) || []) add(org, 'sender', 110, 'exact sender alias');
    for (const a of aliasesIn(input.sender))
      if (a.strong) add(a.org, 'sender', 85, `sender: ${a.text}`);
  }
  // A group's registered contact address sending (or HoagieMail-composing) the email.
  const byEmail = input.senderEmail ? organizationByEmail(input.senderEmail) : undefined;
  if (byEmail) add(byEmail, 'sender', 110, 'organization contact email');
  for (const a of aliasesIn(input.subject))
    add(a.org, 'subject', a.strong ? 80 : 30, `subject: ${a.text}`);
  for (const a of aliasesIn(body))
    add(
      a.org,
      'body',
      a.org.groupType === 'Residential Colleges' ? 20 : a.strong ? 65 : 15,
      `body: ${a.text}`
    );
  // plaintext is also a technical term; a meeting title or corroborating identity is required.
  if (
    /\bplaintext\b/i.test(input.subject.normalize('NFKC')) &&
    /kickoff|meeting|wrap up|acm\s*[-:]\s*plaintext|^\[?\d{1,2}\/\d{1,2}\s+plaintext/i.test(
      input.subject
    )
  ) {
    add(
      organizations.find((o) => o.id === 'plaintext') as Organization,
      'subject',
      80,
      'plaintext event title'
    );
  }
  const urls = [...`${input.subject}\n${body}`.matchAll(/https?:\/\/[^\s<>\[\]"]+/gi)].flatMap(
    (m) => {
      try {
        return [new URL(m[0].replace(/[),.;]+$/, ''))];
      } catch {
        return [];
      }
    }
  );
  for (const org of organizations) {
    for (const owned of org.urls) {
      const target = new URL(owned);
      if (
        urls.some(
          (u) =>
            (u.hostname === target.hostname ||
              (org.urlSubdomains &&
                target.pathname === '/' &&
                u.hostname.endsWith('.' + target.hostname))) &&
            u.pathname.startsWith(target.pathname)
        )
      )
        add(org, 'url', 85, `organization URL: ${target.hostname}${target.pathname}`);
    }
  }
  // MyPrincetonU links identify the group by stable ID, not the shared host name.
  for (const url of urls)
    if (url.hostname === 'my.princeton.edu') {
      const org = organizations.find((o) => o.id === `mpu:${url.searchParams.get('club_id')}`);
      if (org) add(org, 'url', 85, 'MyPrincetonU group link');
    }
  const ranked = [...scores.values()]
    .map((e) => ({ ...e, score: [...e.signals.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const resolved = best && best.score >= 65 && (!ranked[1] || best.score - ranked[1].score >= 20);
  let category =
    input.listserv === 'FREEFOOD' ? 'Free food' : classifyCategory(input.subject, body);
  if (category === 'Campus life' && resolved) {
    if (best.org.groupType === 'Academic Department') category = 'Academics';
    else if (
      best.org.categories.some((c) =>
        ['Arts', 'Dance', 'Music', 'A Cappella', 'Performing Arts'].includes(c)
      )
    )
      category = 'Arts & culture';
  }
  return {
    category,
    organization: resolved ? best.org.name : 'Campus community',
    organizationId: resolved ? best.org.id : null,
    confidence: resolved ? (best.score >= 100 ? 'high' : 'medium') : 'unresolved',
    evidence: resolved
      ? [...best.evidence]
      : [best ? 'Ambiguous or weak organization evidence' : 'No directory match'],
    inputHash: classificationFingerprint(input),
    version: CLASSIFIER_VERSION
  };
}
// Compatibility for callers that only have a display sender. All app ingestion uses classifyMessage.
export function classify(subject: string, body: string, sender: string) {
  return classifyMessage({ subject, body, sender });
}
