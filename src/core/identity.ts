/**
 * Message identity and cross-post deduplication.
 *
 * Ported from TigerInbox (scripts/message_headers.py, message-identity.ts). Residential lists
 * cross-post the same email; copies are merged only on hard evidence:
 *   1. the same RFC Message-ID, or
 *   2. the same deliveryKey (From, Reply-To, Subject, declared residential recipients and the
 *      token-normalized full HTML), sent within two minutes.
 * Subjects or senders alone never merge messages.
 */
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { RESIDENTIAL_LISTSERVS } from './listservs.ts';

export const IDENTITY_VERSION = 9;

/** Stable, list-scoped message ID. Identical to TigerInbox's IDs, so permalinks line up. */
export function messageId(list: string, archiveId: string): string {
  return createHash('sha256').update(`${list}:${archiveId}`).digest('hex').slice(0, 24);
}

export type HeaderIdentity = {
  identityFields: [from: string, replyTo: string, subject: string, date: string];
  rfcMessageId: string | null;
  recipientLists: string[];
  headersComplete: boolean;
};

const decodeEntities = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** Parse the full-header block LISTSERV renders when GLOBAL_HEADER is enabled. */
export function parseArchiveHeaders(page: string): HeaderIdentity {
  const fields: Record<string, string> = {};
  const re = /<div\b[^>]*class="[^"]*archive[^"]*"[^>]*>\s*<b>([^<]+):<\/b>([\s\S]*?)<\/div>/gi;
  for (const [, name, value] of page.matchAll(re)) {
    fields[name.toLowerCase()] = decodeEntities(value.replace(/<[^>]*>/g, ''))
      .split(/\s+/)
      .filter(Boolean)
      .join(' ');
  }
  const identity = /<([^<>\s]+@[^<>\s]+)>/.exec(fields['message-id'] || '');
  const recipients = ['to', 'cc', 'x-to', 'x-cc'].map((k) => fields[k] || '').join(' ').toUpperCase();
  const lists = [...new Set([...recipients.matchAll(/([A-Z0-9_-]+)@PRINCETON\.EDU/g)].map((m) => m[1]))]
    .filter((l) => (RESIDENTIAL_LISTSERVS as readonly string[]).includes(l))
    .sort();
  const parsedDate = new Date(fields.date || '');
  const date = Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : '';
  return {
    identityFields: [fields.from || '', fields['reply-to'] || '', fields.subject || '', date],
    rfcMessageId: identity ? identity[1] : null,
    recipientLists: lists,
    headersComplete: !!(identity && lists.length)
  };
}

const LISTS = RESIDENTIAL_LISTSERVS.map((n) => n.replace(/[-]/g, '\\-')).join('|');
const FORMS_WARNING =
  '⚠ SECURITY WARNING This email links to a Google Form. Do not enter your password or Duo code in the form. Princeton University will never ask for your login credentials. If the message is suspicious, report it to the Phish Bowl at phishbowl@princeton.edu';

