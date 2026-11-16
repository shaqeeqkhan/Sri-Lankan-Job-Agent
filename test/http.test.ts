import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SljError } from '../src/errors.ts';
import { backoffMs, classifyFailure, createHttpClient, parseRetryAfter } from '../src/sources/http.ts';

/** A virtual clock: sleeps resolve in wake-time order, one per macrotask, and advance the clock. */
function fakeClock() {
  let t = 1_000_000;
  const pending: { at: number; seq: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];
  let seq = 0;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    pending.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = pending.shift();
    if (!next) return;
    t = Math.max(t, next.at);
    next.resolve();
    if (pending.length) schedule();
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  };
  return {
    now: () => t,
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => {
        pending.push({ at: t + ms, seq: seq++, resolve });
        schedule();
      });
    },
  };
}

type Step = number | { status: number; headers?: Record<string, string>; body?: string } | Error;

/** A fetch that answers each URL from a script of steps, recording [url, virtual time]. */
function scripted(clock: { now(): number }, script: Record<string, Step[]>) {
  const calls: { url: string; at: number }[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = input.toString();
    calls.push({ url, at: clock.now() });
    const steps = script[url];
    const step = steps && steps.length > 1 ? steps.shift()! : steps?.[0] ?? 200;
    if (step instanceof Error) throw step;
    const s = typeof step === 'number' ? { status: step } : step;
    return new Response(s.body ?? `ok ${url}`, { status: s.status, headers: s.headers });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

test('throttle: one host is paced, another host never waits on it', async () => {
  const clock = fakeClock();
  const f = scripted(clock, {});
  const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now, defaultDelayMs: 1500 });
  const a = 'https://a.lk/';
  const b = 'https://b.lk/';
  await Promise.all([http.get(a + '1'), http.get(a + '2'), http.get(a + '3'), http.get(b + '1'), http.get(b + '2')]);
  const at = (u: string) => f.calls.find((c) => c.url === u)!.at - 1_000_000;
  assert.equal(at(a + '1'), 0);
  assert.equal(at(a + '2'), 1500);
  assert.equal(at(a + '3'), 3000);
  assert.equal(at(b + '1'), 0, 'b.lk does not wait behind a.lk');
  assert.equal(at(b + '2'), 1500);
  // b.lk/1 was sent before a.lk/2, though it was asked for later.
  const order = f.calls.map((c) => c.url);
  assert.ok(order.indexOf(b + '1') < order.indexOf(a + '2'));
});

test('throttle: a per-call delayMs overrides the default; 0 means no pacing', async () => {
  const clock = fakeClock();
  const f = scripted(clock, {});
  const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now, defaultDelayMs: 1500 });
  await http.get('https://a.lk/1', { delayMs: 500 });
  await http.get('https://a.lk/2', { delayMs: 500 });
  assert.deepEqual(clock.sleeps, [500]);
  const none = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now });
  await none.get('https://c.lk/1');
  await none.get('https://c.lk/2');
  assert.deepEqual(clock.sleeps, [500]);
});

const retryTable: { name: string; steps: Step[]; status?: number; throws?: boolean; attempts: number; waits: number[] }[] = [
  { name: '200 first time', steps: [200], status: 200, attempts: 1, waits: [] },
  { name: '502 then 200', steps: [502, 200], status: 200, attempts: 2, waits: [1000] },
  { name: '504 ×3 returns the last 504 after 2 retries', steps: [504, 504, 504, 200], status: 504, attempts: 3, waits: [1000, 2000] },
  { name: '503 then 200', steps: [503, 200], status: 200, attempts: 2, waits: [1000] },
  { name: '404 is an answer, never retried', steps: [404, 200], status: 404, attempts: 1, waits: [] },
  { name: '403 never retried', steps: [403, 200], status: 403, attempts: 1, waits: [] },
  { name: '429 returned to the caller, not retried', steps: [{ status: 429, headers: { 'retry-after': '5' } }, 200], status: 429, attempts: 1, waits: [] },
  { name: '500 not retried', steps: [500, 200], status: 500, attempts: 1, waits: [] },
  { name: 'connect error ×2 then 200', steps: [netErr('ECONNREFUSED'), netErr('ENOTFOUND'), 200], status: 200, attempts: 3, waits: [1000, 2000] },
  { name: 'connect error ×3 fails', steps: [netErr('ECONNREFUSED'), netErr('ECONNREFUSED'), netErr('ECONNREFUSED'), 200], throws: true, attempts: 3, waits: [1000, 2000] },
  { name: 'read error ×1 then 200', steps: [netErr('ECONNRESET'), 200], status: 200, attempts: 2, waits: [1000] },
  { name: 'read error ×2 fails', steps: [netErr('UND_ERR_BODY_TIMEOUT'), netErr('ECONNRESET'), 200], throws: true, attempts: 2, waits: [1000] },
  { name: 'unknown error not retried', steps: [new Error('boom'), 200], throws: true, attempts: 1, waits: [] },
  { name: 'total budget 3: connect, connect, 502, then the 502 is returned', steps: [netErr('ECONNREFUSED'), netErr('ECONNREFUSED'), 502, 502, 200], status: 502, attempts: 4, waits: [1000, 2000, 4000] },
];

