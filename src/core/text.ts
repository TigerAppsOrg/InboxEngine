/**
 * Email body normalization shared by every consumer.
 *
 * Ported from TigerInbox (src/lib/server/email-content.ts, src/lib/email-notices.ts), which
 * matches only exact, known delivery boilerplate (LISTSERV unsubscribe footers, HoagieMail
 * footers, subscriber headers, the Princeton Google Forms warning). Author-written content,
 * signatures and warnings are never removed.
 */
import sanitizeHtml from 'sanitize-html';
import { compile } from 'html-to-text';
import { find } from 'linkifyjs';
import { parseDocument } from 'htmlparser2';
import { Element, Text, isTag, hasChildren, type ChildNode } from 'domhandler';
import serialize from 'dom-serializer';
import { RESIDENTIAL_LISTSERVS } from './listservs.ts';

const COLLEGES = RESIDENTIAL_LISTSERVS.join('|');

// ── Delivery notices ─────────────────────────────────────

const subscriberNotice = new RegExp(
  `^\\s*This email was sent to you as a subscriber of (?:${COLLEGES})@princeton\\.edu\\.\\s*`,
  'i'
);
const formsWarning =
  /^\s*⚠️?\s*SECURITY WARNING\s*This email links to a Google Form\.\s*Do not\s+enter your password or Duo code\s+in the form\.\s*Princeton University will never ask for your login credentials\.\s*If the message is suspicious, report it to the Phish Bowl at\s+phishbowl@princeton\.edu\.?\s*/i;

/** Remove only the known leading delivery notices; report whether the Forms warning was present. */
export function extractEmailNotices(text: string) {
  let body = text.replace(subscriberNotice, '');
  const hasFormsWarning = formsWarning.test(body);
  body = body.replace(formsWarning, '').replace(subscriberNotice, '');
  return { body, hasFormsWarning, changed: body !== text };
}

// ── Footers ──────────────────────────────────────────────

const hoagieFooterStart = 'This email was instantly sent to all college listservs with';
const unsubscribeUrl = `https:\\/\\/lists\\.princeton\\.edu\\/cgi-bin\\/wa\\?SUBED1=(?:${COLLEGES})(?:&A=1)?`;
function unsubscribePattern() {
  return new RegExp(
    `If you would like to unsubscribe from this listserv, please send a ["“]SIGNOFF (?:${COLLEGES})["”] command to LISTSERV@PRINCETON\\.EDU\\.?|To unsubscribe(?: from the (?:${COLLEGES}) list)?, click the following link:\\s*\\[?${unsubscribeUrl}\\]?(?![\\w&=/-])`,
    'gi'
  );
}

function isHoagieFooter(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (
    normalized.startsWith(hoagieFooterStart) &&
    /Hoagie\s*Mail/i.test(normalized) &&
    normalized.includes('Email composed by') &&
    normalized.includes('hoagie@princeton.edu')
  );
}

/** Hide only the recognizable service footer; retain the author's signature. */
export function displayText(body: string): string {
  body = body.replace(unsubscribePattern(), '').trimEnd();
  const start = body.indexOf(hoagieFooterStart);
  if (start < 0 || !isHoagieFooter(body.slice(start))) return body;
  const tail = body.slice(start);
  const end =
    /please report it to\s+hoagie@princeton\.edu(?:\s*\[mailto:hoagie@princeton\.edu\])?\s*\./i.exec(
      tail
    );
  if (!end) return body;
  return (
    body
      .slice(0, start)
      .replace(/\s*[-_]{3,}\s*$/, '')
      .trimEnd() + tail.slice(end.index + end[0].length)
  ).trimEnd();
}

// ── HTML → text ──────────────────────────────────────────

const bodyText = compile({
  wordwrap: false,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } }
  ]
});
const previewText = compile({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'iframe', format: 'skip' },
    { selector: 'svg', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } }
  ]
});
const htmlTag =
  /<\/?(?:html|body|head|div|p|span|br|hr|a|img|table|tbody|thead|tr|td|th|ul|ol|li|h[1-6]|strong|b|em|i|u|s|del|sup|sub|font|center|figure|figcaption|blockquote|pre|code|script|style|iframe|svg)(?=[\s/>])[^>]*>/i;

export function looksLikeHtml(value: string): boolean {
  return htmlTag.test(value);
}

/** Readable plain text for storage, search, classification and extraction. */
export function htmlToText(html: string): string {
  return cleanWhitespace(bodyText(html));
}

export function cleanWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain body text with delivery boilerplate removed: the text agents and extractors should read. */
export function readableText(body: string, bodyHtml?: string | null): string {
  const text = bodyHtml && looksLikeHtml(bodyHtml) ? htmlToText(bodyHtml) : cleanWhitespace(body);
  return extractEmailNotices(displayText(text)).body.trim();
}

