import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colomboToday, closePassedJobs, getJob, listJobs, loadSeen, markSeen, seenHash, storedKeysFor, upsertJob, type StoreInput } from '../src/jobs/store.ts';
import { makeCtx } from './helpers.ts';

const NOW = new Date('2026-11-15T04:00:00Z');
const PRECEDENCE = ['greenhouse', 'xpressjobs', 'ikman', 'topjobs'];

function job(over: Partial<StoreInput> = {}): StoreInput {
  return {
    title: 'Data Analyst',
    company: 'Serendib Analytics (Pvt) Ltd',
    location: 'Colombo 03',
    platform: 'xpressjobs',
    apply_method: 'email',
    apply_email: 'jobs@serendib.example',
    closing_date: '2026-11-30',
    ...over,
  };
}

function put(ctx: ReturnType<typeof makeCtx>, source: string, ref: string, over: Partial<StoreInput> = {}, now = NOW) {
  return upsertJob(ctx.db(), job({ platform: source, external_id: ref, ...over }), { source, source_ref: ref, source_url: `https://${source}.example/${ref}` }, now, { precedence: PRECEDENCE });
}

const count = (ctx: ReturnType<typeof makeCtx>) => ctx.db().prepare('SELECT COUNT(*) FROM jobs').pluck().get();

test('identity columns and district are stored; internal keys stay internal', () => {
  const ctx = makeCtx({ now: NOW });
  const { id } = put(ctx, 'xpressjobs', '991');
  const row = ctx.db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  assert.equal(row.identity_t1, 'xpressjobs|991');
  assert.equal(row.identity_t2, 'job|serendib analytics|data analyst|colombo');
  assert.equal(row.district, 'Colombo');
  const full = getJob(ctx.db(), id)! as any;
  assert.equal(full.district, 'Colombo');
  assert.equal('identity_t1' in full, false);
});

test('dedupe: same source ref, then tier 1, tier 1b, tier 2; a different place is a different job', () => {
  const ctx = makeCtx({ now: NOW });
  const a = put(ctx, 'xpressjobs', '991');
  assert.equal(put(ctx, 'xpressjobs', '991').outcome, 'unchanged');

  // tier 1: the same ATS posting found through two boards.
  const gh = 'https://boards.greenhouse.io/serendib/jobs/7001';
  const g1 = put(ctx, 'ikman', 'ik-1', { title: 'Analyst', company: 'Other name', apply_url: gh });
  const g2 = put(ctx, 'topjobs', 'tj-1', { title: 'Data Analyst II', company: 'Different', apply_url: gh });
  assert.equal(g2.id, g1.id);
  assert.equal(g2.matched_by, 'tier1');

  // tier 1b: same company + an id-shaped apply link, even after a retitle.
  const l1 = put(ctx, 'ikman', 'ik-2', { title: 'BI Developer', apply_url: 'https://careers.serendib.example/vacancy/2026110045' });
  const l2 = put(ctx, 'topjobs', 'tj-2', { title: 'Business Intelligence Developer', apply_url: 'https://www.careers.serendib.example/vacancy/2026110045/?utm_source=fb' });
  assert.equal(l2.id, l1.id);
  assert.equal(l2.matched_by, 'tier1b');

  // tier 2: company + title + district; "Nugegoda" and "Colombo 03" are both Colombo district.
  const t2 = put(ctx, 'ikman', 'ik-3', { location: 'Nugegoda', company: 'SERENDIB ANALYTICS PLC' });
  assert.equal(t2.id, a.id);
  assert.equal(t2.matched_by, 'tier2');
  // ...but Kandy is another opening.
  assert.notEqual(put(ctx, 'ikman', 'ik-4', { location: 'Kandy' }).id, a.id);
  // A copy that names no place joins the one candidate there is for that company + title.
  const noPlace = put(ctx, 'topjobs', 'tj-5', { title: 'Accounts Clerk', location: 'Galle' });
  assert.equal(put(ctx, 'ikman', 'ik-5', { title: 'Accounts Clerk', location: null }).matched_by, 'tier2_place');
  assert.equal(put(ctx, 'ikman', 'ik-5', { title: 'Accounts Clerk', location: null }).id, noPlace.id);
  assert.equal(count(ctx), 5);
});

