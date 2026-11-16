import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { SljError } from '../src/errors.ts';
import type { FetchCallOptions, FetchResult } from '../src/sources/browser.ts';
import { createPageCache } from '../src/sources/cache.ts';
import { createLadder, detectBlock, parseJsonLd, type BrowserLike } from '../src/sources/fetch-ladder.ts';
import type { HttpClient, HttpResponse, SourceConfig, Tier } from '../src/sources/types.ts';
import { tempDir } from './helpers.ts';

const NOW = new Date('2026-11-15T04:00:00Z');
const GOOD = '<html><head><title>Jobs</title></head><body><ul class="jobs"><li class="job">Accountant</li></ul></body></html>';
const JSONLD = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"JobPosting","title":"A"},{"@type":"Organization"}]}</script></head><body>x</body></html>';
const CF = '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>';
const hasJobs = (h: string) => h.includes('class="job"');

function source(tiers: Tier[], over: Partial<SourceConfig> = {}): SourceConfig {
  return { id: 'testsrc', name: 'Test', kind: 'board', hosts: ['a.lk'], enabled: true, slow: false, tiers, max_details: 10, delay_ms: 1500, options: {}, ...over };
}

type HttpServe = Partial<HttpResponse> | Error;
function fakeHttp(routes: Record<string, HttpServe>) {
  const calls: string[] = [];
  const http: HttpClient = {
    async get(url) {
      calls.push(url);
      const r = routes[url];
      if (!r) return { status: 404, url, headers: {}, text: '' };
      if (r instanceof Error) throw r;
      return { status: 200, url, headers: { 'content-type': 'text/html' }, text: '', ...r };
    },
    async postJson() {
      throw new Error('not used');
    },
  };
  return { http, calls };
}

function fakeBrowser(routes: Record<string, Partial<FetchResult> | Error>) {
  const calls: { url: string; opts: FetchCallOptions }[] = [];
  let closed = 0;
  const browser: BrowserLike = {
    async fetch(url, opts) {
      calls.push({ url, opts });
      const r = routes[url];
      if (r instanceof Error) throw r;
      const base: FetchResult = {
        url, finalUrl: url, status: 200, ok: true, blocked: null, challenge: null, humanSolved: false,
        mode: 'headless', title: '', html: '', jsonLd: [], error: null, fetchedAt: NOW.toISOString(),
      };
      if (!r) return { ...base, status: 404, ok: false, blocked: 'http', error: 'HTTP 404' };
      return { ...base, ...r };
    },
    async close() {
      closed++;
    },
  };
  return { browser, calls, closed: () => closed };
}