function unwrapUrl(value: string, attrs: Record<string, string>): string {
  try {
    let parsed = new URL(value);
    const original = attrs.originalsrc;
    if (original && parsed.hostname.endsWith('.sharepoint.com')) {
      const source = new URL(original);
      const actual = new URLSearchParams(parsed.search);
      actual.delete('xsdata');
      actual.delete('sdata');
      if (
        source.origin === parsed.origin &&
        source.pathname === parsed.pathname &&
        source.hash === parsed.hash &&
        source.searchParams.toString() === actual.toString()
      ) {
        value = original;
        parsed = source;
      }
    }
    if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.safelinks.protection.outlook.com')) {
      const target = parsed.searchParams.get('url') || '';
      if (/^https?:\/\//i.test(target)) value = target;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * Token-level fingerprint of the full HTML: every word, punctuation mark and link/image target,
 * ignoring transport-only wrapping, entity spelling, whitespace and known list footers.
 */
export function canonicalContent(bodyHtml: string): string {
  let content = (bodyHtml || '').replace(/\r\n/g, '\n').trim();
  content = content.replace(
    new RegExp(`^This email was sent to you as a subscriber of (?:${LISTS})@princeton\\.edu\\.\\s*`, 'i'),
    ''
  );
  content = content.replace(
    new RegExp(`\\s*If you would like to unsubscribe from this listserv, please send a "SIGNOFF (?:${LISTS})" command to LISTSERV@PRINCETON\\.EDU\\s*$`, 'i'),
    ''
  );
  content = content.replace(
    new RegExp(`\\s*To unsubscribe, click the following link:\\s*https://lists\\.princeton\\.edu/cgi-bin/wa\\?SUBED1=(?:${LISTS})\\s*$`, 'i'),
    ''
  );
  content = content.replace(/<div\b[^>]*>\s*<strong>⚠ SECURITY WARNING<\/strong>[\s\S]*?<\/div>/gi, (block) => {
    const flat = decodeEntities(block.replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean).join(' ');
    return flat === FORMS_WARNING ? '' : block;
  });

  const text: string[] = [];
  const resources: [string, string, string][] = [];
  let skip = 0;
  const blockStart = new Set(['p', 'div', 'br', 'li', 'tr', 'td', 'h1', 'h2', 'h3', 'blockquote']);
  const blockEnd = new Set(['p', 'div', 'li', 'tr', 'td', 'h1', 'h2', 'h3', 'blockquote']);
  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (['head', 'style', 'script'].includes(tag)) skip++;
        if (skip) return;
        if (blockStart.has(tag)) text.push(' ');
        for (const name of ['href', 'src', 'srcset', 'poster']) {
          const value = attrs[name];
          if (!value) continue;
          let resolved = unwrapUrl(value, attrs);
          try {
            const u = new URL(resolved);
            if (/^https?:$/.test(u.protocol) && u.host && (u.pathname === '' || u.pathname === '/'))
              resolved = `${u.protocol}//${u.host}/${u.search}${u.hash}`;
          } catch {
            /* keep as-is */
          }
          resources.push([tag, name, resolved]);
        }
      },
      onclosetag(tag) {
        if (['head', 'style', 'script'].includes(tag)) skip = Math.max(0, skip - 1);
        if (blockEnd.has(tag)) text.push(' ');
      },
      ontext(data) {
        if (!skip) text.push(data);
      }
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(content);
  parser.end();
  let tokens: string[] = [...(text.join("").match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) || [])];
  for (const name of RESIDENTIAL_LISTSERVS) {
    const url = `https://lists.princeton.edu/cgi-bin/wa?SUBED1=${name.toLowerCase()}&A=1`;
    const footer =
      `To unsubscribe from the ${name.toLowerCase()} list, click the following link: ${url}`.match(
        /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu
      ) || [];
    const last = resources.at(-1);
    if (
      tokens.length >= footer.length &&
      tokens.slice(-footer.length).join('\u0000') === footer.join('\u0000') &&
      last && last[0] === 'a' && last[1] === 'href' && last[2] === url
    ) {
      tokens = tokens.slice(0, -footer.length);
      resources.pop();
    }
  }
  return JSON.stringify([tokens, resources]);
}

/** Full-content cross-post key; only computed from complete headers naming ≥2 residential lists. */
export function deliveryKey(headers: HeaderIdentity, bodyHtml: string): string | null {
  const [from, replyTo, subject, date] = headers.identityFields;
  if (!headers.headersComplete || headers.recipientLists.length < 2 || !from || !date) return null;
  if (!(bodyHtml || '').trim()) return null;
  return createHash('sha256')
    .update(JSON.stringify([from, replyTo, subject, headers.recipientLists, canonicalContent(bodyHtml)]))
    .digest('hex');
}

/** Copies may merge when they share an RFC Message-ID, or a deliveryKey within 120 seconds. */
export function sameDelivery(
  a: { rfcMessageId?: string | null; deliveryKey?: string | null; date: string | Date },
  b: { rfcMessageId?: string | null; deliveryKey?: string | null; date: string | Date }
): boolean {
  if (a.rfcMessageId && a.rfcMessageId === b.rfcMessageId) return true;
  if (!a.deliveryKey || a.deliveryKey !== b.deliveryKey) return false;
  return Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) <= 120_000;
}
