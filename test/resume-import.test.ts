import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { SljError } from '../src/errors.ts';
import { docxToMarkdown } from '../src/resume/docx.ts';
import { importResume } from '../src/resume/import.ts';
import { pdfToMarkdown } from '../src/resume/pdf.ts';
import { ROOT, makeCtx } from './helpers.ts';

const FIX = path.join(ROOT, 'test/fixtures/resume');
const fixture = (name: string) => path.join(FIX, name);
const code = (c: string) => (e: unknown) => e instanceof SljError && e.code === c;

/** Plain, lower-cased text of Markdown: link targets, emphasis and table pipes removed. */
function mdText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\\([|[\]#*_.-])/g, '$1')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
const norm = (s: string) => s.replace(/ /g, ' ').replace(/^\s*•\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Every heading, bullet, paragraph and table cell of the source HTML, as the test expects to find it. */
function sourceParts(html: string) {
  const $ = cheerio.load(html);
  const text = (sel: string) =>
    $(sel)
      .toArray()
      .map((el) => norm($(el).text()))
      .filter(Boolean);
  return { headings: text('h1, h2, h3'), bullets: text('li'), paragraphs: text('p'), cells: text('td, th') };
}

/** The lines of the Markdown of a given kind, as plain text. */
function mdLines(md: string, kind: 'heading' | 'bullet'): string[] {
  const re = kind === 'heading' ? /^#{1,6} / : /^\s*(-|\d+\.) /;
  return md
    .split('\n')
    .filter((l) => re.test(l))
    .map((l) => mdText(l.replace(re, '')).trim());
}

function assertNothingLost(md: string, html: string, label: string): void {
  const src = sourceParts(html);
  const all = mdText(md);
  const headings = mdLines(md, 'heading');
  const bullets = mdLines(md, 'bullet');
  for (const h of src.headings) assert.ok(headings.some((x) => x === h || x.includes(h)), `${label}: heading "${h}" is not a Markdown heading`);
  for (const b of src.bullets) assert.ok(bullets.some((x) => x.includes(b)), `${label}: bullet "${b}" is not a Markdown list item`);
  for (const p of src.paragraphs) assert.ok(all.includes(p), `${label}: paragraph "${p}" is missing`);
  for (const c of src.cells) assert.ok(all.includes(c), `${label}: table cell "${c}" is missing`);
}

const PDFS = ['modern', 'traditional', 'two-column', 'word-style'] as const;

for (const name of PDFS) {
  test(`pdf → markdown keeps every heading, bullet, paragraph and cell: ${name}`, async () => {
    const conv = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture(`${name}.pdf`))));
    assertNothingLost(conv.markdown, fs.readFileSync(fixture(`${name}.html`), 'utf8'), name);
    assert.deepEqual(conv.scannedPages, []);
    assert.equal(conv.ocrLayer, false);
    assert.ok(conv.headings >= 6, `${name}: headings ${conv.headings}`);
  });
}

test('pdf: links become Markdown links, including several links inside one run of text', async () => {
  const { markdown, links } = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('modern.pdf'))));
  assert.equal(links, 3);
  assert.match(markdown, /\[tharindu\.w@example\.lk\]\(mailto:tharindu\.w@example\.lk\)/);
  assert.match(markdown, /\[LinkedIn\]\(https:\/\/www\.linkedin\.com\/in\/tharindu-w-example\)/);
  assert.match(markdown, /\[GitHub\]\(https:\/\/github\.com\/tharindu-w-example\)/);
});

test('pdf: wrapped lines are rejoined, and the name is the only level-1 heading', async () => {
  const { markdown } = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('modern.pdf'))));
  assert.match(markdown, /^- Built a loan origination API .* two licensed commercial banks\.$/m);
  assert.match(markdown, /^Software engineer with four years .* role in Colombo\.$/m);
  assert.deepEqual(markdown.match(/^# .*$/gm), ['# Tharindu Wickramasinghe']);
  assert.ok((markdown.match(/^## /gm) ?? []).length >= 6);
});

test('pdf: traditional CV keeps O/L, A/L and personal details as Markdown tables', async () => {
  const { markdown, tables } = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('traditional.pdf'))));
  assert.ok(tables >= 4, `tables: ${tables}`);
  assert.match(markdown, /^\| Subject \| Grade \|$/m);
  assert.match(markdown, /^\| Information and Communication Technology \| A \|$/m);
  assert.match(markdown, /^\| NIC Number \| : 986271543V \|$/m);
  assert.match(markdown, /^\| Tamil \| Excellent \| Excellent \|$/m);
  // A date range broken across lines at the dash is rejoined, not turned into a bullet.
  assert.match(markdown, /\(January 2019 – May 2021\)/);
});

