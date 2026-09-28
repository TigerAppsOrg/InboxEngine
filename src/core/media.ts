/**
 * Safe media references for an archived email. Ported from TigerInbox scripts/media_manifest.py.
 * Never retains LISTSERV session parameters (X, Y); keeps the attachment byte offset P.
 */
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

const BASE = 'https://lists.princeton.edu/cgi-bin/wa';

export type MediaRef = {
  id: string;
  url: string;
  kind: 'image' | 'file';
  name: string;
  alt: string;
  width?: number | null;
  height?: number | null;
};

export function cleanMediaUrl(raw: string): string | null {
  let value = (raw || '').replace(/&amp;/g, '&').trim();
  try {
    let parsed = new URL(value, BASE);
    // Gmail image proxies include the original public image after a fragment.
    if (parsed.hostname.endsWith('googleusercontent.com') && /^#https?:\/\//.test(parsed.hash)) {
      value = parsed.hash.slice(1);
      parsed = new URL(value);
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
      return null;
    if (parsed.hostname === 'lists.princeton.edu') {
      const pairs = [...parsed.searchParams.entries()];
      if (parsed.pathname !== '/cgi-bin/wa' || !pairs.some(([k]) => k.toUpperCase() === 'A3')) return null;
      const kept = pairs.filter(([k]) => !['X', 'Y', 'PASSWORD', 'HEADER', 'XSS'].includes(k.toUpperCase()));
      parsed.search = new URLSearchParams(kept).toString();
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

const num = (v?: string) => {
  const m = /^\d+/.exec(v || '');
  return m ? Number(m[0]) : null;
};

export function extractMedia(bodyHtml: string, attachments: { url: string; type?: string }[] = []): MediaRef[] {
  const images: Omit<MediaRef, 'id'>[] = [];
  const ignored = new Set<string>();
  const parser = new Parser({
    onopentag(tag, a) {
      if (tag !== 'img') return;
      const raw = a.src || '';
      if (/^(cid|data):/i.test(raw)) return;
      const url = cleanMediaUrl(raw);
      if (!url) return;
      const width = num(a.width);
      const height = num(a.height);
      if ((width && width <= 24) || (height && height <= 24) || new URL(url).hostname === 'fonts.gstatic.com') {
        ignored.add(url);
        return;
      }
      const name = new URL(url).pathname.split('/').pop() || 'image';
      images.push({ url, kind: 'image', name, alt: (a.alt || 'Email image').slice(0, 300), width, height });
    }
  });
  parser.write(bodyHtml || '');
  parser.end();
  const media = [...images];
  const seen = new Set([...images.map((m) => m.url), ...ignored]);
  for (const item of attachments) {
    const url = cleanMediaUrl(item.url);
    if (!url || seen.has(url)) continue;
    const q = new URL(url).searchParams;
    const mime = (q.get('T') || '').split(';')[0].toLowerCase();
    if (['text/plain', 'text/html', 'message/rfc822'].includes(mime) || item.type === 'View Message') continue;
    const name = (q.get('N') || item.type || 'Attachment').slice(0, 200);
    media.push({ url, kind: mime.startsWith('image/') ? 'image' : 'file', name, alt: name });
    seen.add(url);
  }
  const out: MediaRef[] = [];
  const unique = new Set<string>();
  for (const m of media) {
    if (unique.has(m.url)) continue;
    unique.add(m.url);
    out.push({ id: createHash('sha256').update(m.url).digest('hex').slice(0, 24), ...m });
  }
  return out.slice(0, 40);
}
