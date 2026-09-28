/**
 * Original-author resolution.
 *
 * HoagieMail is a relay: its footer ("Email composed by Name (email)") names the real author,
 * and hoagie@princeton.edu never identifies anyone. Ported from TigerInbox's messageSender().
 * The footer is untrusted body text, so consumers must not treat the resolved author as an
 * authenticated identity (e.g. never grant ownership of an event based on it).
 */
import { compile } from 'html-to-text';

const text = compile({ wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] });

export const isHoagieAddress = (email: string) =>
  /^(?:hoagie|hoagiemail)@princeton\.edu$/i.test(email.trim());

export type ResolvedSender = {
  /** Display name of the original author, or the archived sender name. */
  name: string;
  /** Original author email; empty when only the relay address is known. */
  email: string;
  /** Delivery relay, when the message came through one. */
  via: 'HoagieMail' | null;
  attribution: 'hoagiemail-footer' | 'archive-metadata' | 'display-name-only';
};

const FOOTER =
  /Email composed by\s+(.{1,160}?)\s*\(\s*([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*\)/i;

export function resolveSender(input: {
  name?: string | null;
  email?: string | null;
  body?: string | null;
  bodyHtml?: string | null;
  viaHoagie?: boolean;
}): ResolvedSender {
  const storedEmail = String(input.email || '').trim();
  const viaHoagie = !!input.viaHoagie || isHoagieAddress(storedEmail);
  let author: { name: string; email: string } | undefined;
  if (viaHoagie) {
    for (const content of [input.bodyHtml, input.body]) {
      if (!content) continue;
      const match = FOOTER.exec(text(String(content)).replace(/\s+/g, ' '));
      if (match && !isHoagieAddress(match[2])) {
        author = { name: match[1].trim(), email: match[2].toLowerCase() };
        break;
      }
    }
  }
  const email = author?.email || (isHoagieAddress(storedEmail) ? '' : storedEmail.toLowerCase());
  const name = (author?.name || String(input.name || '').replace(/<[^>]*>/g, '').trim()) || 'Princeton community';
  return {
    name,
    email,
    via: viaHoagie ? 'HoagieMail' : null,
    attribution: author ? 'hoagiemail-footer' : email ? 'archive-metadata' : 'display-name-only'
  };
}

/** Parse an RFC 5322-ish "Name <email>" author string. */
export function parseAddress(raw: string): { name: string; email: string } {
  const match = /^\s*"?(.*?)"?\s*<([^<>]+)>\s*$/.exec(raw || '');
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  const bare = (raw || '').trim();
  return /@/.test(bare) && !/\s/.test(bare) ? { name: '', email: bare } : { name: bare, email: '' };
}
