import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayText, messagePreview, readableText, resolveSender, messageId, parseArchiveHeaders, deliveryKey, sameDelivery, cleanMediaUrl } from '../src/core/index.ts';

test('HoagieMail footer is hidden but author signature kept', () => {
  const body = 'Come to our event!\n- Jane\n\nThis email was instantly sent to all college listservs with Hoagie Mail. Email composed by Jane Doe (jdoe@princeton.edu) — if you believe this email is offensive, please report it to hoagie@princeton.edu.';
  assert.equal(displayText(body), 'Come to our event!\n- Jane');
});

test('LISTSERV unsubscribe footer is removed', () => {
  const body = 'Hello\nTo unsubscribe from the WHITMANWIRE list, click the following link: https://lists.princeton.edu/cgi-bin/wa?SUBED1=WHITMANWIRE&A=1';
  assert.equal(displayText(body), 'Hello');
});

test('preview decodes escaped HTML and truncates', () => {
  assert.equal(messagePreview('&lt;p&gt;Hi &amp; welcome&lt;/p&gt;'), 'Hi & welcome');
  assert.ok(messagePreview('x'.repeat(500)).length <= 230);
});

test('readableText prefers HTML and strips notices', () => {
  const html = '<div>This email was sent to you as a subscriber of WHITMANWIRE@princeton.edu. </div><p>Pizza at <b>Frist</b></p>';
  assert.equal(readableText('', html), 'Pizza at Frist');
});

test('HoagieMail relay is never an author', () => {
  const s = resolveSender({ name: 'HoagieMail', email: 'hoagie@princeton.edu', body: 'Email composed by Pat Lee (plee@princeton.edu)' });
  assert.deepEqual([s.name, s.email, s.via, s.attribution], ['Pat Lee', 'plee@princeton.edu', 'HoagieMail', 'hoagiemail-footer']);
  const unknown = resolveSender({ name: 'HoagieMail', email: 'hoagie@princeton.edu', body: 'no footer' });
  assert.equal(unknown.email, '');
});

test('message IDs match TigerInbox (sha256 of LIST:archiveId)', () => {
  assert.equal(messageId('WHITMANWIRE', 'ind2609&L=WHITMANWIRE&P=1'), messageId('WHITMANWIRE', 'ind2609&L=WHITMANWIRE&P=1'));
  assert.match(messageId('FREEFOOD', 'x'), /^[a-f0-9]{24}$/);
  assert.notEqual(messageId('FREEFOOD', 'x'), messageId('WHITMANWIRE', 'x'));
});

test('archive headers yield RFC identity and residential recipients only', () => {
  const page = `<div class="archive"><b>Message-ID:</b>&lt;abc@mail.com&gt;</div><div class="archive"><b>To:</b>WHITMANWIRE@PRINCETON.EDU, BUTLERBUZZ@princeton.edu, FREEFOOD@princeton.edu</div><div class="archive"><b>From:</b>A &lt;a@b.c&gt;</div><div class="archive"><b>Subject:</b>Hi</div><div class="archive"><b>Date:</b>Mon, 28 Sep 2026 10:00:00 -0400</div>`;
  const h = parseArchiveHeaders(page);
  assert.equal(h.rfcMessageId, 'abc@mail.com');
  assert.deepEqual(h.recipientLists, ['BUTLERBUZZ', 'WHITMANWIRE']);
  assert.ok(h.headersComplete);
  const k1 = deliveryKey(h, '<p>Same   body</p>');
  const k2 = deliveryKey(h, '<p>Same body</p>\nTo unsubscribe from the butlerbuzz list, click the following link: <a href="https://lists.princeton.edu/cgi-bin/wa?SUBED1=butlerbuzz&A=1">https://lists.princeton.edu/cgi-bin/wa?SUBED1=butlerbuzz&A=1</a>');
  assert.ok(k1 && k1 === k2, 'footer-only differences share a delivery key');
  assert.ok(sameDelivery({ deliveryKey: k1, date: '2026-09-28T14:00:00Z' }, { deliveryKey: k2, date: '2026-09-28T14:01:30Z' }));
  assert.ok(!sameDelivery({ deliveryKey: k1, date: '2026-09-28T14:00:00Z' }, { deliveryKey: k2, date: '2026-09-28T14:05:00Z' }));
});

test('media URLs drop LISTSERV session params but keep the attachment offset', () => {
  const url = cleanMediaUrl('https://lists.princeton.edu/cgi-bin/wa?A3=ind2609&L=X&P=123&X=SECRET&Y=me@x');
  assert.ok(url && url.includes('P=123') && !url.includes('SECRET') && !url.includes('Y='));
  assert.equal(cleanMediaUrl('javascript:alert(1)'), null);
});
