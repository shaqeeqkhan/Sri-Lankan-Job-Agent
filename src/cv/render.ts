import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import type { Context } from '../context.ts';
import type { Settings } from '../config.ts';
import { SljError } from '../errors.ts';
import { bumpStat, loadProfile } from '../user/profile.ts';
import { cvFileBase, cvName, jobDir, readCvMd, requireJob, type CvDoc } from './cvmd.ts';
import { requirePassedFactcheck } from './factcheck.ts';
import { launchBrowser, printPdf, readPdf, type Margins } from './pdf.ts';

/**
 * `slj cv render`: cv.md → cv.html → PDF, in that one direction.
 *
 * resume-optimizer derives its Markdown from the HTML "so the files can't drift". Here the same
 * guarantee comes from the other end: cv.md is the only file anyone edits, and every render
 * regenerates both the HTML and the PDF from it. Nothing is ever read back from the PDF or HTML into cv.md.
 */

export type Style = 'modern' | 'traditional';

export const MARGINS: Record<Style, Margins> = {
  // The bottom margin holds the watermark footer (about 2-3 mm tall at 4-6 pt), so content never moves.
  modern: { top: '13mm', right: '15mm', bottom: '16mm', left: '15mm' },
  traditional: { top: '16mm', right: '18mm', bottom: '18mm', left: '18mm' },
};

/**
 * Density levels for the modern page-count trim loop. Spacing first, then font size, never below 9.5 pt.
 * Content is never dropped here: cutting is the agent's job, with the person's knowledge.
 */
export const DENSITY: { step: string; vars: Record<string, string> }[] = [
  { step: 'default', vars: { '--fs': '10.5pt', '--lh': '1.32', '--gap': '8pt' } },
  { step: 'tighter line and section spacing', vars: { '--fs': '10.5pt', '--lh': '1.22', '--gap': '6pt' } },
  { step: 'font size 10 pt', vars: { '--fs': '10pt', '--lh': '1.2', '--gap': '5.5pt' } },
  { step: 'font size 9.5 pt (the floor)', vars: { '--fs': '9.5pt', '--lh': '1.18', '--gap': '5pt' } },
];
const TRADITIONAL_VARS = { '--fs': '11pt', '--lh': '1.35', '--gap': '9pt' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** cv.md body → the HTML that goes inside <main>. The first "# Name" heading is dropped: the template prints the name. */
export function markdownToHtml(body: string): string {
  const html = marked.parse(body, { gfm: true, async: false }) as string;
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);
  const root = $('#root');
  root.find('script, style, iframe, object, embed, img, svg, picture, form, input, link, meta').remove();
  root.find('*').each((_, el) => {
    for (const name of Object.keys((el as { attribs?: Record<string, string> }).attribs ?? {})) {
      if (name.startsWith('on') || name === 'style') $(el).removeAttr(name);
    }
  });
  root.find('a').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/^(https?:|mailto:|tel:)/i.test(href)) $(el).removeAttr('href');
  });
  root.children('h1').first().remove();
  // "### Data Analyst, Ceylon Analytics | Jan 2022 – Present" → what on the left, when on the right.
  root.find('h3').each((_, el) => {
    const inner = $(el).html() ?? '';
    const idx = inner.lastIndexOf(' | ');
    if (idx < 0) return;
    $(el).html(`<span class="what">${inner.slice(0, idx).trim()}</span> <span class="when">${inner.slice(idx + 3).trim()}</span>`);
  });
  return root.html() ?? '';
}

