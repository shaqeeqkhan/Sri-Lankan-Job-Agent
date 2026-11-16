import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import YAML from 'yaml';
import { loadConfig } from '../src/config.ts';
import type { Context } from '../src/context.ts';
import { execute } from '../src/registry.ts';
import { cvAtsCheck, cvRender, factcheck, factsAdd, factsList } from '../src/commands/cv.ts';
import { pathLeaks } from '../src/cv/ats-check.ts';
import { cvFileBase, parseCvMd } from '../src/cv/cvmd.ts';
import { buildCorpus, checkCv } from '../src/cv/factcheck.ts';
import { EMPTY_HEADER, footerTemplate, launchBrowser, readPdf } from '../src/cv/pdf.ts';
import { markdownToHtml } from '../src/cv/render.ts';
import { makeCtx, ROOT, seedJobs, tempDir } from './helpers.ts';

const FX = path.join(ROOT, 'test', 'fixtures', 'cv');
const PEOPLE = ['nimal', 'fathima', 'kasun', 'tharushi', 'arjun'];
const JOBS = ['data', 'accounts', 'marketing'];
const MARK = 'Resume designed by srilankanjobs.lk';

interface JobFx {
  key: string;
  title: string;
  company: string;
  location: string;
  closing_date: string;
  apply_email: string;
  description: string;
  keywords: string[];
}
const jobFx = (k: string): JobFx => JSON.parse(fs.readFileSync(path.join(FX, 'jobs', `${k}.json`), 'utf8'));
const read = (...p: string[]) => fs.readFileSync(path.join(FX, ...p), 'utf8');

function corpusOf(person: string) {
  const docs = [{ source: 'resume.md', text: read('people', person, 'resume.md') }];
  for (const f of (YAML.parse(read('people', person, 'facts.yml')) ?? []) as { id: string; text: string }[]) {
    docs.push({ source: `facts.yml:${f.id}`, text: f.text });
  }
  return buildCorpus(docs);
}

/** A context for one person: their resume.md and facts.yml in user/, the three jobs seeded, and their cv.md files in place. */
function personCtx(person: string, env: Record<string, string> = {}, configDir?: string): { ctx: Context; ids: Record<string, string> } {
  const ctx = makeCtx({ env, configDir });
  fs.mkdirSync(ctx.paths.userDir, { recursive: true });
  fs.copyFileSync(path.join(FX, 'people', person, 'resume.md'), ctx.paths.resumeFile);
  fs.copyFileSync(path.join(FX, 'people', person, 'facts.yml'), ctx.paths.factsFile);
  const ids: Record<string, string> = {};
  JOBS.forEach((k, i) => {
    const j = jobFx(k);
    const [id] = seedJobs(ctx, [{
      ref: `fx-${k}`, source: 'xpressjobs', source_url: `https://xpress.jobs/jobs/${900 + i}`, external_id: String(900 + i),
      title: j.title, company: j.company, location: j.location, closing_date: j.closing_date, apply_email: j.apply_email, description: j.description,
    }]);
    ids[k] = id;
    const dir = path.join(ctx.paths.outputDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(FX, 'people', person, `cv-${k}.md`), path.join(dir, 'cv.md'));
  });
  return { ctx, ids };
}

/** A copy of config/ with settings.yml edited, for watermark and bounds tests. */
function configWith(edit: (s: Record<string, any>) => void): string {
  const dir = tempDir('slj-cfg-');
  for (const f of fs.readdirSync(path.join(ROOT, 'config'))) fs.copyFileSync(path.join(ROOT, 'config', f), path.join(dir, f));
  const s = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yml'), 'utf8'));
  edit(s);
  fs.writeFileSync(path.join(dir, 'settings.yml'), YAML.stringify(s));
  return dir;
}

// ================================================================ pure tests (no browser)

