import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobsTranscribe, matchPrefilter, scoreSave } from '../src/commands/match.ts';
import { execute } from '../src/registry.ts';
import { DESC, item, matchCtx, run, seed } from './match-fixture.ts';

const IMG = 'https://www.topjobs.lk/logo/0000000385/6825cData%20Analyst.jpg';

function seedMixed(ctx: ReturnType<typeof matchCtx>) {
  return seed(ctx, [
    // Text ads: one strong, one thin.
    { ref: 't1', source_url: 'https://xpress.jobs/jobs/t1', title: 'Data Analyst', company: 'Text Strong', location: 'Colombo', closing_date: '2026-11-30', description: DESC() },
    { ref: 't2', source_url: 'https://xpress.jobs/jobs/t2', title: 'Data Analyst', company: 'Text Thin', location: 'Colombo', closing_date: '2026-11-30', description: 'Apply soon.' },
    { ref: 't3', source_url: 'https://xpress.jobs/jobs/t3', title: 'Data Analyst', company: 'Text Mid', location: 'Colombo', closing_date: '2026-11-30', description: 'Some SQL needed.' },
    // An image ad (topjobs): only title, company and place are text.
    {
      ref: 'img', source_url: 'https://www.topjobs.lk/employer/JobAdvertismentServlet?ac=1&jc=1&ec=1', title: 'Data Analyst', company: 'Image Co',
      location: 'Colombo', closing_date: '2026-11-30', description: `Advert image: ${IMG}`, is_image_ad: true,
    },
  ]);
}

test('image ads: prefilter returns is_image_ad and the image URLs, and does not rank them last for lacking text', async () => {
  const ctx = matchCtx();
  seedMixed(ctx);
  const d = await run(matchPrefilter, {}, ctx);
  const img = d.candidates.find((c: any) => c.company === 'Image Co');
  assert.equal(img.is_image_ad, true);
  assert.deepEqual(img.image_urls, [IMG]);
  assert.equal(img.transcribed, false);
  assert.equal(img.prefilter.skills_imputed, true);
  // Its skills score is the pool's typical (median) text ad, not 0: above the thin text ad.
  const by = (co: string) => d.candidates.find((c: any) => c.company === co).prefilter;
  assert.ok(img.prefilter.skills > 0);
  assert.ok(img.prefilter.total > by('Text Thin').total, 'an unread image ad is not below a thin text ad');
  assert.ok(img.prefilter.total <= by('Text Strong').total);
  const text = d.candidates.find((c: any) => c.company === 'Text Strong');
  assert.equal(text.is_image_ad, false);
  assert.ok(!('image_urls' in text));
});

test('image ads: score save refuses an untranscribed image ad; quotes are checked against the transcription', async () => {
  const ctx = matchCtx();
  const ids = seedMixed(ctx);
  const imgId = ids[3];

  const before = (await execute(scoreSave, { scores: [item(imgId, 70)] }, ctx)) as any;
  assert.equal(before.data.failed, 1);
  assert.match(before.data.errors[0].problems.join(' '), /image ad .* jobs transcribe/);

  // Only image ads take a transcription.
  const notImage = (await execute(jobsTranscribe, { id: ids[0], text: 'This is a text ad already, nothing to transcribe.' }, ctx)) as any;
  assert.equal(notImage.ok, false);
  assert.equal(notImage.error.code, 'INVALID_INPUT');

  const scoredBefore = (await run(matchPrefilter, {}, ctx)).candidates.find((c: any) => c.id === imgId);
  const t = await run(jobsTranscribe, { id: imgId, text: 'DATA ANALYST\nRequirements: 2+ years of SQL. Experience with Power BI dashboards. <b>Apply</b> by 30 Nov.' }, ctx);
  assert.equal(t.replaced, false);

  // A quote that is not in the transcription is still rejected.
  const wrong = (await execute(scoreSave, { scores: [item(imgId, 70, { requirements: [{ text: 'AWS', jd_quote: '3 years of AWS', status: 'missing' }] })] }, ctx)) as any;
  assert.equal(wrong.data.failed, 1);
  assert.match(wrong.data.errors[0].problems.join(' '), /is not in the job ad/);

  const ok = await run(scoreSave, { scores: [item(imgId, 70)] }, ctx);
  assert.equal(ok.saved, 1);

  // After transcription the prefilter reads the text: no more imputed skills, excerpt from the transcription, markup stripped.
  const after = (await run(matchPrefilter, { include_scored: true }, ctx)).candidates.find((c: any) => c.id === imgId);
  assert.equal(after.transcribed, true);
  assert.equal(after.prefilter.skills_imputed, undefined);
  assert.match(after.requirements_excerpt, /2\+ years of SQL/);
  assert.ok(!after.requirements_excerpt.includes('<b>'));
  assert.ok(scoredBefore);

  // Re-transcribing changes the job text the score is keyed on: the job is re-queued for scoring.
  await run(jobsTranscribe, { id: imgId, text: 'DATA ANALYST. Requirements: 2+ years of SQL. Experience with Power BI dashboards. Python an advantage.' }, ctx);
  const requeued = (await run(matchPrefilter, {}, ctx)).candidates.find((c: any) => c.id === imgId);
  assert.equal(requeued?.rescore, true);
});