export function contactLine(doc: CvDoc): string {
  const f = doc.front;
  const parts = [f.location, f.email, f.phone, ...(f.links ?? [])].filter((x): x is string => !!x);
  return parts.map((p) => esc(p.replace(/^https?:\/\//, ''))).join(' &nbsp;|&nbsp; ');
}

export interface BuildOptions {
  style: Style;
  pageSize: 'A4' | 'Letter';
  density: Record<string, string>;
  /** End-of-content watermark paragraph, for HTML that may be printed by hand. */
  mark: { text: string; sizePt: number; color: string } | null;
}

function marginCss(m: Margins): string {
  return `${m.top} ${m.right} ${m.bottom} ${m.left}`;
}

export function buildHtml(template: string, doc: CvDoc, name: string, opts: BuildOptions): string {
  const vars = Object.entries(opts.density).map(([k, v]) => `${k}: ${v};`).join(' ');
  const values: Record<string, string> = {
    title: esc(`${name} - CV`),
    page_size: opts.pageSize,
    margins: marginCss(MARGINS[opts.style]),
    vars,
    name: esc(name),
    contact: contactLine(doc),
    content: markdownToHtml(doc.body),
    mark: opts.mark ? `<p class="slj-mark">${esc(opts.mark.text)}</p>` : '',
    mark_size: `${opts.mark?.sizePt ?? 6}pt`,
    mark_color: opts.mark?.color ?? '#9aa0a6',
    body_class: `cv-${opts.style}`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}

export function readTemplate(ctx: Pick<Context, 'paths'>, style: Style): string {
  const file = path.join(ctx.paths.root, 'templates', `cv-${style}.html`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new SljError('RENDER_FAILED', `The template ${file} is missing.`);
  }
}

export function chooseStyle(ctx: Context, given: Style | undefined, doc: CvDoc, settings: Settings): { style: Style; from: string } {
  if (given) return { style: given, from: '--style' };
  if (doc.front.style) return { style: doc.front.style, from: 'cv.md front matter' };
  if (settings.cv.style !== 'auto') return { style: settings.cv.style, from: 'settings.yml cv.style' };
  try {
    return { style: loadProfile(ctx).cv_style.value, from: 'profile.yml cv_style' };
  } catch {
    return { style: 'modern', from: 'default' };
  }
}

export interface RenderResult {
  job_id: string;
  status: 'ok' | 'over_limit' | 'needs_manual_print';
  style: Style;
  style_from: string;
  page_size: 'A4' | 'Letter';
  html: string;
  pdf: string | null;
  pages: number | null;
  max_pages: number | null;
  density: string;
  tightening: string[];
  watermark: { enabled: boolean; text: string | null; size_pt: number | null; placement: 'footer' | 'end_of_content' | 'off' };
  browser: string | null;
  guidance: string | null;
  cv_output_id: number;
}

export async function renderCv(
  ctx: Context,
  input: { job: string; style?: Style; page_size?: 'A4' | 'Letter' },
): Promise<RenderResult> {
  const job = requireJob(ctx, input.job);
  const { file: mdFile, text, doc } = readCvMd(ctx, input.job);
  requirePassedFactcheck(ctx, input.job, text);

  const settings = ctx.config().settings;
  const { style, from } = chooseStyle(ctx, input.style, doc, settings);
  const pageSize = input.page_size ?? settings.cv.page_size;
  let name = cvName(doc);
  if (!name) {
    try {
      name = loadProfile(ctx).name.value;
    } catch {
      name = null;
    }
  }
  if (!name) throw new SljError('INVALID_INPUT', 'cv.md needs the person\'s name: add `name:` to its front matter or start it with "# Name".');

  const dir = jobDir(ctx, input.job);
  fs.mkdirSync(dir, { recursive: true });
  const base = cvFileBase(name, doc.front.role ?? job.title);
  const htmlPath = path.join(dir, `${base}.html`);
  const pdfPath = path.join(dir, `${base}.pdf`);
  const wm = settings.cv.watermark;
  const mark = wm.enabled ? { text: wm.text, sizePt: wm.size_pt, color: wm.color } : null;
  const template = readTemplate(ctx, style);
  const levels = style === 'modern' ? DENSITY : [{ step: 'default', vars: TRADITIONAL_VARS }];
  const maxPages = style === 'modern' ? settings.cv.modern_max_pages : null;

  // The saved HTML always ends with the fallback watermark paragraph, so a copy printed by hand is still marked.
  const savedHtml = (k: number) => buildHtml(template, doc, name!, { style, pageSize, density: levels[k].vars, mark });
  const launched = await launchBrowser(ctx.env);

  let pages: number | null = null;
  let level = 0;
  let status: RenderResult['status'] = 'ok';
  let guidance: string | null = null;
  let pdfOut: string | null = null;

  if (!launched) {
    fs.writeFileSync(htmlPath, savedHtml(0));
    status = 'needs_manual_print';
    guidance =
      `No Chrome, Edge or Chromium was found, so no PDF was made. Open ${htmlPath} in any browser, choose Print, ` +
      `set the paper to ${pageSize} and the margins to "Default", and turn OFF "Headers and footers" (it is on by default and would print ` +
      'the date and this file\'s local path on the CV). Then "Save as PDF". The srilankanjobs.lk line is at the end of the content in this case, not in the page footer.' +
      (maxPages ? ` Check the PDF has at most ${maxPages} pages.` : '');
  } else {
    try {
      for (level = 0; level < levels.length; level++) {
        // The PDF gets the watermark in the page footer, so the HTML printed for it carries no end-of-content copy.
        const html = buildHtml(template, doc, name, { style, pageSize, density: levels[level].vars, mark: null });
        const pdf = await printPdf(launched.browser, html, { pageSize, margins: MARGINS[style], watermark: mark });
        pages = (await readPdf(pdf)).pages;
        fs.writeFileSync(pdfPath, pdf);
        if (!maxPages || pages <= maxPages) break;
      }
      if (level === levels.length) level = levels.length - 1;
    } catch (err) {
      throw new SljError('RENDER_FAILED', `Printing the PDF failed: ${(err as Error).message}`);
    } finally {
      await launched.browser.close().catch(() => {});
    }
    fs.writeFileSync(htmlPath, savedHtml(level));
    pdfOut = pdfPath;
    if (maxPages && pages != null && pages > maxPages) {
      status = 'over_limit';
      guidance =
        `The CV is ${pages} pages even at the tightest allowed spacing and a 9.5 pt font; the limit is ${maxPages}. ` +
        'Cut content in cv.md, in this order: (a) bullets from the least relevant roles, keeping at least one per role; ' +
        '(b) projects, activities and optional education lines; (c) only then a clearly unrelated role. Tell the person ' +
        'exactly what you cut, then run `slj factcheck` and `slj cv render` again. Do not shrink the font further.';
    }
  }

  const tightening = levels.slice(1, level + 1).map((l) => l.step);
  const id = Number(
    ctx
      .db()
      .prepare('INSERT INTO cv_outputs (job_id, style, cv_md_path, pdf_path, pages, factcheck_passed, ats_json, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(input.job, style, mdFile, pdfOut, pages, ctx.now().toISOString()).lastInsertRowid,
  );
  bumpStat(ctx, 'cvs');
  return {
    job_id: input.job,
    status,
    style,
    style_from: from,
    page_size: pageSize,
    html: htmlPath,
    pdf: pdfOut,
    pages,
    max_pages: maxPages,
    density: levels[level].step,
    tightening,
    watermark: {
      enabled: wm.enabled,
      text: wm.enabled ? wm.text : null,
      size_pt: wm.enabled ? wm.size_pt : null,
      placement: !wm.enabled ? 'off' : launched ? 'footer' : 'end_of_content',
    },
    browser: launched?.name ?? null,
    guidance,
    cv_output_id: id,
  };
}