test('pdf: two-column layouts are read a column at a time and reported', async () => {
  const two = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('two-column.pdf'))));
  assert.deepEqual(two.twoColumnPages, [1]);
  assert.ok(two.warnings.some((w) => /two-column/.test(w)));
  const order = (md: string, labels: string[]) => labels.map((l) => md.indexOf(l));
  const [contact, skills, profile, experience] = order(two.markdown, ['## CONTACT', '## SKILLS', '## PROFILE', '## EXPERIENCE']);
  assert.ok(contact < skills && skills < profile && profile < experience, 'left column, then right column');
  // Sidebar lines do not run into the main column.
  assert.match(two.markdown, /^- Power BI and DAX$/m);
  assert.match(two.markdown, /^- Advanced Excel and Power Query$/m);
  assert.match(two.markdown, /^\+94 71 559 2087$/m);

  const word = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('word-style.pdf'))));
  assert.deepEqual(word.twoColumnPages, [1]);
  assert.ok(word.markdown.indexOf('## Education') < word.markdown.indexOf('## Contact'));
  assert.ok(word.markdown.indexOf('## Memberships') < word.markdown.indexOf('## References'), 'page 2 follows page 1');
});

test('pdf: bullet glyphs, justified lines and running footers', async () => {
  const { markdown } = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('word-style.pdf'))));
  assert.doesNotMatch(markdown, /•/);
  assert.doesNotMatch(markdown, /Page \d of \d/);
  assert.match(markdown, /^- Postgraduate Diploma in Human Resource Management, Postgraduate Institute of Management \(PIM\), 2023$/m);
  assert.match(markdown, /^- Associate Member, Institute of Personnel Management Sri Lanka \(IPM\)$/m);
});

test('pdf: a scan has no text layer', async () => {
  const conv = await pdfToMarkdown(new Uint8Array(fs.readFileSync(fixture('scanned.pdf'))));
  assert.deepEqual(conv.scannedPages, [1]);
  assert.equal(conv.markdown, '');
});

test('docx → markdown keeps headings, bullets, paragraphs, the link and the table', async () => {
  const src = JSON.parse(fs.readFileSync(fixture('sales.docx.json'), 'utf8'));
  const conv = await docxToMarkdown(fs.readFileSync(fixture('sales.docx')));
  const headings = mdLines(conv.markdown, 'heading');
  const bullets = mdLines(conv.markdown, 'bullet');
  for (const h of [src.title, ...src.headings]) assert.ok(headings.includes(norm(h)), `heading ${h}`);
  for (const b of src.bullets) assert.ok(bullets.includes(norm(b)), `bullet ${b}`);
  for (const p of src.paragraphs) assert.ok(mdText(conv.markdown).includes(norm(p)), `paragraph ${p}`);
  assert.ok(conv.markdown.includes(`[${src.link.text}](${src.link.url})`));
  assert.match(conv.markdown, /^\| 2024 \| 111% \|$/m);
  assert.equal(conv.tables, 1);
  assert.deepEqual(conv.warnings, []);
});

// ---------------------------------------------------------------- importResume

test('import: PDF writes resume.raw.md and, the first time, resume.md; records the import', async () => {
  const ctx = makeCtx();
  const r = await importResume(ctx, { file: fixture('modern.pdf') });
  assert.equal(r.status, 'ok');
  assert.equal(r.method, 'text');
  assert.equal(r.resume_written, true);
  assert.equal(r.raw_path, ctx.paths.resumeRawFile);
  assert.equal(fs.readFileSync(ctx.paths.resumeFile, 'utf8'), fs.readFileSync(ctx.paths.resumeRawFile, 'utf8'));
  assert.equal(r.pages, 1);
  assert.ok(r.characters > 1000 && r.headings >= 9 && r.bullets >= 10 && r.links === 3);
  assert.equal(path.dirname(r.original_path), ctx.paths.inboxDir);
  assert.equal(path.basename(r.original_path), `resume-${r.hash}.pdf`);
  const rows = ctx.db().prepare('SELECT hash, path, method FROM resumes').all();
  assert.deepEqual(rows, [{ hash: r.hash, path: `inbox/resume-${r.hash}.pdf`, method: 'text' }]);

  // Same file again: same copy, no new row.
  const again = await importResume(ctx, { file: fixture('modern.pdf') });
  assert.equal(again.already_imported, true);
  assert.equal((ctx.db().prepare('SELECT count(*) AS n FROM resumes').get() as { n: number }).n, 1);
  assert.equal(fs.readdirSync(ctx.paths.inboxDir).length, 1);
});

