-- Recurring official events (daily prayer, weekly office hours) share a series so consumers can
-- show only the next few occurrences instead of flooding feeds.
ALTER TABLE events ADD COLUMN IF NOT EXISTS series_id text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS series_size integer;
CREATE INDEX IF NOT EXISTS events_series_idx ON events (series_id) WHERE series_id IS NOT NULL;