describe('factcheck on the golden fixtures', () => {
  for (const person of PEOPLE) {
    for (const job of JOBS) {
      test(`${person} × ${job}: the honest tailored CV passes`, () => {
        const j = jobFx(job);
        const res = checkCv(read('people', person, `cv-${job}.md`), corpusOf(person), { watermarkText: MARK, target: j });
        assert.deepEqual(res.unsupported.map((u) => `${u.line} ${u.kind} ${u.claim}`), []);
        assert.ok(res.claims_checked > 30, `only ${res.claims_checked} claims were checked`);
      });
    }
  }

  const negatives = JSON.parse(read('negative.json')) as { name: string; person: string; job: string; find: string; replace: string; kind: string; claim?: string }[];
  for (const c of negatives) {
    test(`invented claim fails: ${c.name}`, () => {
      const cv = read('people', c.person, `cv-${c.job}.md`);
      assert.ok(cv.includes(c.find), `fixture text "${c.find}" not found`);
      const res = checkCv(cv.replace(c.find, c.replace), corpusOf(c.person), { watermarkText: MARK, target: jobFx(c.job) });
      const hit = res.unsupported.find((u) => u.kind === c.kind && (!c.claim || u.claim.toLowerCase().includes(c.claim.toLowerCase())));
      assert.ok(hit, `expected a ${c.kind} failure${c.claim ? ` for "${c.claim}"` : ''}; got ${JSON.stringify(res.unsupported.map((u) => [u.kind, u.claim]))}`);
      assert.ok(hit.line > 0 && hit.context.length > 0);
    });
  }

  test('a JD keyword is never an allowed source, even in the Skills line', () => {
    const cv = read('people', 'nimal', 'cv-data.md').replace('Git, Google Sheets', 'Git, Google Sheets, Snowflake, Looker');
    const res = checkCv(cv, corpusOf('nimal'), { target: jobFx('data') });
    assert.deepEqual(res.unsupported.map((u) => u.claim).sort(), ['Looker', 'Snowflake']);
  });

  test('the job title and company are allowed only inside a Career Objective', () => {
    const corpus = corpusOf('fathima');
    const cv = read('people', 'fathima', 'cv-accounts.md');
    assert.equal(checkCv(cv, corpus, { target: jobFx('accounts') }).unsupported.length, 0);
    const moved = cv.replace('## Computer Skills', '## Computer Skills\n\nWorked with Kandy Tea Traders PLC suppliers.');
    assert.ok(checkCv(moved, corpus, { target: jobFx('accounts') }).unsupported.some((u) => u.claim === 'Kandy Tea Traders PLC'));
  });

  test('honest rewording passes: verbs, order, merged bullets', () => {
    const corpus = buildCorpus([{ source: 'resume.md', text: '- Prepared monthly payroll for 45 employees in QuickBooks\n- Reconciled 3 bank accounts every month' }]);
    const cv = '- Reconciled 3 bank accounts monthly and ran payroll for 45 employees using QuickBooks';
    assert.deepEqual(checkCv(cv, corpus).unsupported, []);
  });

  test('the watermark line and HTML comments are skipped; unsupported claims carry the nearest supported text', () => {
    const corpus = buildCorpus([{ source: 'resume.md', text: 'Accounts Assistant, Hill Country Hardware, 2021' }]);
    const cv = `Accounts Assistant, Hill Country Hardware, 2021\n<!-- note: Tableau -->\n<p class="slj-mark">${MARK}</p>\n${MARK}\n- Accounts Assistant at Hill Country Hardware since 2019`;
    const res = checkCv(cv, corpus, { watermarkText: MARK });
    assert.deepEqual(res.unsupported.map((u) => [u.line, u.kind, u.claim]), [[5, 'year', '2019']]);
    assert.equal(res.unsupported[0].nearest?.source, 'resume.md:1');
  });
});