test('import: an existing resume.md is kept unless --force', async () => {
  const ctx = makeCtx();
  fs.mkdirSync(ctx.paths.userDir, { recursive: true });
  fs.writeFileSync(ctx.paths.resumeFile, '# My cleaned CV\n');
  const kept = await importResume(ctx, { file: fixture('two-column.pdf') });
  assert.equal(kept.resume_written, false);
  assert.equal(fs.readFileSync(ctx.paths.resumeFile, 'utf8'), '# My cleaned CV\n');
  assert.ok(kept.warnings.some((w) => /already exists/.test(w)));
  assert.equal(kept.two_column, true);

  const forced = await importResume(ctx, { file: fixture('two-column.pdf'), force: true });
  assert.equal(forced.resume_written, true);
  assert.match(fs.readFileSync(ctx.paths.resumeFile, 'utf8'), /^# Kavindi Senanayake/);
});

test('import: DOCX, Markdown and text', async () => {
  const ctx = makeCtx();
  const d = await importResume(ctx, { file: fixture('sales.docx') });
  assert.equal(d.method, 'docx');
  assert.equal(d.status, 'ok');
  assert.match(fs.readFileSync(ctx.paths.resumeRawFile, 'utf8'), /^# Dilshan Jayasuriya/);

  const ctx2 = makeCtx();
  const src = path.join(ctx2.paths.userDir, 'cv.txt');
  fs.writeFileSync(src, '﻿Nimal Silva\r\nAccountant\r\n');
  const t = await importResume(ctx2, { file: src });
  assert.equal(t.method, 'plain');
  assert.equal(fs.readFileSync(ctx2.paths.resumeFile, 'utf8'), 'Nimal Silva\nAccountant\n');
});

test('import: a scanned PDF returns NEEDS_VISION with page images and writes no resume', async () => {
  const ctx = makeCtx();
  const r = await importResume(ctx, { file: fixture('scanned.pdf') });
  assert.equal(r.status, 'NEEDS_VISION');
  assert.equal(r.method, 'vision');
  assert.equal(r.raw_path, null);
  assert.equal(r.resume_written, false);
  assert.ok(!fs.existsSync(ctx.paths.resumeFile));
  assert.deepEqual(r.scanned_pages, [1]);
  assert.equal(r.images.length, 1);
  // No canvas package is installed here, so the scan is pulled out of the PDF and encoded as PNG.
  assert.ok(['embedded-image', 'canvas'].includes(r.image_renderer!));
  assert.ok(r.images[0].startsWith(path.join(ctx.paths.cacheDir, 'resume-pages')));
  const png = fs.readFileSync(r.images[0]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.readUInt32BE(16) >= 600 && png.readUInt32BE(20) >= 600, 'a readable page size');
  assert.match(r.next_step, /vision/);
  assert.equal((ctx.db().prepare('SELECT method FROM resumes').get() as { method: string }).method, 'vision');
});

test('import: a photo returns NEEDS_VISION pointing at the kept original', async () => {
  const ctx = makeCtx();
  const r = await importResume(ctx, { file: fixture('photo.jpg') });
  assert.equal(r.status, 'NEEDS_VISION');
  assert.equal(r.image_renderer, 'original');
  assert.deepEqual(r.images, [r.original_path]);
  assert.ok(fs.existsSync(r.original_path));
});

test('import: with no file, the newest CV in user/inbox/ is used, skipping job-ad copies', async () => {
  const ctx = makeCtx();
  await assert.rejects(() => importResume(ctx), code('NOT_FOUND'));
  fs.mkdirSync(ctx.paths.inboxDir, { recursive: true });
  const older = path.join(ctx.paths.inboxDir, 'My CV.pdf');
  fs.copyFileSync(fixture('modern.pdf'), older);
  fs.utimesSync(older, new Date('2026-11-01'), new Date('2026-11-01'));
  // A job-ad photo saved by `jobs add` is newer but is not a CV.
  fs.copyFileSync(fixture('photo.jpg'), path.join(ctx.paths.inboxDir, '0123456789abcdef.jpg'));
  const r = await importResume(ctx);
  assert.equal(r.picked_from_inbox, true);
  assert.equal(r.source_path, older);
  assert.equal(r.original_path, older, 'a file already in the inbox is not copied again');

  // A bare file name is looked up in the inbox too.
  const byName = await importResume(ctx, { file: 'My CV.pdf' });
  assert.equal(byName.source_path, older);
});

test('import: rejects unsupported, empty and old Word files', async () => {
  const ctx = makeCtx();
  const dir = ctx.paths.userDir;
  fs.writeFileSync(path.join(dir, 'cv.doc'), 'x');
  fs.writeFileSync(path.join(dir, 'cv.odt'), 'x');
  fs.writeFileSync(path.join(dir, 'empty.pdf'), '');
  fs.writeFileSync(path.join(dir, 'broken.pdf'), 'not a pdf at all');
  await assert.rejects(() => importResume(ctx, { file: path.join(dir, 'cv.doc') }), (e: unknown) => code('FILE_REJECTED')(e) && /\.docx/.test((e as Error).message));
  await assert.rejects(() => importResume(ctx, { file: path.join(dir, 'cv.odt') }), code('FILE_REJECTED'));
  await assert.rejects(() => importResume(ctx, { file: path.join(dir, 'empty.pdf') }), code('FILE_REJECTED'));
  await assert.rejects(() => importResume(ctx, { file: path.join(dir, 'broken.pdf') }), code('FILE_REJECTED'));
  await assert.rejects(() => importResume(ctx, { file: path.join(dir, 'missing.pdf') }), code('NOT_FOUND'));
});
