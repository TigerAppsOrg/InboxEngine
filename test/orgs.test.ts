import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, findOrganization, organizationGroupUrl, organizationLogo, organizations, forumCategory, organizationByEmail } from '../src/orgs/index.ts';

test('registry covers the MyPrincetonU directory with logos and profiles', () => {
  assert.ok(organizations.length >= 727);
  const acm = findOrganization('mpu:52941')!;
  assert.equal(organizationGroupUrl(acm), 'https://my.princeton.edu/feeds?type=club&type_id=52941&tab=about');
  assert.ok(organizationLogo(acm)?.path.startsWith('organization-logos/'));
  assert.ok(organizations.filter((o) => o.profile.description).length > 400);
});

test('exact sender and subject aliases resolve; weak evidence abstains', () => {
  const r = classifyMessage({ subject: '[OrangeHat] Mini-CTF', body: 'Come hack', sender: 'Orangehat Cybersecurity Collective' });
  assert.equal(r.organizationId, 'mpu:71474');
  assert.equal(r.confidence, 'high');
  const none = classifyMessage({ subject: 'Selling my desk', body: 'Pick up at Butler', sender: 'Student' });
  assert.equal(none.organization, 'Campus community');
  assert.equal(none.organizationId, null);
});

test('HoagieMail relay sender is never an identity', () => {
  const r = classifyMessage({ subject: 'hello', body: 'hi', sender: 'HoagieMail' });
  assert.equal(r.organizationId, null);
});

test('registered contact email is a strong sender signal', () => {
  const org = organizations.find((o) => o.profile.email?.endsWith('@princeton.edu') && organizationByEmail(o.profile.email!));
  assert.ok(org);
  const r = classifyMessage({ subject: 'Weekly meeting', body: 'See you there', sender: 'Someone', senderEmail: org!.profile.email });
  assert.equal(r.organizationId, org!.id);
});

test('forum category mapping is total', () => {
  for (const o of organizations) assert.ok(forumCategory(o));
});

test('shared hosting subdomains are not organization evidence for TigerApps', () => {
  const r = classifyMessage({
    subject: 'Community Organizing Wintersession workshop',
    body: 'Sign up at https://wintersession.tigerapps.org/course/123',
    sender: 'A Student'
  });
  assert.notEqual(r.organizationId, 'mpu:70043');
  const own = classifyMessage({ subject: 'News', body: 'Details: https://tigerapps.org/', sender: 'Someone' });
  assert.equal(own.organizationId, 'mpu:70043');
});