describe('rendering helpers', () => {
  test('markdown to HTML: name heading dropped, entry lines split, unsafe markup removed', () => {
    const html = markdownToHtml('# Nimal Perera\n\n## Experience\n\n### Analyst, Acme | 2020 – 2022\n\n- one <script>alert(1)</script>\n\n<img src="x.png">\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    assert.ok(!html.includes('<h1'));
    assert.match(html, /<h3><span class="what">Analyst, Acme<\/span> <span class="when">2020 – 2022<\/span><\/h3>/);
    assert.ok(!html.includes('<script') && !html.includes('<img'));
    assert.ok(html.includes('<table>'));
  });

  test('file name is Firstname_Lastname_Role', () => {
    assert.equal(cvFileBase('Nimal Perera', 'Junior Data Analyst'), 'Nimal_Perera_Junior_Data_Analyst');
    assert.equal(cvFileBase('K. A. Nimal Kumara Perera', 'Accounts Executive (Kandy)'), 'Nimal_Perera_Accounts_Executive');
    assert.equal(cvFileBase('Thárushi Wickramasinghe', 'Digital Marketing Executive / SEO'), 'Tharushi_Wickramasinghe_Digital_Marketing_Executive_SEO');
    assert.equal(cvFileBase('Madonna', null), 'Madonna');
  });

  test('cv.md front matter is parsed and validated', () => {
    const d = parseCvMd('---\nname: A B\nrole: X\n---\n# A B\n');
    assert.equal(d.front.name, 'A B');
    assert.equal(d.body, '# A B\n');
    assert.throws(() => parseCvMd('---\nnic: 123\n---\n'), /front matter is invalid/);
  });

  test('watermark footer template: configured size, grey, centred; header is empty', () => {
    const f = footerTemplate(MARK, 6, '#9aa0a6');
    assert.match(f, /font-size:6pt/);
    assert.match(f, /color:#9aa0a6/);
    assert.match(f, /text-align:center/);
    assert.ok(f.includes(MARK));
    assert.match(footerTemplate('<b>x</b>', 4, '#9aa0a6'), /&lt;b&gt;x&lt;\/b&gt;/);
    assert.equal(EMPTY_HEADER, '<span></span>');
  });

  test('settings: watermark size must be 4-6 pt', () => {
    assert.throws(() => loadConfig(configWith((s) => (s.cv.watermark.size_pt = 3))), /size_pt/);
    assert.throws(() => loadConfig(configWith((s) => (s.cv.watermark.size_pt = 7))), /size_pt/);
    assert.equal(loadConfig(configWith((s) => (s.cv.watermark.size_pt = 4))).settings.cv.watermark.size_pt, 4);
  });

  test('path leak detector', () => {
    assert.deepEqual(pathLeaks('see file:///x', '/nowhere'), ['file://']);
    assert.deepEqual(pathLeaks('saved in /Users/someone/cv.html', '/nowhere'), ['/Users/someone/']);
    assert.deepEqual(pathLeaks('C:\\Users\\a\\b', '/nowhere'), ['C:\\Users\\']);
    assert.deepEqual(pathLeaks('Resume designed by srilankanjobs.lk', '/nowhere'), []);
  });
});

describe('commands without a browser', () => {
  test('facts add refuses without --confirmed, appends with it, keeps comments; facts list', async () => {
    const { ctx } = personCtx('nimal');
    const no = await execute(factsAdd, { text: 'Led 5 people', kind: 'scope' }, ctx);
    assert.equal(no.ok, false);
    const before = fs.readFileSync(ctx.paths.factsFile, 'utf8');
    const yes = await execute(factsAdd, { text: 'The dashboard covers 12 branches.', kind: 'scope', confirmed: true }, ctx);
    assert.equal(yes.ok, true);
    const after = fs.readFileSync(ctx.paths.factsFile, 'utf8');
    assert.ok(after.startsWith(before.split('\n')[0]), 'leading comment kept');
    const list = await execute(factsList, {}, ctx);
    assert.ok(list.ok);
    const facts = (list.data as { facts: { source: string; confirmed: boolean; text: string }[] }).facts;
    assert.equal(facts.length, 3);
    assert.deepEqual([facts[2].source, facts[2].confirmed, facts[2].text], ['interview', true, 'The dashboard covers 12 branches.']);
    ctx.close();
  });

  test('render refuses until factcheck passes for the current cv.md, resume.md and facts.yml', async () => {
    const { ctx, ids } = personCtx('nimal', { SLJ_NO_BROWSER: '1' });
    const job = ids.data;
    let r = await execute(cvRender, { job }, ctx);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'FACTCHECK_FAILED');
    const cvFile = path.join(ctx.paths.outputDir, job, 'cv.md');
    const honest = fs.readFileSync(cvFile, 'utf8');
    fs.writeFileSync(cvFile, honest.replace('Git, Google Sheets', 'Git, Google Sheets, Tableau'));
    const fc = await execute(factcheck, { job }, ctx);
    assert.ok(fc.ok && !(fc.data as { passed: boolean }).passed);
    r = await execute(cvRender, { job }, ctx);
    assert.equal(!r.ok && r.error.code, 'FACTCHECK_FAILED');
    fs.writeFileSync(cvFile, honest);
    assert.ok((await execute(factcheck, { job }, ctx)).ok);
    fs.appendFileSync(ctx.paths.factsFile, '');
    fs.appendFileSync(cvFile, '\n- Coached 4 junior staff on Excel pivot tables\n');
    r = await execute(cvRender, { job }, ctx);
    assert.match(!r.ok ? r.error.message : '', /cv\.md changed/);
    ctx.close();
  });

  test('no browser: HTML with an end-of-content watermark and print-by-hand instructions', async () => {
    const { ctx, ids } = personCtx('fathima', { SLJ_NO_BROWSER: '1' });
    assert.ok((await execute(factcheck, { job: ids.accounts }, ctx)).ok);
    const r = await execute(cvRender, { job: ids.accounts }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { status: string; pdf: string | null; html: string; guidance: string; watermark: { placement: string } };
    assert.equal(d.status, 'needs_manual_print');
    assert.equal(d.pdf, null);
    assert.equal(path.basename(d.html), 'Fathima_Rizwan_Accounts_Executive.html');
    assert.equal(d.watermark.placement, 'end_of_content');
    assert.match(d.guidance, /Headers and footers/);
    const html = fs.readFileSync(d.html, 'utf8');
    assert.match(html, /<p class="slj-mark">Resume designed by srilankanjobs\.lk<\/p>\s*<\/main>/);
    assert.match(html, /\.slj-mark \{[^}]*font-size: 6pt/);
    assert.match(html, /<table>/); // traditional: O/L and A/L tables
    assert.equal(JSON.parse(fs.readFileSync(ctx.paths.statsFile, 'utf8')).cvs, 1);
    ctx.close();
  });

  test('watermark disabled: no mark in the HTML', async () => {
    const cfg = configWith((s) => (s.cv.watermark.enabled = false));
    const { ctx, ids } = personCtx('arjun', { SLJ_NO_BROWSER: '1' }, cfg);
    assert.ok((await execute(factcheck, { job: ids.marketing }, ctx)).ok);
    const r = await execute(cvRender, { job: ids.marketing }, ctx);
    assert.ok(r.ok);
    assert.ok(!fs.readFileSync((r.data as { html: string }).html, 'utf8').includes('<p class="slj-mark">'));
    ctx.close();
  });
});

// ================================================================ golden render (needs Chrome, Edge or Chromium)

let browserName: string | null = null;
const SKIP_WHY = process.env.SLJ_NO_BROWSER === '1' ? 'SLJ_NO_BROWSER=1' : 'no Chrome, Edge or Chromium found';
before(async () => {
  const b = await launchBrowser();
  browserName = b?.name ?? null;
  await b?.browser.close();
  if (!browserName) console.log(`# cv-golden: ${SKIP_WHY}; the PDF tests are skipped.`);
});

describe('golden render: 5 CVs × 3 job ads (PDF)', () => {
  const ctxs: Context[] = [];
  after(() => ctxs.forEach((c) => c.close()));

  for (const person of PEOPLE) {
    test(`${person}: factcheck, render, page count, ATS check, watermark, no paths`, async (t) => {
      if (!browserName) return t.skip(SKIP_WHY);
      const { ctx, ids } = personCtx(person);
      ctxs.push(ctx);
      for (const job of JOBS) {
        const id = ids[job];
        const fc = await execute(factcheck, { job: id }, ctx);
        assert.ok(fc.ok && (fc.data as { passed: boolean }).passed, `${person}/${job} factcheck: ${JSON.stringify(fc)}`);
        const r = await execute(cvRender, { job: id }, ctx);
        assert.ok(r.ok, `${person}/${job} render: ${JSON.stringify(r)}`);
        const d = r.data as { status: string; style: string; pdf: string; pages: number; max_pages: number | null; watermark: { placement: string } };
        assert.equal(d.status, 'ok', `${person}/${job}: ${JSON.stringify(d)}`);
        if (d.style === 'modern') assert.ok(d.pages <= 2, `${person}/${job}: ${d.pages} pages`);
        assert.equal(d.watermark.placement, 'footer');
        assert.match(path.basename(d.pdf), /^[A-Z][a-z]+_[A-Z][a-z]+_[A-Za-z_]+\.pdf$/);

        const ats = await execute(cvAtsCheck, { job: id, keywords: jobFx(job).keywords }, ctx);
        assert.ok(ats.ok, JSON.stringify(ats));
        const a = ats.data as { passed: boolean; rows: { check: string; ok: boolean; detail: string }[]; gaps: string[] };
        assert.ok(a.passed, `${person}/${job} ATS: ${JSON.stringify(a.rows.filter((x) => !x.ok))}`);

        const info = await readPdf(fs.readFileSync(d.pdf));
        assert.ok(info.text.includes(MARK), 'watermark in the text layer');
        const marks = info.items.filter((i) => i.str.includes('srilankanjobs.lk'));
        assert.equal(new Set(marks.map((m) => m.page)).size, info.pages, 'watermark on every page');
        for (const m of marks) assert.ok(Math.abs(m.sizePt - 6) < 0.25, `watermark at ${m.sizePt} pt`);
        for (const m of marks) assert.ok(m.y < 40, `watermark inside the bottom margin (y=${m.y})`);
        assert.ok(!/file:\/\//i.test(info.text) && !fs.readFileSync(d.pdf).toString('latin1').includes('file://'));
        assert.ok(!info.text.includes(ctx.paths.userDir) && !info.text.includes(process.env.HOME ?? '\0'));
        // The configured size wins: rendering at 4 pt is tested below.
      }
    });
  }

  test('watermark at 4 pt is in the text layer at 4 pt', async (t) => {
    if (!browserName) return t.skip(SKIP_WHY);
    const { ctx, ids } = personCtx('kasun', {}, configWith((s) => (s.cv.watermark.size_pt = 4)));
    ctxs.push(ctx);
    assert.ok((await execute(factcheck, { job: ids.data }, ctx)).ok);
    const r = await execute(cvRender, { job: ids.data }, ctx);
    assert.ok(r.ok);
    const info = await readPdf(fs.readFileSync((r.data as { pdf: string }).pdf));
    const marks = info.items.filter((i) => i.str.includes('srilankanjobs.lk'));
    assert.ok(marks.length > 0 && marks.every((m) => Math.abs(m.sizePt - 4) < 0.25), JSON.stringify(marks));
    const ats = await execute(cvAtsCheck, { job: ids.data }, ctx);
    assert.ok(ats.ok && (ats.data as { passed: boolean }).passed, JSON.stringify(ats));
  });

  test('watermark disabled: absent from the PDF, ATS check still passes', async (t) => {
    if (!browserName) return t.skip(SKIP_WHY);
    const { ctx, ids } = personCtx('arjun', {}, configWith((s) => (s.cv.watermark.enabled = false)));
    ctxs.push(ctx);
    assert.ok((await execute(factcheck, { job: ids.marketing }, ctx)).ok);
    const r = await execute(cvRender, { job: ids.marketing }, ctx);
    assert.ok(r.ok);
    const info = await readPdf(fs.readFileSync((r.data as { pdf: string }).pdf));
    assert.ok(!info.text.includes('srilankanjobs'));
    const ats = await execute(cvAtsCheck, { job: ids.marketing }, ctx);
    assert.ok(ats.ok && (ats.data as { passed: boolean }).passed, JSON.stringify(ats));
  });

  test('modern page limit: a long CV is tightened, then reported over_limit, never cut', async (t) => {
    if (!browserName) return t.skip(SKIP_WHY);
    const { ctx, ids } = personCtx('nimal');
    ctxs.push(ctx);
    const cvFile = path.join(ctx.paths.outputDir, ids.data, 'cv.md');
    const bullet = '- Built weekly sales dashboards in Power BI used by 12 branch managers\n';
    fs.appendFileSync(cvFile, `\n## More\n\n${bullet.repeat(140)}`);
    assert.ok((await execute(factcheck, { job: ids.data }, ctx)).ok);
    const r = await execute(cvRender, { job: ids.data }, ctx);
    assert.ok(r.ok);
    const d = r.data as { status: string; pages: number; tightening: string[]; guidance: string; pdf: string };
    assert.equal(d.status, 'over_limit');
    assert.ok(d.pages > 2);
    assert.equal(d.tightening.length, 3);
    assert.match(d.guidance, /Cut content in cv\.md/);
    const text = (await readPdf(fs.readFileSync(d.pdf))).text;
    assert.equal(text.split('Built weekly sales dashboards').length - 1, 140, 'no content dropped');
  });
});
