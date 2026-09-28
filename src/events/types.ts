import type { EventTag } from './taxonomy.ts';

/** Everything an extractor needs about one email. `body` is readable text (see core/readableText). */
export type ExtractionInput = {
  subject: string;
  body: string;
  sentAt: Date;
  links?: string[];
  listserv?: string;
  /** Resolved sender organization (from the org classifier), used as the default host. */
  organizationId?: string | null;
  organizationName?: string | null;
};

export type ExtractedEvent = {
  title: string;
  summary: string;
  /** ISO-8601 UTC instant. */
  startsAt: string;
  endsAt: string | null;
  /** 'exact' when a clock time was stated; 'date' when only the day is known. */
  timePrecision: 'exact' | 'date';
  locationText: string | null;
  locationId: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  room: string | null;
  online: boolean;
  tags: EventTag[];
  freeFood: boolean;
  rsvpUrl: string | null;
  hostOrganizationId: string | null;
  hostOrganizationName: string | null;
  /** 0–1 policy score, not a calibrated probability. */
  confidence: number;
  /**
   * True when the event is complete and unambiguous enough to show publicly without review:
   * exact start time, a location (campus venue, free-text place or online), confidence ≥ 0.7.
   */
  publishable: boolean;
};

export type ExtractionResult = {
  version: string;
  method: 'rules' | 'llm';
  isEventAnnouncement: boolean;
  events: ExtractedEvent[];
  notes: string[];
};