/** A one-line preview (≤230 chars), including legacy RSS snippets containing escaped HTML. */
export function messagePreview(body: string, bodyHtml?: string | null): string {
  let text = bodyHtml || body;
  if (!htmlTag.test(text)) {
    text = previewText(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  }
  // Some archives mix escaped markup with an unescaped service footer; bound the decoding.
  for (let pass = 0; pass < 3 && htmlTag.test(text); pass++) text = previewText(text);
  return extractEmailNotices(displayText(text))
    .body.replace(/\[https?:\/\/[^\]]+\]/g, '')
    .replace(/[-_]{5,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 230);
}

// ── Safe HTML for display ────────────────────────────────

function stripUnsubscribeHtml(html: string) {
  const document = parseDocument(html);
  let text = '';
  const spans: { node: ChildNode; start: number; end: number; anchor: boolean }[] = [];
  function collect(nodes: ChildNode[]) {
    for (const node of nodes) {
      const anchor =
        isTag(node) &&
        node.name === 'a' &&
        new RegExp(`^${unsubscribeUrl}$`, 'i').test(node.attribs.href || '');
      if (node.type === 'text' || anchor) {
        const value = anchor && isTag(node) ? node.attribs.href : (node as Text).data;
        spans.push({ node, start: text.length, end: text.length + value.length, anchor });
        text += value;
      } else if (hasChildren(node)) collect(node.children);
      if (isTag(node) && ['br', 'p', 'div', 'hr'].includes(node.name)) text += '\n';
    }
  }
  collect(document.children);
  const matches = [...text.matchAll(unsubscribePattern())].reverse();
  for (const span of spans) {
    for (const match of matches) {
      const start = Math.max(span.start, match.index!);
      const end = Math.min(span.end, match.index! + match[0].length);
      if (start >= end) continue;
      if (span.anchor && span.node.parent) {
        span.node.parent.children = span.node.parent.children.filter((node) => node !== span.node);
      } else if (span.node.type === 'text') {
        const t = span.node as Text;
        t.data = t.data.slice(0, start - span.start) + t.data.slice(end - span.start);
      }
    }
  }
  return serialize(document);
}

function autoLinkHtml(html: string) {
  const document = parseDocument(html);
  function visit(nodes: ChildNode[]): ChildNode[] {
    return nodes.flatMap((node): ChildNode[] => {
      if (isTag(node) && ['a', 'pre', 'code'].includes(node.name)) return [node];
      if (hasChildren(node)) node.children = visit(node.children);
      if (node.type !== 'text') return [node];
      const data = (node as Text).data;
      const links = find(data).filter(
        (link) => link.type === 'url' && /^https?:\/\//i.test(link.value)
      );
      if (!links.length) return [node];
      const result: ChildNode[] = [];
      let offset = 0;
      for (const link of links) {
        result.push(new Text(data.slice(offset, link.start)));
        result.push(
          new Element('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer' }, [
            new Text(link.value)
          ])
        );
        offset = link.end;
      }
      result.push(new Text(data.slice(offset)));
      return result;
    });
  }
  document.children = visit(document.children);
  return serialize(document, { encodeEntities: 'utf8' });
}

/** Original anchors and basic formatting, with no executable or remote-loading markup. */
export function displayHtml(source: string | null | undefined): string {
  if (
    !source ||
    !/<(?:p|div|span|br|a|pre|html|body|table|h[1-6]|ul|ol|b|strong|em|img)\b/i.test(source)
  )
    return '';
  let removedFooter = false;
  const html = sanitizeHtml(source, {
    allowedTags: [
      'p', 'div', 'span', 'br', 'hr', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'pre', 'code', 'sub', 'sup',
      'table', 'thead', 'tbody', 'tr', 'th', 'td'
    ],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'noscript', 'iframe', 'svg', 'math'],
    transformTags: {
      a: (_tag, attrs) => {
        // Relative URLs have no meaningful base inside an archived email.
        if (!/^(https?:\/\/|mailto:|tel:)/i.test(attrs.href || ''))
          return { tagName: 'span', attribs: {} };
        return { tagName: 'a', attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' } };
      }
    },
    exclusiveFilter: (frame) => {
      const notice = extractEmailNotices(frame.text);
      if (['div', 'p'].includes(frame.tag) && notice.changed && !notice.body.trim()) return true;
      if (['div', 'p'].includes(frame.tag) && isHoagieFooter(frame.text)) {
        removedFooter = true;
        return true;
      }
      return false;
    }
  });
  const content = removedFooter
    ? html.replace(/(?:\s*<(?:hr|br)\s*\/?>)+(?=\s*(?:<\/(?:div|p|span)>\s*)*$)/i, '').trimEnd()
    : html;
  return autoLinkHtml(stripUnsubscribeHtml(content.replace(subscriberNotice, '')));
}

// ── Links ────────────────────────────────────────────────

/** Unique outbound http(s) links, unwrapping Outlook SafeLinks and dropping LISTSERV plumbing. */
export function extractLinks(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    let url = match[1].replace(/&amp;/g, '&');
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('.safelinks.protection.outlook.com')) {
        const target = parsed.searchParams.get('url');
        if (target && /^https?:\/\//i.test(target)) url = target;
      }
      if (new URL(url).hostname === 'lists.princeton.edu') continue;
    } catch {
      continue;
    }
    seen.add(url);
  }
  return [...seen];
}
