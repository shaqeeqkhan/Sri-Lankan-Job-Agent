import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, htmlToText } from '../src/jobs/extract.ts';

test('reads a schema.org JobPosting', () => {
  const html = `<html><head><title>ignored</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"JobPosting",
    "title":"Senior Executive - Finance","hiringOrganization":{"@type":"Organization","name":"Ceylon Tea Traders PLC"},
    "jobLocation":{"@type":"Place","address":{"addressLocality":"Colombo 03","addressRegion":"Western"}},
    "validThrough":"2026-11-10T23:59:00+05:30","datePosted":"2026-10-20",
    "description":"<p>ACCA <b>part-qualified</b>.</p><p>Email careers@ceylontea.example</p>",
    "baseSalary":{"currency":"LKR","value":{"minValue":150000,"maxValue":200000,"unitText":"MONTH"}}}]}</script>
  </head><body></body></html>`;
  const x = extract({ html });
  assert.equal(x.fields.title, 'Senior Executive - Finance');
  assert.equal(x.fields.company, 'Ceylon Tea Traders PLC');
  assert.equal(x.fields.location, 'Colombo 03, Western');
  assert.equal(x.fields.closing_date, '2026-11-10');
  assert.equal(x.fields.salary_text, 'LKR 150000 - 200000 per month');
  assert.equal(x.uncertain.includes('title'), false, 'structured title is not uncertain');
});

test('reads the Sri Lankan email-your-CV ad pattern from plain text', () => {
  const text = `VACANCY - ACCOUNTS ASSISTANT
Wijaya Hardware (Pvt) Ltd, Kurunegala
Requirements: G.C.E. A/L Commerce stream, AAT part-qualified.
Salary: Rs. 55,000/- per month
Email your CV with two non-related referees and a recent passport size photograph to hr@wijaya.example.
Please state the position applied for in the subject line.
Closing date: 05/11/2026`;
  const x = extract({ text });
  assert.equal(x.fields.apply_email, 'hr@wijaya.example');
  assert.equal(x.fields.apply_method, 'email');
  assert.equal(x.fields.closing_date, '2026-11-05');
  assert.match(x.fields.subject_instruction!, /position applied for in the subject line/);
  assert.match(x.fields.salary_text!, /Rs\. 55,000/);
  assert.deepEqual(x.fields.required_docs, ['CV', 'Photo', 'Referees']);
  assert.deepEqual(x.uncertain.sort(), ['apply_email', 'closing_date']);
});

test('detects postal applications and envelope instructions', () => {
  const text = `Applications should be sent under registered cover to The Manager, P.O. Box 12, Kandy,
on or before 2nd November 2026. The post applied for should be written on the top left hand corner of the envelope.`;
  const x = extract({ text });
  assert.equal(x.fields.apply_method, 'post');
  assert.equal(x.fields.closing_date, '2026-11-02');
  assert.match(x.fields.subject_instruction!, /top left hand corner of the envelope/);
});

test('several emails are not guessed', () => {
  const x = extract({ text: 'Contact info@a.example or jobs@b.example. Closing date: 1/12/2026' });
  assert.equal(x.fields.apply_email, undefined);
  assert.deepEqual(x.candidates.emails, ['info@a.example', 'jobs@b.example']);
  assert.ok(x.warnings.some((w) => /2 email addresses/.test(w)));
});

test('finds Sri Lankan phone numbers and WhatsApp-method ads', () => {
  const x = extract({ text: 'Drivers wanted. Call or WhatsApp 077 123 4567 or +94 71-234-5678' });
  assert.deepEqual(x.candidates.phones, ['0771234567', '+94712345678']);
  assert.equal(x.fields.apply_method, 'phone');
});

test('flags image-only pages', () => {
  const x = extract({ html: '<html><body><img src="ad.jpg"><p>Vacancy</p></body></html>' });
  assert.equal(x.fields.is_image_ad, true);
  assert.ok(x.warnings.some((w) => /image/.test(w)));
});

test('htmlToText drops scripts and decodes entities', () => {
  assert.equal(htmlToText('<p>A&amp;B&#39;s&nbsp;job</p><script>evil()</script><p>x</p>'), "A&B's job\nx");
});
