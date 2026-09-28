/**
 * Princeton LISTSERV web-archive client (https://lists.princeton.edu/cgi-bin/wa).
 *
 * TypeScript port of the scraper TigerInbox and The Forum shared (listserv_client.py). One
 * persistent session re-authenticates on expiry; nothing here sends mail. The archive account
 * should be subscribed NOMAIL so it can read archives without receiving list traffic.
 */
import { XMLParser } from 'fast-xml-parser';
import { parseArchiveHeaders, type HeaderIdentity } from '../core/identity.ts';
import { isValidListName } from '../core/listservs.ts';
import { parseAddress } from '../core/sender.ts';

export const LISTSERV_BASE = 'https://lists.princeton.edu/cgi-bin/wa';
const USER_AGENT = 'InboxEngine/0.1 (+https://tigerapps.org)';

export type ArchiveItem = {
  /** LISTSERV archive message key (A2=…). */
  archiveId: string;
  listserv: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
  /** RSS description: a possibly-truncated HTML preview. */
  previewHtml: string;
  /** Archive URL with session parameters removed. */
  url: string;
};

export type ArchiveMessage = {
  headers: HeaderIdentity;
  bodyHtml: string;
  bodyPlain: string | null;
  attachments: { url: string; type: string }[];
};

export class ListservError extends Error {}

/** Strip LISTSERV session parameters (X, Y, P) from a URL. */
export function cleanArchiveUrl(url: string): string {
  try {
    const u = new URL(url, LISTSERV_BASE);
    for (const key of [...u.searchParams.keys()])
      if (['X', 'Y', 'P'].includes(key.toUpperCase())) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

export class ListservClient {
  private cookie = '';
  private auth = '';
  private lastRequest = 0;
  constructor(
    private readonly email = process.env.LISTSERV_EMAIL || '',
    private readonly password = process.env.LISTSERV_PASSWORD || '',
    private readonly minIntervalMs = 150
  ) {}

  get configured() {
    return !!(this.email && this.password);
  }

  async login(): Promise<void> {
    if (!this.configured) throw new ListservError('LISTSERV_EMAIL and LISTSERV_PASSWORD are required');
    const body = new URLSearchParams({ LOGIN1: '', Y: this.email, p: this.password, e: 'Log In', X: '' });
    const res = await fetch(LISTSERV_BASE, {
      method: 'POST',
      body,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000)
    });
    const page = await res.text();
    const cookie = res.headers
      .getSetCookie()
      .map((c) => /WALOGIN=([^;]+)/.exec(c)?.[1])
      .find(Boolean);
    const token = /X=([A-F0-9]{16,})/.exec(page)?.[1];
    if (!cookie || !token) throw new ListservError('LISTSERV login failed; check LISTSERV_EMAIL/LISTSERV_PASSWORD');
    this.cookie = `WALOGIN=${cookie}`;
    this.auth = `X=${token}&Y=${encodeURIComponent(this.email)}`;
  }

  private async raw(url: string): Promise<{ status: number; text: string; bytes: Buffer }> {
    const wait = this.lastRequest + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.lastRequest = Date.now();
        const res = await fetch(url, {
          headers: { Cookie: this.cookie, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(20_000)
        });
        const bytes = Buffer.from(await res.arrayBuffer());
        if (res.status >= 500) throw new ListservError(`LISTSERV ${res.status}`);
        return { status: res.status, bytes, text: bytes.toString('utf8') };
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  /** Authenticated GET; logs in lazily and once more if the session expired. */
  async get(pathOrUrl: string): Promise<string> {
    if (!this.auth) await this.login();
    const withAuth = () => {
      const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${LISTSERV_BASE}${pathOrUrl}`;
      return `${url}${url.includes('?') ? '&' : '?'}${this.auth}`;
    };
    let res = await this.raw(withAuth());
    if (/Login Required/i.test(res.text)) {
      await this.login();
      res = await this.raw(withAuth());
      if (/Login Required/i.test(res.text)) throw new ListservError('LISTSERV session could not be renewed');
    }
    return res.text;
  }

  /** Newest-first archive listing from the list's RSS feed. */
  async fetchRss(list: string, limit = 300): Promise<ArchiveItem[]> {
    if (!isValidListName(list)) throw new ListservError(`Invalid list name: ${list}`);
    const xml = await this.get(`?RSS&L=${list}&v=2.0&LIMIT=${Math.max(1, Math.min(limit, 50_000))}`);
    const parsed = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true }).parse(xml);
    const raw = parsed?.rss?.channel?.item;
    const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!items.length && !/<rss/i.test(xml))
      throw new ListservError(`${list}: archive access unavailable (subscription or owner approval required)`);
    return items.flatMap((item) => {
      const link = String(item.link ?? '');
      const archiveId = /A2=([^&]+)/.exec(link)?.[1];
      if (!archiveId) return [];
      const { name, email } = parseAddress(String(item.author ?? ''));
      const date = new Date(String(item.pubDate ?? '').replace(/\s+/g, ' '));
      return [
        {
          archiveId: decodeURIComponent(archiveId),
          listserv: list,
          subject: String(item.title ?? '').trim() || '(No subject)',
          authorName: name,
          authorEmail: email,
          date: Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(),
          previewHtml: String(item.description ?? ''),
          url: cleanArchiveUrl(link)
        }
      ];
    });
  }

  /** Show full original headers on message pages (needed for cross-post identity). */
  async enableFullHeaders(): Promise<void> {
    await this.get('?PREF&0=GLOBAL_HEADER&1=b');
  }

  /** Full message: original headers, the text/html part (or text/plain), and attachments. */
  async fetchMessage(archiveUrl: string): Promise<ArchiveMessage | null> {
    const page = await this.get(archiveUrl);
    const headers = parseArchiveHeaders(page);
    const attachments: { url: string; type: string }[] = [];
    const seen = new Set<string>();
    for (const m of page.matchAll(/href="(\/cgi-bin\/wa\?A3=[^"]+)"[^>]*>([^<]+)<\/a>/g)) {
      const url = `https://lists.princeton.edu${m[1].replace(/&amp;/g, '&')}`;
      if (seen.has(url)) continue;
      seen.add(url);
      attachments.push({ url, type: m[2].trim() });
    }
    const htmlPart = attachments.find((a) => a.type.includes('text/html'));
    if (htmlPart) {
      const bodyHtml = await this.get(htmlPart.url.replace('&header=1', ''));
      return { headers, bodyHtml, bodyPlain: null, attachments: attachments.map((a) => ({ ...a, url: cleanArchiveUrl(a.url) })) };
    }
    const plainPart = attachments.find((a) => a.type.includes('text/plain'));
    if (plainPart) {
      const bodyPlain = await this.get(plainPart.url.replace('&header=1', ''));
      const escaped = bodyPlain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return { headers, bodyHtml: `<pre>${escaped}</pre>`, bodyPlain, attachments: attachments.map((a) => ({ ...a, url: cleanArchiveUrl(a.url) })) };
    }
    return null;
  }
}