test('a placeless copy with two candidates is not guessed', () => {
  const ctx = makeCtx({ now: NOW });
  put(ctx, 'ikman', 'a', { location: 'Kandy' });
  put(ctx, 'ikman', 'b', { location: 'Galle' });
  assert.equal(put(ctx, 'topjobs', 'c', { location: null }).outcome, 'inserted');
});

test('precedence: a later source only fills nulls; an earlier one takes the row over; order of arrival does not matter', () => {
  const lower = { salary_text: 'Rs. 80,000', closing_date: '2026-12-05', description: 'ikman text', category: 'IT' };
  const higher = { salary_text: 'LKR 90,000–110,000', closing_date: '2026-11-30', description: 'xpress text', category: null };
  const state = (ctx: ReturnType<typeof makeCtx>) =>
    ctx.db().prepare('SELECT source, salary_text, closing_date, description, category FROM jobs').get();

  const a = makeCtx({ now: NOW });
  put(a, 'xpressjobs', 'x1', higher);
  put(a, 'ikman', 'i1', lower);
  const b = makeCtx({ now: NOW });
  put(b, 'ikman', 'i1', lower);
  put(b, 'xpressjobs', 'x1', higher);
  const want = { source: 'xpressjobs', salary_text: 'LKR 90,000–110,000', closing_date: '2026-11-30', description: 'xpress text', category: 'IT' };
  assert.deepEqual({ ...(state(a) as object) }, want);
  assert.deepEqual({ ...(state(b) as object) }, want);
  const id = (a.db().prepare('SELECT id FROM jobs').pluck().get() as string);
  assert.equal(getJob(a.db(), id)!.sources.length, 2, 'every copy is recorded in job_sources');
});

test('passed closing dates close jobs and hide them; an extended date reopens', () => {
  const ctx = makeCtx({ now: NOW });
  const { id } = put(ctx, 'xpressjobs', 'old', { closing_date: '2026-11-10', title: 'Old job' });
  put(ctx, 'xpressjobs', 'new', { closing_date: '2026-11-20', title: 'New job' });
  assert.equal(closePassedJobs(ctx.db(), NOW), 1);
  assert.equal(closePassedJobs(ctx.db(), NOW), 0);
  const base = { include_closed: false, sort: 'closing' as const, limit: 50, offset: 0 };
  const today = colomboToday(NOW);
  assert.deepEqual(listJobs(ctx.db(), base, today).jobs.map((j) => j.title), ['New job']);
  assert.equal(listJobs(ctx.db(), { ...base, include_closed: true }, today).total, 2);
  const row = getJob(ctx.db(), id)!;
  assert.equal(row.closed_reason, 'closing_date_passed');
  put(ctx, 'xpressjobs', 'old', { closing_date: '2026-11-25', title: 'Old job' });
  assert.equal(getJob(ctx.db(), id)!.closed_at, null, 'the closing date was pushed back');
  assert.deepEqual(listJobs(ctx.db(), { ...base, district: 'colombo' }, today).total, 2);
});

test('seen table helpers and stored keys for deferred ids', () => {
  const ctx = makeCtx({ now: NOW });
  markSeen(ctx.db(), 'xpressjobs', '991', NOW);
  markSeen(ctx.db(), 'xpressjobs', '991', NOW);
  const seen = loadSeen(ctx.db(), 'xpressjobs');
  assert.equal(seen.size, 1);
  assert.ok(seen.has(seenHash('991')));
  assert.equal(loadSeen(ctx.db(), 'ikman').size, 0);
  put(ctx, 'xpressjobs', '991');
  assert.deepEqual(storedKeysFor(ctx.db(), 'xpressjobs', ['991']).sort(), ['job|serendib analytics|data analyst|colombo', 'xpressjobs|991']);
  assert.deepEqual(storedKeysFor(ctx.db(), 'xpressjobs', ['nope']), []);
});
