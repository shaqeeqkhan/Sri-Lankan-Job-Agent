import fs from 'node:fs';
import os from 'node:os';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { cvName, readCvMd, requireJob } from './cvmd.ts';
import { extractNumeric, norm } from './factcheck.ts';
import { readPdf } from './pdf.ts';
import { resumeHash } from '../user/profile.ts';

/**
 * `slj cv ats-check`: reads the rendered PDF's text layer the way an applicant tracking system would.
 * Ported in spirit from resume-optimizer's ats-check.py (MIT); it counts and compares, never judges synonyms,
 * and never asks for a keyword to be added: a keyword the CV does not legitimately have is a gap, not a failure.
 */

export interface AtsRow {
  check: string;
  expected: string;
  ok: boolean;
  detail: string;
}

export interface AtsReport {
  job_id: string;
  passed: boolean;
  pdf: string;
  pages: number;
  rows: AtsRow[];
  keywords_source: 'input' | 'score' | 'none';
  gaps: string[];
}

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/** Short JD terms from the saved score (S8's matched list and met/partial requirements), if one exists. */
export function keywordsFromScore(ctx: Context, jobId: string): string[] {
  let row: { matched_json: string; breakdown_json: string } | undefined;
  try {
    // The score for the current CV and rubric (what `top` shows), else the latest one for the job.
    let key: { resume_hash: string; rubric_version: string } | null = null;
    try {
      key = { resume_hash: resumeHash(ctx), rubric_version: ctx.config().settings.rubric_version };
    } catch {
      key = null;
    }
    row = ctx
      .db()
      .prepare(
        `SELECT matched_json, breakdown_json FROM scores WHERE job_id = @job
         ORDER BY (resume_hash = @rh AND rubric_version = @rv) DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get({ job: jobId, rh: key?.resume_hash ?? '', rv: key?.rubric_version ?? '' }) as typeof row;
  } catch {
    return [];
  }
  if (!row) return [];
  const out: string[] = [];
  const pick = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const s = o.keyword ?? o.term ?? o.requirement ?? o.name ?? o.text;
      if (typeof s === 'string') out.push(s);
    }
  };
  try {
    const matched = JSON.parse(row.matched_json);
    if (Array.isArray(matched)) matched.forEach(pick);
  } catch {
    // ignore
  }
  try {
    const b = JSON.parse(row.breakdown_json) as { requirements?: unknown[] };
    for (const r of b.requirements ?? []) {
      const st = (r as { status?: string })?.status;
      if (st !== 'met' && st !== 'partial') continue;
      // A requirement's `text` is the scorer's label ("Java, Spring Boot, Node.js", "4+ years"), not one
      // keyword: split it into terms and keep only keyword-like ones (no years, degrees or counts).
      const before = out.length;
      pick(r);
      const label = out.splice(before).join(' ');
      for (const term of label.split(/\s*(?:,|;|\/|\band\b|&|\bor\b)\s*/i)) {
        const t = term.trim();
        if (t && !/\d|\b(years?|yrs?|degree|bachelor'?s?|diploma|experience)\b/i.test(t)) out.push(t);
      }
    }
  } catch {
    // ignore
  }
  return [...new Set(out.map((s) => s.trim()).filter((s) => s && s.split(/\s+/).length <= 4))];
}

/** Paths that must never appear on a CV: file:// URLs and this machine's home folder. */
export function pathLeaks(text: string, home = os.homedir()): string[] {
  const found: string[] = [];
  if (/file:\/\//i.test(text)) found.push('file://');
  if (home && home.length > 3 && text.includes(home)) found.push(home);
  const generic = /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\)/.exec(text);
  if (generic) found.push(generic[0]);
  return [...new Set(found)];
}

export async function runAtsCheck(ctx: Context, input: { job: string; keywords?: string[] }): Promise<AtsReport> {
  requireJob(ctx, input.job);
  const { text: md, doc } = readCvMd(ctx, input.job);
  const out = ctx
    .db()
    .prepare('SELECT id, style, pdf_path FROM cv_outputs WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(input.job) as { id: number; style: string; pdf_path: string | null } | undefined;
  if (!out?.pdf_path || !fs.existsSync(out.pdf_path)) {
    throw new SljError('NOT_FOUND', `There is no rendered PDF for this job. Run \`slj cv render --job ${input.job}\` first.`);
  }
  const bytes = fs.readFileSync(out.pdf_path);
  const pdf = await readPdf(bytes);
  const text = pdf.text;
  const flat = text.replace(/\s+/g, ' ');
  const settings = ctx.config().settings;
  const wm = settings.cv.watermark;
  const rows: AtsRow[] = [];
  const row = (check: string, expected: string, ok: boolean, detail: string) => rows.push({ check, expected, ok, detail });

  const name = cvName(doc);
  if (name) row('name', name, squash(flat).includes(squash(name)), 'in the PDF text layer');
  const bodyNumeric = extractNumeric(md);
  const email = doc.front.email ?? bodyNumeric.emails[0];
  if (email) row('email', email, squash(flat).includes(squash(email)), 'as literal text');
  else row('email', '(none in cv.md)', false, 'an email address is expected on every CV');
  const phone = doc.front.phone ?? null;
  const phoneDigits = phone ? phone.replace(/\D/g, '') : bodyNumeric.phones[0] ?? null;
  if (phoneDigits) row('phone', phone ?? phoneDigits, text.replace(/\D/g, '').includes(phoneDigits), 'digits in the PDF text layer');
  else row('phone', '(none in cv.md)', false, 'a phone number is expected on every CV');

  // Keywords: only those the CV legitimately has are expected in the PDF.
  let source: AtsReport['keywords_source'] = 'none';
  let keywords: string[] = [];
  if (input.keywords?.length) {
    keywords = input.keywords;
    source = 'input';
  } else {
    keywords = keywordsFromScore(ctx, input.job);
    if (keywords.length) source = 'score';
  }
  const gaps: string[] = [];
  const mdNorm = ` ${norm(md)} `;
  const pdfNorm = ` ${norm(text)} `;
  for (const k of keywords) {
    const nk = norm(k);
    if (!nk) continue;
    if (!mdNorm.includes(` ${nk} `)) {
      gaps.push(k);
      continue;
    }
    row('keyword', k, pdfNorm.includes(` ${nk} `) || squash(pdfNorm).includes(squash(nk)), 'in cv.md, so it must reach the PDF text layer');
  }

  // Watermark.
  if (wm.enabled) {
    const present = squash(flat).includes(squash(wm.text));
    const marks = pdf.items.filter((it) => wm.text.toLowerCase().includes(it.str.trim().toLowerCase()) && it.str.trim().length >= 6);
    const sizes = [...new Set(marks.map((m) => m.sizePt))];
    const pagesWith = new Set(marks.map((m) => m.page)).size;
    const sizeOk = marks.length > 0 && marks.every((m) => Math.abs(m.sizePt - wm.size_pt) <= 0.25);
    row('watermark', `"${wm.text}" at ${wm.size_pt} pt on every page`, present && sizeOk && pagesWith === pdf.pages,
      present ? `found on ${pagesWith} of ${pdf.pages} page(s), size ${sizes.join(', ') || 'unknown'} pt` : 'not found in the text layer');
  } else {
    row('watermark', 'off (cv.watermark.enabled: false)', !squash(flat).includes(squash(wm.text)), 'must be absent');
  }

  // No local paths anywhere: text layer, document info, raw bytes.
  const leaks = [...new Set([...pathLeaks(text), ...pathLeaks(pdf.meta.join('\n')), ...pathLeaks(bytes.toString('latin1'))])];
  row('no local paths', 'no file:// and no home-folder path', leaks.length === 0, leaks.length ? `found: ${leaks.join(', ')}` : 'none found');

  if (out.style === 'modern') {
    const max = settings.cv.modern_max_pages;
    row('pages', `at most ${max}`, pdf.pages <= max, `${pdf.pages} page(s)`);
    const html = out.pdf_path.replace(/\.pdf$/, '.html');
    if (fs.existsSync(html)) {
      const h = fs.readFileSync(html, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const bad = ['<table', '<img', '<svg'].filter((t) => h.includes(t));
      row('single column, real text', 'no tables, images or icons', bad.length === 0, bad.length ? `found ${bad.join(', ')}` : 'ok');
    }
  } else {
    row('pages', 'no limit (traditional)', true, `${pdf.pages} page(s)`);
  }

  const report: AtsReport = { job_id: input.job, passed: rows.every((r) => r.ok), pdf: out.pdf_path, pages: pdf.pages, rows, keywords_source: source, gaps };
  ctx.db().prepare('UPDATE cv_outputs SET ats_json = ? WHERE id = ?').run(JSON.stringify({ passed: report.passed, rows, gaps }), out.id);
  return report;
}
