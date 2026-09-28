import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithRules, resolveLocation, campusLocalToUtc, cleanTitle } from '../src/events/index.ts';
import { mapMpuItem } from '../src/sources/mpu-events.ts';

const sentAt = new Date('2026-09-28T14:00:00Z'); // Monday 10:00 ET

test('venue phrases resolve with rooms', () => {
  assert.equal(resolveLocation('McCosh 50')?.location.name, 'McCosh Hall');
  assert.equal(resolveLocation('McCosh 50')?.room, '50');
  assert.equal(resolveLocation('Frist MPR')?.location.id, 'frist-campus-center');
  assert.equal(resolveLocation('the E-Quad')?.location.id, 'engineering-quadrangle');
  assert.equal(resolveLocation('Zoom')?.location.id, 'online');
  assert.equal(resolveLocation('somewhere nice'), null);
});

test('campus local time converts across DST', () => {
  assert.equal(campusLocalToUtc('2026-09-30T16:30')!.toISOString(), '2026-09-30T20:30:00.000Z');
  assert.equal(campusLocalToUtc('2026-12-01T16:30')!.toISOString(), '2026-12-01T21:30:00.000Z');
});

test('labeled talk is a complete, publishable event', () => {
  const r = extractWithRules({ subject: 'Talk: The Future of AI', body: 'When: Wednesday 4:30-6pm\nWhere: McCosh 50\nSpeaker: Prof. X', sentAt });
  const e = r.events[0];
  assert.ok(r.isEventAnnouncement && e.publishable);
  assert.equal(e.startsAt, '2026-09-30T20:30:00.000Z');
  assert.equal(e.endsAt, '2026-09-30T22:00:00.000Z');
  assert.equal(e.locationName, 'McCosh Hall');
});

test('bare 5:30 means evening', () => {
  const r = extractWithRules({ subject: 'This Monday 5:30 - Dinner and conversation', body: 'Join us in Whitman College for dinner.', sentAt: new Date('2026-09-27T14:00:00Z') });
  assert.equal(r.events[0]?.startsAt, '2026-09-28T21:30:00.000Z');
});

test('sales, deadlines and applications are not events', () => {
  for (const [subject, body] of [
    ['Selling my desk', 'Pick up at Butler by Friday 5pm'],
    ['DUE IN 24 HOURS: Apply for HackPrinceton!', 'Apply now, applications close tomorrow at 11:59pm'],
    ['[APPLY] Business Today', 'Applications due Sunday 11:59pm in Forbes']
  ]) assert.equal(extractWithRules({ subject, body, sentAt }).isEventAnnouncement, false, subject);
});

test('titles lose list tags and shouty prefixes', () => {
  assert.equal(cleanTitle('[WHITMANWIRE] Fwd: TONIGHT: Free boba'), 'Free boba');
});

test('official MyPrincetonU items map to authoritative events', () => {
  const e = mapMpuItem({
    eventId: '1', title: 'GBM', groupId: '52941', group: 'ACM', eventStartDateTime: '2026-10-01T19:30:00-04:00',
    eventEndDateTime: '2026-10-01T20:30:00-04:00', eventLocation: 'Friend Center 101', foodProvided: '1',
    fullDescription: '<p>Come!</p>', eventLink: 'https://my.princeton.edu/ACM/rsvp?id=1', eventTopics: 'Social Event'
  })!;
  assert.equal(e.hostOrgId, 'mpu:52941');
  assert.equal(e.locationId, 'friend-center');
  assert.ok(e.freeFood && e.publishable && e.tags.includes('free food'));
  const ongoing = mapMpuItem({ eventId: '2', title: 'Interest list', eventStartDateTime: '2026-06-01T13:00:00-04:00', eventEndDateTime: '2026-12-31T13:00:00-05:00', eventLocation: 'Private Location (sign in to display)' })!;
  assert.equal(ongoing.publishable, false);
  assert.equal(ongoing.locationText, null);
});
