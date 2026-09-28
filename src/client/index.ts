/**
 * Typed HTTP client for InboxEngine consumers (The Forum, TigerInbox, PI, …).
 * Dependency-free; works in Node ≥18, Bun and edge runtimes.
 */
import type { EventTag } from '../events/taxonomy.ts';

export type EngineOrganization = {
  id: string;
  name: string;
  aliases: string[];
  groupType: string | null;
  categories: string[];
  forumCategory: string | null;
  acronym: string | null;
  tagline: string | null;
  description: string | null;
  whatWeDo: string | null;
  website: string | null;
  contactEmail: string | null;
  socials: Partial<Record<'instagram' | 'facebook' | 'linkedin' | 'twitter' | 'youtube', string>>;
  memberCount: number | null;
  websites: string[];
  groupUrl: string | null;
  logoUrl: string | null;
  logoSourceUrl: string | null;
  emailCount?: number;
};

export type EngineEvent = {
  id: string;
  /** Only 'active' events should be shown; 'duplicate' repeats an official MyPrincetonU event. */
  status: 'active' | 'withdrawn' | 'duplicate';
  title: string;
  summary: string;
  startsAt: string;
  endsAt: string | null;
  timePrecision: 'exact' | 'date';
  location: {
    text: string | null;
    id: string | null;
    name: string | null;
    latitude: number | null;
    longitude: number | null;
    room: string | null;
    online: boolean;
  };
  tags: EventTag[];
  freeFood: boolean;
  rsvpUrl: string | null;
  host: EngineOrganization | null;
  confidence: number;
  publishable: boolean;
  extractionVersion: string;
  imageUrl: string | null;
  /** Recurring official events share a series (same host + title); `size` counts occurrences in the feed. */
  series: { id: string; size: number } | null;
  duplicateOf: string | null;
  source: {
    kind: 'listserv' | 'myprincetonu';
    messageId: string | null;
    subject: string | null;
    sender: string | null;
    sentAt: string | null;
    listservs: string[];
    url: string | null;
    archiveUrl: string | null;
  };
  updatedAt: string;
  revision: number;
};

export type EngineLocation = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  latitude: number;
  longitude: number;
};

export class InboxEngineError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export class InboxEngineClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000
  ) {}

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) throw new InboxEngineError(res.status, `InboxEngine ${res.status} for ${url.pathname}`);
    return (await res.json()) as T;
  }

  /** Incremental event feed; persist `next` and pass it back as `after`. */
  eventChanges(after: number, limit = 500) {
    return this.get<{ changes: EngineEvent[]; next: number }>('v1/events/changes', { after, limit });
  }

  events(params: { from?: string; to?: string; organization?: string; tag?: EventTag; q?: string; publishable?: boolean; limit?: number; offset?: number } = {}) {
    return this.get<{ total: number; offset: number; results: EngineEvent[] }>('v1/events', params);
  }

  organizations(q = '', limit = 1000) {
    return this.get<{ organizations: EngineOrganization[] }>('v1/organizations', { q, limit });
  }

  locations() {
    return this.get<{ locations: EngineLocation[] }>('v1/locations');
  }

  messageChanges(after: number, limit = 200) {
    return this.get<{ changes: Record<string, unknown>[]; next: number }>('v1/messages/changes', { after, limit });
  }

  status() {
    return this.get<Record<string, unknown>>('v1/status');
  }
}
