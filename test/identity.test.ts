import assert from 'node:assert/strict';
import { stripTitlePlace } from '../src/jobs/places.ts';
import { test } from 'node:test';
import { identityKeys, linkKey, postingRef, type IdentityInput } from '../src/jobs/identity.ts';

const base: IdentityInput = { platform: 'xpressjobs', title: 'Assistant Accountant', company: 'Lanka Biscuit Works (Pvt) Ltd', location: 'Colombo 03' };

test('tier 2 regression table: changing any row re-keys every stored job', () => {
  const cases: [Partial<IdentityInput>, string | null][] = [
    [{}, 'job|lanka biscuit works|assistant accountant|colombo'],
    [{ company: 'LANKA BISCUIT WORKS PLC', location: 'Colombo' }, 'job|lanka biscuit works|assistant accountant|colombo'],
    [{ location: 'Nugegoda' }, 'job|lanka biscuit works|assistant accountant|colombo'],
    [{ location: 'No. 12, Galle Road, Colombo 03, Sri Lanka' }, 'job|lanka biscuit works|assistant accountant|colombo'],
    [{ location: 'Kandy' }, 'job|lanka biscuit works|assistant accountant|kandy'],
    [{ location: null }, 'job|lanka biscuit works|assistant accountant|'],
    [{ location: 'Remote' }, 'job|lanka biscuit works|assistant accountant|'],
    [{ location: 'Sri Lanka' }, 'job|lanka biscuit works|assistant accountant|lk'],
    // I1: a trailing place-only segment is dropped from the title part (was 'assistant accountant colombo').
    [{ title: 'Assistant Accountant - (Colombo)' }, 'job|lanka biscuit works|assistant accountant|colombo'],
    [{ title: 'Software Engineer (Java)', company: 'WSO2 LLC', location: 'Colombo 07' }, 'job|wso2|software engineer java|colombo'],
    [{ title: 'Driver', company: 'Gulf Recruiters (Pvt) Ltd', location: 'Dubai, UAE' }, 'job|gulf recruiters|driver|t:dubai,uae'],
    [{ title: 'Driver', company: null, location: 'Galle', apply_phone: '077 123 4567' }, 'job|#771234567|driver|galle'],
    [{ title: 'Driver', company: null, location: 'Galle', apply_phone: '+94771234567' }, 'job|#771234567|driver|galle'],
    [{ title: 'Cashier', company: null, location: 'Kandy', apply_email: 'HR@Shop.example' }, 'job|@hr@shop.example|cashier|kandy'],
    [{ title: 'Cashier', company: null, location: 'Kandy' }, null],
  ];
  for (const [over, want] of cases) {
    assert.equal(identityKeys({ ...base, ...over }).tier2, want, JSON.stringify(over));
  }
});

test('tier 1: ATS posting id from the apply link beats the source id, so copies collide across sources', () => {
  const gh = 'https://boards.greenhouse.io/wso2/jobs/7123456?gh_src=xpress';
  const a = identityKeys({ ...base, platform: 'xpressjobs', external_id: '991', apply_url: gh });
  const b = identityKeys({ ...base, platform: 'greenhouse', external_id: '7123456', apply_url: 'https://job-boards.greenhouse.io/WSO2/jobs/7123456' });
  assert.equal(a.tier1, 'ats|greenhouse|wso2|7123456');
  assert.equal(a.tier1, b.tier1);
  assert.equal(identityKeys({ ...base, external_id: ' 991 ' }).tier1, 'xpressjobs|991');
  assert.equal(identityKeys({ ...base }).tier1, null);
});

test('postingRef: the ATS patterns ported from ThreatHire', () => {
  assert.equal(postingRef('https://jobs.lever.co/sysco/0a1b2c3d-1111-2222-3333-444455556666'), 'ats|lever|sysco|0a1b2c3d-1111-2222-3333-444455556666');
  assert.equal(postingRef('https://jobs.ashbyhq.com/acme/0a1b2c3d-1111-2222-3333-444455556666/application'), 'ats|ashby|acme|0a1b2c3d-1111-2222-3333-444455556666');
  assert.equal(postingRef('https://jobs.smartrecruiters.com/Virtusa/744000137431220-software-engineer'), 'ats|smartrecruiters|virtusa|744000137431220');
  assert.equal(postingRef('https://virtusa.wd1.myworkdayjobs.com/en-US/Virtusa/job/Colombo/Engineer_R248521-1'), 'ats|workday|virtusa|r248521');
  assert.equal(postingRef('https://virtusa.wd1.myworkdayjobs.com/Virtusa/job/Colombo-Sri-Lanka/Engineer_R248521'), 'ats|workday|virtusa|r248521');
  assert.equal(postingRef('https://careers.dialog.lk/'), null);
  assert.equal(postingRef(null), null);
});

test('tier 1b: only links with an id-shaped segment, and only with a company', () => {
  assert.equal(linkKey('https://www.careers.keells.com/jobs/view/123456/?utm_source=fb&ref=x'), 'careers.keells.com/jobs/view/123456');
  assert.equal(linkKey('https://careers.keells.com/apply?b=2&jobId=98765&a=1'), 'careers.keells.com/apply?a=1&b=2&jobId=98765');
  assert.equal(linkKey('https://careers.keells.com/careers'), null, 'a generic careers page is not an identity');
  assert.equal(linkKey('mailto:hr@x.lk'), null);
  const k = identityKeys({ ...base, apply_url: 'https://careers.lbw.lk/vacancy/2026110045' });
  assert.equal(k.tier1b, 'url|lanka biscuit works|careers.lbw.lk/vacancy/2026110045');
  assert.equal(identityKeys({ ...base, company: null, apply_url: 'https://careers.lbw.lk/vacancy/2026110045' }).tier1b, null);
});

test('tier 2 ignores a trailing place-only title segment (I1: XpressJobs appends "| Colombo 03")', () => {
  const base = { platform: 'x', company: 'College of Contract Management United Kingdom', location: 'Colombo 3, Colombo' };
  const a = identityKeys({ ...base, title: 'Business Development Executive | Colombo 03' });
  const b = identityKeys({ ...base, platform: 'y', title: 'Business Development Executive', location: 'Colombo, Western Province' });
  assert.equal(a.tier2, b.tier2);
  assert.equal(stripTitlePlace('Call Center Executive - Female (Kiribathgoda)'), 'Call Center Executive - Female');
  assert.equal(stripTitlePlace('Teller - Kandy'), 'Teller');
  for (const t of ['Sales Executive - Colombo Branch', 'Manager - Software Engineering', 'Kandy', 'Senior Executive | Executive - Procurement'])
    assert.equal(stripTitlePlace(t), t, t);
});

test('tier 1: both public Workday URL forms give the same posting id (I1)', () => {
  const a = postingRef('https://wd5.myworkdaysite.com/recruiting/sysco/syscocareers/job/Sysco-LABS-----Sri-Lanka/Senior-Software-Engineer_R274043');
  const b = postingRef('https://sysco.wd5.myworkdayjobs.com/syscocareers/job/Sysco-LABS-----Sri-Lanka/Senior-Software-Engineer_R274043');
  assert.equal(a, 'ats|workday|sysco|r274043');
  assert.equal(a, b);
});
