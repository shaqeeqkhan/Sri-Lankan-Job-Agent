import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHALLENGE_MARKERS, classifyChallenge, detectChallengeInHtml, jobPostings } from '../src/sources/browser.ts';

const longText = 'Responsibilities include preparing monthly accounts, reconciling bank statements and supporting the audit. '.repeat(40);

const cases: { name: string; html: string; expect: string | null }[] = [
  {
    name: 'Cloudflare interstitial by title',
    html: '<html><head><title>Just a moment...</title></head><body><div>Checking your connection</div></body></html>',
    expect: 'cloudflare',
  },
  {
    name: 'Cloudflare challenge form',
    html: '<html><head><title>topjobs</title></head><body><form id="challenge-form" action="/x"></form></body></html>',
    expect: 'cloudflare',
  },
  {
    name: 'Cloudflare "Attention Required"',
    html: '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>',
    expect: 'cloudflare',
  },
  {
    name: 'Turnstile on a thin page',
    html: '<html><head><title>Verify</title></head><body><div class="cf-turnstile" data-sitekey="x"></div></body></html>',
    expect: 'turnstile',
  },
  {
    name: 'DataDome iframe',
    html: '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=1"></iframe></body></html>',
    expect: 'datadome',
  },
  {
    name: 'PerimeterX',
    html: '<html><body><div id="px-captcha"></div></body></html>',
    expect: 'perimeterx',
  },
  {
    name: 'generic "verify you are human" text',
    html: '<html><head><title>jobs.lk</title></head><body><h1>Please verify you are a human</h1></body></html>',
    expect: 'generic',
  },
  {
    name: 'DDoS-Guard title',
    html: '<html><head><title>DDoS-Guard</title></head><body></body></html>',
    expect: 'generic',
  },
  {
    name: 'reCAPTCHA alone on a near-empty page',
    html: '<html><head><title>Access check</title></head><body><div class="g-recaptcha" data-sitekey="x"></div></body></html>',
    expect: 'recaptcha',
  },
  {
    name: 'hCaptcha alone on a near-empty page',
    html: '<html><body><div class="h-captcha"></div></body></html>',
    expect: 'hcaptcha',
  },
  {
    name: 'apply form with a reCAPTCHA widget on a real job page does NOT count',
    html: `<html><head><title>Assistant Accountant | Example (Pvt) Ltd</title></head><body>
      <h1>Assistant Accountant</h1><div class="description">${longText}</div>
      <form action="/apply"><input name="email"><div class="g-recaptcha" data-sitekey="x"></div>
      <iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe><button>Apply</button></form></body></html>`,
    expect: null,
  },
  {
    name: 'contact form with hCaptcha and Turnstile on a long page does NOT count',
    html: `<html><body><main>${longText}</main><form><div class="h-captcha"></div><div class="cf-turnstile"></div></form></body></html>`,
    expect: null,
  },
  {
    name: 'script text mentioning captcha is not visible text',
    html: `<html><head><title>Jobs</title><script>var msg = "verify you are human";</script></head><body><p>Open jobs</p></body></html>`,
    expect: null,
  },
  {
    name: 'ordinary listing page',
    html: '<html><head><title>topjobs | Vacancy Browse</title></head><body><table><tr id="tr0"><td>Software Engineer</td></tr></table></body></html>',
    expect: null,
  },
];

for (const c of cases) {
  test(`detectChallengeInHtml: ${c.name}`, () => {
    assert.equal(detectChallengeInHtml(c.html), c.expect);
  });
}

test('classifyChallenge is self-contained, so its source can run inside the page', () => {
  // The in-page detector is built from classifyChallenge.toString(); it must not reference anything outside itself.
  const rebuilt = new Function(`return (${classifyChallenge.toString()});`)() as typeof classifyChallenge;
  const probe = { title: 'Just a moment...', text: '', has: () => false };
  assert.equal(rebuilt(probe, CHALLENGE_MARKERS), 'cloudflare');
  assert.equal(rebuilt({ title: 'Jobs', text: 'hello', has: () => false }, CHALLENGE_MARKERS), null);
  // The markers survive JSON, as they are sent into the page that way.
  assert.deepEqual(JSON.parse(JSON.stringify(CHALLENGE_MARKERS)), CHALLENGE_MARKERS);
});

test('jobPostings filters JSON-LD for JobPosting', () => {
  const items = [{ '@type': 'JobPosting', title: 'A' }, { '@type': ['Thing', 'JobPosting'] }, { '@type': 'Organization' }, null, 'x'];
  assert.equal(jobPostings(items).length, 2);
});
