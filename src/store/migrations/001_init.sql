-- InboxEngine schema. Every mutable row carries `revision`, drawn from one global sequence, so
-- consumers can sync incrementally with `?after=<revision>` and never miss or reorder a change.
CREATE SEQUENCE IF NOT EXISTS revision_seq;

CREATE TABLE IF NOT EXISTS messages (
  id                  text PRIMARY KEY,               -- sha256("LIST:archiveId")[:24]; same as TigerInbox IDs
  listserv            text NOT NULL,
  archive_id          text NOT NULL,
  source_url          text,
  subject             text NOT NULL,
  sender_name         text NOT NULL DEFAULT '',
  sender_email        text NOT NULL DEFAULT '',
  via                 text,                             -- 'HoagieMail' when relayed
  sender_attribution  text,
  sent_at             timestamptz NOT NULL,
  preview             text NOT NULL DEFAULT '',
  body_text           text NOT NULL DEFAULT '',
  body_html           text,
  complete            boolean NOT NULL DEFAULT false,   -- full body fetched (not an RSS preview)
  links               jsonb NOT NULL DEFAULT '[]',
  media               jsonb NOT NULL DEFAULT '[]',
  rfc_message_id      text,
  delivery_key        text,
  headers_complete    boolean NOT NULL DEFAULT false,
  canonical_id        text REFERENCES messages(id) ON DELETE SET NULL,
  category            text,
  organization_id     text,
  organization_name   text,
  org_confidence      text,
  org_evidence        jsonb,
  classifier_version  text,
  extraction_version  text,
  extraction_method   text,
  is_event            boolean,
  extraction_notes    jsonb,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  revision            bigint NOT NULL DEFAULT nextval('revision_seq'),
  search              tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(sender_name, '') || ' ' || coalesce(organization_name, '')), 'B') ||
                        setweight(to_tsvector('english', left(coalesce(body_text, ''), 100000)), 'C')
                      ) STORED,
  UNIQUE (listserv, archive_id)
);
CREATE INDEX IF NOT EXISTS messages_sent_at_idx ON messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS messages_revision_idx ON messages (revision);
CREATE INDEX IF NOT EXISTS messages_rfc_idx ON messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_delivery_idx ON messages (delivery_key) WHERE delivery_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_canonical_idx ON messages (canonical_id) WHERE canonical_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_org_idx ON messages (organization_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING gin (search);
CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages (sent_at DESC) WHERE complete = false;

-- Every list a (canonical) message was delivered to.
CREATE TABLE IF NOT EXISTS message_lists (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  listserv   text NOT NULL,
  PRIMARY KEY (message_id, listserv)
);
CREATE INDEX IF NOT EXISTS message_lists_list_idx ON message_lists (listserv);

CREATE TABLE IF NOT EXISTS events (
  id                  text PRIMARY KEY,               -- sha256("messageId#index") or sha256("mpu#eventId"), [:24]
  source              text NOT NULL DEFAULT 'listserv', -- 'listserv' (extracted) | 'myprincetonu' (official feed)
  message_id          text REFERENCES messages(id) ON DELETE CASCADE,
  idx                 integer NOT NULL DEFAULT 0,
  external_id         text,                            -- MyPrincetonU event ID
  external_url        text,
  image_url           text,
  status              text NOT NULL DEFAULT 'active',  -- 'active' | 'withdrawn' | 'duplicate'
  duplicate_of        text,                            -- the official event this listserv extraction repeats
  title               text NOT NULL,
  summary             text NOT NULL DEFAULT '',
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz,
  time_precision      text NOT NULL,
  location_text       text,
  location_id         text,
  location_name       text,
  latitude            double precision,
  longitude           double precision,
  room                text,
  online              boolean NOT NULL DEFAULT false,
  tags                text[] NOT NULL DEFAULT '{}',
  free_food           boolean NOT NULL DEFAULT false,
  rsvp_url            text,
  host_org_id         text,
  host_org_name       text,
  confidence          real NOT NULL,
  publishable         boolean NOT NULL,
  extraction_version  text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  revision            bigint NOT NULL DEFAULT nextval('revision_seq'),
  UNIQUE (message_id, idx),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS events_starts_idx ON events (starts_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS events_revision_idx ON events (revision);
CREATE INDEX IF NOT EXISTS events_org_idx ON events (host_org_id, starts_at);

-- Poller bookkeeping: last success/failure per list.
CREATE TABLE IF NOT EXISTS sources (
  listserv        text PRIMARY KEY,
  last_polled_at  timestamptz,
  last_success_at timestamptz,
  last_error      text,
  failures        integer NOT NULL DEFAULT 0
);