function make(tiers: Tier[], http: HttpClient, browser: BrowserLike, over: { cacheDir?: string; now?: Date } = {}) {
  const dir = over.cacheDir ?? tempDir('slj-ladder-');
  const logs: string[] = [];
  const sleeps: number[] = [];
  const ladder = createLadder({
    source: source(tiers), http, cacheDir: path.join(dir, 'cache'), userDir: dir,
    now: () => over.now ?? NOW, log: (m) => void logs.push(m), browser,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { ladder, logs, sleeps, dir };
}

test('T1 success: html, JSON-LD, tier, cached for the next call', async () => {
  const h = fakeHttp({ 'https://a.lk/list': { text: GOOD } });
  const b = fakeBrowser({});
  const { ladder } = make(['T0', 'T1', 'T5'], h.http, b.browser);
  const r = await ladder.page('https://a.lk/list', { expect: hasJobs });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'T1');
  assert.equal(r.html, GOOD);
  const again = await ladder.page('https://a.lk/list', { expect: hasJobs });
  assert.equal(again.ok, true);
  assert.equal(h.calls.length, 1, 'second call served from the fresh cache');
  assert.equal(ladder.worstTier(), 'T1');
});

test('T0 label when the page carries JobPosting JSON-LD; @graph flattened', async () => {
  const h = fakeHttp({ 'https://a.lk/job/1': { text: JSONLD } });
  const { ladder } = make(['T0', 'T1', 'T5'], h.http, fakeBrowser({}).browser);
  const r = await ladder.page('https://a.lk/job/1', { kind: 'detail' });
  assert.equal(r.tier, 'T0');
  assert.equal(r.jsonLd.length, 2);
  assert.equal((r.jsonLd[0] as { '@type': string })['@type'], 'JobPosting');
});

test('fall-through: HTTP 403 → browser T2, with a polite gap before the browser', async () => {
  const h = fakeHttp({ 'https://a.lk/list': { status: 403, text: 'Forbidden' } });
  const b = fakeBrowser({ 'https://a.lk/list': { html: GOOD } });
  const { ladder, sleeps, logs } = make(['T1', 'T2', 'T3', 'T5'], h.http, b.browser);
  const r = await ladder.page('https://a.lk/list', { expect: hasJobs, waitFor: '.job', scroll: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'T2');
  assert.deepEqual(sleeps, [1500]);
  assert.deepEqual(b.calls[0].opts, { waitFor: '.job', scroll: 2, handoff: true, headed: false });
  assert.match(logs.join('\n'), /T1 failed \(http: HTTP 403\)/);
  assert.equal(ladder.worstTier(), 'T2');
});

test('fall-through: a challenge page served with 200 on plain HTTP goes to the browser', async () => {
  const h = fakeHttp({ 'https://a.lk/list': { text: CF } });
  const b = fakeBrowser({ 'https://a.lk/list': { html: GOOD } });
  const { ladder } = make(['T1', 'T2', 'T5'], h.http, b.browser);
  const r = await ladder.page('https://a.lk/list');
  assert.equal(r.tier, 'T2');
  assert.equal(b.calls[0].opts.handoff, false, 'T2 without T3 never opens a window');
});

test('T3 label when the browser needed the visible window', async () => {
  const b = fakeBrowser({ 'https://a.lk/list': { html: GOOD, mode: 'headed', humanSolved: true } });
  const { ladder } = make(['T2', 'T3', 'T5'], fakeHttp({}).http, b.browser);
  const r = await ladder.page('https://a.lk/list');
  assert.equal(r.tier, 'T3');
  assert.equal(ladder.worstTier(), 'T3');
});

test('T3 only starts in the visible window', async () => {
  const b = fakeBrowser({ 'https://a.lk/list': { html: GOOD, mode: 'headed' } });
  const { ladder } = make(['T3'], fakeHttp({}).http, b.browser);
  await ladder.page('https://a.lk/list');
  assert.deepEqual(b.calls[0].opts, { waitFor: undefined, scroll: undefined, handoff: true, headed: true });
});

test('drift: expect() false on a big page moves down a tier and says drift', async () => {
  const big = `<html><body>${'<div class="card-new">x</div>'.repeat(1000)}</body></html>`;
  const h = fakeHttp({ 'https://a.lk/list': { text: big } });
  const b = fakeBrowser({ 'https://a.lk/list': { html: big } });
  const { ladder } = make(['T1', 'T2'], h.http, b.browser);
  const r = await ladder.page('https://a.lk/list', { expect: hasJobs });
  assert.equal(r.ok, false);
  assert.equal(r.html, '');
  assert.equal(r.block?.reason, 'drift');
  assert.match(r.block!.detail, /selector drift/);
  assert.equal(b.calls.length, 1, 'browser tier was tried after the drift');
});

test('drift on a small page is labelled a likely soft block', async () => {
  const h = fakeHttp({ 'https://a.lk/list': { text: '<html><body>Nothing here</body></html>' } });
  const { ladder } = make(['T1'], h.http, fakeBrowser({}).browser);
  const r = await ladder.page('https://a.lk/list', { expect: hasJobs });
  assert.equal(r.block?.reason, 'drift');
  assert.match(r.block!.detail, /soft block/);
});

test('login redirect is a block', async () => {
  const h = fakeHttp({ 'https://a.lk/job/9': { url: 'https://a.lk/login?next=/job/9', text: GOOD } });
  const { ladder } = make(['T1'], h.http, fakeBrowser({}).browser);
  const r = await ladder.page('https://a.lk/job/9');
  assert.equal(r.ok, false);
  assert.equal(r.block?.reason, 'login');
});

test('404 is an answer: no browser, no stale copy', async () => {
  const dir = tempDir('slj-ladder-');
  createPageCache({ cacheDir: path.join(dir, 'cache'), source: 'testsrc', now: () => NOW })
    .put({ url: 'https://a.lk/gone', finalUrl: 'https://a.lk/gone', status: 200, html: GOOD, tier: 'T1', fetched_at: '2026-11-01T00:00:00Z' });
  const b = fakeBrowser({ 'https://a.lk/gone': { html: GOOD } });
  const { ladder } = make(['T1', 'T2', 'T5'], fakeHttp({}).http, b.browser, { cacheDir: dir });
  const r = await ladder.page('https://a.lk/gone');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(b.calls.length, 0);
});

test('T5: every live tier fails → last good copy, marked stale with its age', async () => {
  const dir = tempDir('slj-ladder-');
  createPageCache({ cacheDir: path.join(dir, 'cache'), source: 'testsrc', now: () => NOW })
    .put({ url: 'https://a.lk/list', finalUrl: 'https://a.lk/list', status: 200, html: GOOD, tier: 'T1', fetched_at: '2026-11-14T04:00:00Z' });
  const h = fakeHttp({ 'https://a.lk/list': new SljError('FETCH_FAILED', 'Could not reach a.lk: ECONNREFUSED') });
  const { ladder } = make(['T0', 'T1', 'T5'], h.http, fakeBrowser({}).browser, { cacheDir: dir });
  const r = await ladder.page('https://a.lk/list', { kind: 'listing' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'T5');
  assert.equal(r.staleAgeS, 86_400);
  assert.equal(r.html, GOOD);
  assert.equal(ladder.worstTier(), 'T5');
});

test('fresh TTL: a 7 h old listing is refetched, a 7 h old detail is not', async () => {
  const dir = tempDir('slj-ladder-');
  const cache = createPageCache({ cacheDir: path.join(dir, 'cache'), source: 'testsrc', now: () => NOW });
  const at = '2026-11-14T21:00:00Z';
  cache.put({ url: 'https://a.lk/list', finalUrl: 'https://a.lk/list', status: 200, html: GOOD, tier: 'T1', fetched_at: at });
  cache.put({ url: 'https://a.lk/job/1', finalUrl: 'https://a.lk/job/1', status: 200, html: GOOD, tier: 'T1', fetched_at: at });
  const h = fakeHttp({ 'https://a.lk/list': { text: GOOD }, 'https://a.lk/job/1': { text: GOOD } });
  const { ladder } = make(['T1', 'T5'], h.http, fakeBrowser({}).browser, { cacheDir: dir });
  await ladder.page('https://a.lk/list', { kind: 'listing' });
  await ladder.page('https://a.lk/job/1', { kind: 'detail' });
  assert.deepEqual(h.calls, ['https://a.lk/list']);
  await ladder.page('https://a.lk/job/1', { kind: 'detail', noCache: true });
  assert.deepEqual(h.calls, ['https://a.lk/list', 'https://a.lk/job/1']);
});

test('a block never overwrites the last good copy', async () => {
  const dir = tempDir('slj-ladder-');
  const h = fakeHttp({ 'https://a.lk/list': { text: GOOD } });
  const first = make(['T1', 'T5'], h.http, fakeBrowser({}).browser, { cacheDir: dir });
  await first.ladder.page('https://a.lk/list');
  const later = new Date(NOW.getTime() + 10 * 3_600_000);
  const h2 = fakeHttp({ 'https://a.lk/list': { status: 503, text: 'down' } });
  const second = make(['T1', 'T5'], h2.http, fakeBrowser({}).browser, { cacheDir: dir, now: later });
  const r = await second.ladder.page('https://a.lk/list');
  assert.equal(r.tier, 'T5');
  assert.equal(r.html, GOOD);
  assert.equal(r.staleAgeS, 36_000);
});

test('browser stickiness: after HTTP was blocked on a host, its later pages skip HTTP', async () => {
  const h = fakeHttp({
    'https://a.lk/list': { status: 403 },
    'https://a.lk/job/1': { text: GOOD },
    'https://b.lk/job/1': { text: GOOD },
  });
  const b = fakeBrowser({ 'https://a.lk/list': { html: GOOD }, 'https://a.lk/job/1': { html: GOOD } });
  const { ladder } = make(['T1', 'T2', 'T5'], h.http, b.browser);
  await ladder.page('https://a.lk/list');
  const r = await ladder.page('https://a.lk/job/1', { kind: 'detail' });
  assert.equal(r.tier, 'T2');
  assert.deepEqual(h.calls, ['https://a.lk/list'], 'a.lk/job/1 never went over plain HTTP');
  const other = await ladder.page('https://b.lk/job/1');
  assert.equal(other.tier, 'T1', 'another host is unaffected');
});

test('BROWSER_UNAVAILABLE: that tier fails cleanly, once, and the ladder falls to T5', async () => {
  const dir = tempDir('slj-ladder-');
  createPageCache({ cacheDir: path.join(dir, 'cache'), source: 'testsrc', now: () => NOW })
    .put({ url: 'https://a.lk/2', finalUrl: 'https://a.lk/2', status: 200, html: GOOD, tier: 'T2', fetched_at: '2026-11-10T04:00:00Z' });
  const err = new SljError('BROWSER_UNAVAILABLE', 'Playwright is not installed.');
  const b = fakeBrowser({ 'https://a.lk/1': err, 'https://a.lk/2': err });
  const { ladder, logs } = make(['T2', 'T3', 'T5'], fakeHttp({}).http, b.browser, { cacheDir: dir });
  const r1 = await ladder.page('https://a.lk/1');
  assert.equal(r1.ok, false);
  assert.equal(r1.block?.reason, 'error');
  assert.match(r1.block!.detail, /Playwright/);
  const r2 = await ladder.page('https://a.lk/2');
  assert.equal(r2.tier, 'T5');
  assert.equal(b.calls.length, 1, 'the browser is not retried after it proved unavailable');
  assert.equal(logs.filter((l) => /no browser/.test(l)).length, 1);
});

test('a browser-side block (human check timed out) falls to T5', async () => {
  const dir = tempDir('slj-ladder-');
  createPageCache({ cacheDir: path.join(dir, 'cache'), source: 'testsrc', now: () => NOW })
    .put({ url: 'https://a.lk/list', finalUrl: 'https://a.lk/list', status: 200, html: GOOD, tier: 'T3', fetched_at: '2026-11-15T00:00:00Z' });
  const b = fakeBrowser({ 'https://a.lk/list': { ok: false, blocked: 'challenge', challenge: 'cloudflare', mode: 'headed', error: 'Human check not completed in time.' } });
  const { ladder } = make(['T2', 'T3'], fakeHttp({}).http, b.browser, { cacheDir: dir });
  const r = await ladder.page('https://a.lk/list', { noCache: true });
  assert.equal(r.ok, false, 'no T5 in tiers: the block is returned');
  assert.equal(r.block?.reason, 'challenge');
  assert.equal(r.tier, 'T3');
  const { ladder: withT5 } = make(['T2', 'T3', 'T5'], fakeHttp({}).http, b.browser, { cacheDir: dir });
  const s = await withT5.page('https://a.lk/list', { noCache: true });
  assert.equal(s.tier, 'T5');
  assert.equal(s.staleAgeS, 4 * 3600);
});

test('browser calls are serialised even when the adapter asks concurrently', async () => {
  let inFlight = 0;
  let max = 0;
  const browser: BrowserLike = {
    async fetch(url) {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { url, finalUrl: url, status: 200, ok: true, blocked: null, challenge: null, humanSolved: false, mode: 'headless', title: '', html: GOOD, jsonLd: [], error: null, fetchedAt: '' };
    },
    async close() {},
  };
  const { ladder } = make(['T2'], fakeHttp({}).http, browser);
  await Promise.all([1, 2, 3, 4].map((i) => ladder.page(`https://a.lk/${i}`)));
  assert.equal(max, 1);
});

test('worstTier before any page is the first configured tier; close() closes the browser', async () => {
  const b = fakeBrowser({});
  const { ladder } = make(['T0', 'T1', 'T5'], fakeHttp({}).http, b.browser);
  assert.equal(ladder.worstTier(), 'T0');
  await ladder.close();
  assert.equal(b.closed(), 1);
});

test('detectBlock table', () => {
  const ok = { status: 200, html: GOOD, finalUrl: 'https://a.lk/x' };
  assert.equal(detectBlock(ok), null);
  assert.equal(detectBlock({ ...ok, status: 403 })?.reason, 'http');
  assert.equal(detectBlock({ ...ok, status: 429 })?.reason, 'http');
  assert.equal(detectBlock({ ...ok, status: 503 })?.reason, 'http');
  assert.equal(detectBlock({ ...ok, status: 403, html: CF })?.reason, 'challenge');
  assert.equal(detectBlock({ ...ok, finalUrl: 'https://a.lk/users/sign_in' })?.reason, 'login');
  assert.equal(detectBlock({ ...ok, url: 'https://a.lk/login', finalUrl: 'https://a.lk/login' }), null, 'a page that is itself a sign-in page');
  assert.equal(detectBlock({ status: null, html: '', finalUrl: 'https://a.lk/' }), null);
});

test('parseJsonLd: arrays, @graph, comments, broken blocks', () => {
  const html = `<script type="application/ld+json">[{"@type":"JobPosting"},{"@type":"Place"}]</script>
    <script type='application/ld+json'><!-- {"@type":"Organization"} --></script>
    <script type="application/ld+json">{broken</script>`;
  assert.deepEqual(parseJsonLd(html).map((x) => (x as { '@type': string })['@type']), ['JobPosting', 'Place', 'Organization']);
});
