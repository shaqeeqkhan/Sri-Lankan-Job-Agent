import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ScrapedJob, SourceAdapter } from '../src/sources/types.ts';
import { tempDir } from './helpers.ts';
import { fixtureContext, readFixture } from './source-helpers.ts';

// A throwaway adapter, written the way a real one is: sitemap over ctx.http, pages over ctx.ladder.
const LISTING = 'https://jobs.example.lk/sitemap.xml';
const exampleAdapter: SourceAdapter = {
  id: 'fixture',
  async scan(ctx) {
    const res = await ctx.http.get(LISTING);
    if (res.status !== 200) throw new Error(`listing HTTP ${res.status}`);
    const urls = [...res.text.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    const jobs: ScrapedJob[] = [];
    const deferred: string[] = [];
    let skippedSeen = 0;
    for (const url of urls) {
      const external_id = url.split('/').pop()!;
      if (ctx.seen(external_id)) {
        skippedSeen++;
        continue;
      }
      const page = await ctx.ladder.page(url, { kind: 'detail', expect: (h) => h.includes('JobPosting') });
      if (!page.ok) {
        deferred.push(external_id);
        continue;
      }
      const ld = page.jsonLd.find((x: any) => x['@type'] === 'JobPosting') as any;
      jobs.push({ title: ld.title, company: ld.hiringOrganization?.name, source_url: url, external_id });
    }
    ctx.log(`${jobs.length} jobs`);
    return { jobs, listed: urls.length, skippedSeen, deferred };
  },
  async recheck(job, ctx) {
    const res = await ctx.http.get(`https://jobs.example.lk/api/jobs/${job.external_id}`);
    if (res.status === 404) return 'unknown';
    return (JSON.parse(res.text) as { open: boolean }).open ? 'alive' : 'closed';
  },
};

const page = (title: string) =>
  `<html><script type="application/ld+json">{"@type":"JobPosting","title":"${title}","hiringOrganization":{"name":"Dialog"}}</script></html>`;

test('fixtureContext serves ladder pages and http bodies from maps, and records calls', async () => {
  const ctx = fixtureContext({
    json: { [LISTING]: '<urlset><url><loc>https://jobs.example.lk/j/1</loc></url><url><loc>https://jobs.example.lk/j/2</loc></url><url><loc>https://jobs.example.lk/j/3</loc></url><url><loc>https://jobs.example.lk/j/4</loc></url></urlset>' },
    pages: {
      'https://jobs.example.lk/j/1': page('Data Analyst'),
      'https://jobs.example.lk/j/2': '<html>redesigned, no data</html>',
    },
    seen: ['4'],
  });
  const r = await exampleAdapter.scan(ctx);
  assert.deepEqual(r.jobs, [{ title: 'Data Analyst', company: 'Dialog', source_url: 'https://jobs.example.lk/j/1', external_id: '1' }]);
  assert.equal(r.listed, 4);
  assert.equal(r.skippedSeen, 1);
  assert.deepEqual(r.deferred, ['2', '3'], 'drifted page and missing page are deferred');
  assert.deepEqual(ctx.calls.http, [{ method: 'GET', url: LISTING }]);
  assert.deepEqual(ctx.calls.pages.map((p) => p.url), ['https://jobs.example.lk/j/1', 'https://jobs.example.lk/j/2', 'https://jobs.example.lk/j/3']);
  assert.equal(ctx.calls.pages[0].req?.kind, 'detail');
  assert.deepEqual(ctx.logs, ['1 jobs']);
  assert.equal(ctx.source.id, 'fixture');
  assert.equal(ctx.ladder.worstTier(), 'T1');
});

test('fixtureContext: JSON bodies, functions of the request, statuses, and config sources', async () => {
  const ctx = fixtureContext({
    source: 'xpressjobs',
    json: {
      'https://jobs.example.lk/api/jobs/1': { open: true },
      'https://jobs.example.lk/api/jobs/2': () => ({ open: false }),
      'https://api.example.lk/search': (_url: string, body?: unknown) => ({ echo: body }),
    },
  });
  assert.equal(ctx.source.id, 'xpressjobs');
  // The real sources.yml entry is loaded (its pacing is a property of the config, not of this helper).
  assert.ok(ctx.source.delay_ms >= 250, 'delay_ms comes from config/sources.yml');
  assert.deepEqual(ctx.source.tiers, ['T0']);
  assert.equal(await exampleAdapter.recheck({ source_url: 'x', external_id: '1' }, ctx), 'alive');
  assert.equal(await exampleAdapter.recheck({ source_url: 'x', external_id: '2' }, ctx), 'closed');
  assert.equal(await exampleAdapter.recheck({ source_url: 'x', external_id: '9' }, ctx), 'unknown');
  const post = await ctx.http.postJson('https://api.example.lk/search', { q: 'Sri Lanka' });
  assert.deepEqual(JSON.parse(post.text), { echo: { q: 'Sri Lanka' } });
  assert.equal(ctx.calls.http.at(-1)?.method, 'POST');
  assert.deepEqual(ctx.calls.http.at(-1)?.body, { q: 'Sri Lanka' });
  const blocked = fixtureContext({ pages: { 'https://x.lk/': { ok: false, block: { reason: 'challenge', detail: 'Cloudflare' } } } });
  assert.equal((await blocked.ladder.page('https://x.lk/')).block?.reason, 'challenge');
});

test('readFixture reads src/sources/<id>/fixtures/<name>', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src/sources/demo/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/sources/demo/fixtures/listing.html'), '<ul><li>job</li></ul>');
  assert.equal(readFixture('demo', 'listing.html', root), '<ul><li>job</li></ul>');
  assert.throws(() => readFixture('demo', 'missing.html', root), /ENOENT/);
});