for (const row of retryTable) {
  test(`retry: ${row.name}`, async () => {
    const clock = fakeClock();
    const url = 'https://x.lk/page';
    const f = scripted(clock, { [url]: [...row.steps] });
    const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now });
    if (row.throws) {
      await assert.rejects(http.get(url), (e: unknown) => e instanceof SljError && e.code === 'FETCH_FAILED');
    } else {
      const res = await http.get(url);
      assert.equal(res.status, row.status);
    }
    assert.equal(f.calls.length, row.attempts);
    assert.deepEqual(clock.sleeps, row.waits);
  });
}

test('Retry-After is honoured on 503, capped at 30 s', async () => {
  for (const [header, wait] of [['7', 7000], ['3600', 30_000], ['0', 1000]] as const) {
    const clock = fakeClock();
    const url = 'https://x.lk/r';
    const f = scripted(clock, { [url]: [{ status: 503, headers: { 'retry-after': header } }, 200] });
    const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now });
    assert.equal((await http.get(url)).status, 200);
    assert.deepEqual(clock.sleeps, [wait], `Retry-After: ${header}`);
  }
});

test('Retry-After is ignored on 502', async () => {
  const clock = fakeClock();
  const url = 'https://x.lk/r';
  const f = scripted(clock, { [url]: [{ status: 502, headers: { 'retry-after': '20' } }, 200] });
  const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now });
  await http.get(url);
  assert.deepEqual(clock.sleeps, [1000]);
});

test('retries go back through the host throttle', async () => {
  const clock = fakeClock();
  const url = 'https://x.lk/t';
  const f = scripted(clock, { [url]: [502, 200] });
  const http = createHttpClient({ fetch: f.fetch, sleep: clock.sleep, now: clock.now, defaultDelayMs: 1500 });
  await http.get(url);
  // backoff 1 s, then 0.5 s more to reach the host's next slot
  assert.deepEqual(clock.sleeps, [1000, 500]);
  assert.equal(f.calls[1].at - f.calls[0].at, 1500);
});

test('response: lower-cased headers, final url, body cap, postJson body', async () => {
  const seen: { method?: string; body?: unknown; headers?: Headers }[] = [];
  const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: init?.method, body: init?.body, headers: new Headers(init?.headers) });
    return new Response('{"a":1}', { status: 200, headers: { 'X-Thing': 'y', 'content-type': 'application/json' } });
  }) as typeof fetch;
  const http = createHttpClient({ fetch: fn, userAgent: 'TestAgent/1' });
  const res = await http.postJson('https://api.x.lk/search', { q: 'x' });
  assert.equal(res.headers['x-thing'], 'y');
  assert.equal(res.url, 'https://api.x.lk/search');
  assert.equal(res.text, '{"a":1}');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body, '{"q":"x"}');
  assert.equal(seen[0].headers!.get('content-type'), 'application/json');
  assert.equal(seen[0].headers!.get('user-agent'), 'TestAgent/1');

  const big = createHttpClient({ fetch: (async () => new Response('x'.repeat(2000))) as typeof fetch, maxBytes: 1000 });
  await assert.rejects(big.get('https://x.lk/big'), (e: unknown) => e instanceof SljError && e.code === 'FETCH_FAILED');
});

test('helpers: classifyFailure, parseRetryAfter, backoffMs', () => {
  assert.equal(classifyFailure(netErr('ECONNREFUSED')), 'connect');
  assert.equal(classifyFailure(netErr('UND_ERR_CONNECT_TIMEOUT')), 'connect');
  assert.equal(classifyFailure(netErr('ECONNRESET')), 'read');
  assert.equal(classifyFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'read');
  assert.equal(classifyFailure(new Error('nope')), 'other');
  assert.equal(parseRetryAfter('12', 0), 12_000);
  assert.equal(parseRetryAfter(new Date(60_000).toUTCString(), 0), 60_000);
  assert.equal(parseRetryAfter('soon', 0), null);
  assert.deepEqual([1, 2, 3].map(backoffMs), [1000, 2000, 4000]);
});

test('the default undici path works against a local server and follows redirects', async () => {
  const { serve } = await import('./helpers.ts');
  const srv = await serve((req, res) => {
    if (req.url === '/old') {
      res.writeHead(301, { location: '/new' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>${req.headers['user-agent']}</p>`);
  });
  const http = createHttpClient({});
  try {
    const res = await http.get(`${srv.url}/old`);
    assert.equal(res.status, 200);
    assert.equal(res.url, `${srv.url}/new`);
    assert.match(res.text, /SriLankanJobsAgent/);
  } finally {
    await http.close();
    await srv.close();
  }
});
