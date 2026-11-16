/**
 * PRD M1 gate, end to end through `runScan` (what `slj jobs scan` runs) with the real HTTP door, the real
 * fetch ladder and real Chrome: a forced human-check page opens the visible window, prints ACTION NEEDED,
 * writes browser-status.json `waiting_for_human`, and the scan carries on by itself once the check is gone,
 * with no person pressing anything.
 *
 * Opt-in: it opens a visible Chrome window for ~25 s. Run with SLJ_BROWSER_TEST=1. Skipped (and reported
 * as skipped) otherwise, when SLJ_NO_BROWSER=1, or when Chrome / Playwright is missing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { runScan } from '../src/sources/scan.ts';
import type { ScrapedJob, SourceAdapter } from '../src/sources/types.ts';
import { ROOT, makeCtx, tempDir } from './helpers.ts';

const CHALLENGE_S = 20;

function skipReason(): string | null {
  if (process.env.SLJ_NO_BROWSER === '1') return 'SLJ_NO_BROWSER=1';
  if (process.env.SLJ_BROWSER_TEST !== '1') return 'opens a visible Chrome window; set SLJ_BROWSER_TEST=1 to run it';
  const chrome = ['/Applications/Google Chrome.app', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  if (!chrome.some((p) => fs.existsSync(p))) return 'no Chrome found';
  return null;
}

const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<div id="challenge-stage">Checking your browser before accessing the site.</div>
<script>setTimeout(function(){ location.reload(); }, 2000);</script></body></html>`;
const LISTING = `<!doctype html><html><head><title>Vacancies</title></head><body><ul class="job-list">
<li data-id="101"><a href="/job/101">Software Engineer</a> <span class="co">Test Lanka (Pvt) Ltd</span> <span class="loc">Colombo 03</span></li>
</ul></body></html>`;

test('a forced human check: visible window, ACTION NEEDED, status file, and the scan resumes by itself (T3)', { timeout: 300_000 }, async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  // The "site": a Cloudflare-style page for CHALLENGE_S seconds after the first request, then the listing.
  let first: number | null = null;
  const served: { age: number; challenge: boolean; ua: string }[] = [];
  const server = http.createServer((req, res) => {
    first ??= Date.now();
    const age = (Date.now() - first) / 1000;
    const challenge = age < CHALLENGE_S;
    served.push({ age, challenge, ua: String(req.headers['user-agent'] ?? '') });
    res.writeHead(challenge ? 403 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(challenge ? CHALLENGE : LISTING);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  const configDir = tempDir('slj-hc-config-');
  for (const f of ['settings.yml', 'boards.json']) fs.copyFileSync(path.join(ROOT, 'config', f), path.join(configDir, f));
  fs.writeFileSync(
    path.join(configDir, 'sources.yml'),
    `sources:\n  - {id: hc_local, name: Local human check, kind: board, priority: P1, hosts: [127.0.0.1], enabled: true, slow: false, tiers: [T1, T2, T3, T5], max_details: 10, delay_ms: 1000, options: {listing_url: "http://127.0.0.1:${port}/list"}}\nplatforms: []\n`,
  );
  const ctx = makeCtx({ configDir });
  const statusFile = path.join(ctx.paths.userDir, 'browser-status.json');
  const states: string[] = [];
  const watch = setInterval(() => {
    try {
      const s = JSON.parse(fs.readFileSync(statusFile, 'utf8')).state as string;
      if (states.at(-1) !== s) states.push(s);
    } catch {
      // not written yet
    }
  }, 200);

  const adapter: SourceAdapter = {
    id: 'hc_local',
    async scan(sctx) {
      const url = String(sctx.source.options.listing_url);
      const page = await sctx.ladder.page(url, { kind: 'listing', waitFor: 'ul.job-list', expect: (h) => h.includes('job-list'), noCache: true });
      if (!page.ok) throw new Error(`listing not loaded: ${page.block?.reason}`);
      const jobs: ScrapedJob[] = [...page.html.matchAll(/<li data-id="(\d+)"><a href="([^"]+)">([^<]+)<\/a> <span class="co">([^<]+)<\/span> <span class="loc">([^<]+)<\/span>/g)].map(
        (m) => ({ external_id: m[1], source_url: new URL(m[2], url).toString(), title: m[3], company: m[4], location: m[5], description: 'Two years of experience.' }),
      );
      return { jobs, listed: jobs.length, skippedSeen: 0, deferred: [] };
    },
    recheck: async () => 'unknown',
  };
  const logs: string[] = [];
  try {
    const report = await runScan(ctx, { sources: ['hc_local'] }, { loadAdapter: async () => adapter, log: (m) => void logs.push(m) });
    const s = report.sources[0];
    assert.equal(s.status, 'degraded:T3');
    assert.equal(s.tier, 'T3');
    assert.equal(s.inserted, 1, 'the page behind the check was read and stored');
    assert.ok(logs.some((l) => l.includes('ACTION NEEDED')), 'ACTION NEEDED was printed');
    assert.ok(states.includes('waiting_for_human'), `browser-status.json states: ${states.join(' → ')}`);
    assert.equal(JSON.parse(fs.readFileSync(statusFile, 'utf8')).state, 'idle', 'cleared after the scan');
    assert.ok(served.some((r) => r.challenge && /Mozilla/.test(r.ua)), 'the browser met the check');
    assert.ok(served.some((r) => !r.challenge), 'the real page was fetched after the check went away');
    const st = JSON.parse(fs.readFileSync(ctx.paths.scanStatusFile, 'utf8')).sources.hc_local;
    assert.equal(st.human_solved, true);
    assert.equal(st.challenge, true);
  } finally {
    clearInterval(watch);
    server.close();
    ctx.close();
  }
});
