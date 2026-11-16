/**
 * `slj resume import`: a CV file → user/resume.raw.md (+ user/resume.md on first import).
 * Deterministic: no model is involved. Scans and photos come back as NEEDS_VISION for the agent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { docxToMarkdown } from './docx.ts';
import { pdfToMarkdown } from './pdf.ts';
import { encodePng } from './png.ts';

export const RESUME_EXTS = ['.pdf', '.docx', '.md', '.txt', '.png', '.jpg', '.jpeg'] as const;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);
const MAX_BYTES = 20 * 1024 * 1024;
/** Below this many characters of text on a page, a PDF page is treated as a scan. */
const MIN_PAGE_CHARS = 40;

export type ImportMethod = 'text' | 'docx' | 'vision' | 'plain';

export interface ImportResult {
  status: 'ok' | 'NEEDS_VISION';
  method: ImportMethod;
  /** The file that was read. */
  source_path: string;
  /** The copy kept in user/inbox/ (the source itself when it was already there). */
  original_path: string;
  picked_from_inbox: boolean;
  /** user/resume.raw.md, or null when nothing could be converted (a scan or photo). */
  raw_path: string | null;
  resume_path: string;
  /** Whether this run wrote user/resume.md. */
  resume_written: boolean;
  /** Page images for the agent to read with its own vision (NEEDS_VISION). */
  images: string[];
  image_renderer: 'canvas' | 'embedded-image' | 'original' | null;
  hash: string;
  already_imported: boolean;
  pages: number;
  characters: number;
  headings: number;
  bullets: number;
  tables: number;
  links: number;
  two_column: boolean;
  two_column_pages: number[];
  scanned_pages: number[];
  warnings: string[];
  next_step: string;
}

// ---------------------------------------------------------------- choosing the file

const expandHome = (p: string) => p.replace(/^~(?=$|[/\\])/, os.homedir());

/** Copies `jobs add` keeps of job ads are named <16 hex>.<ext>; they are not CVs. */
const isJobAdCopy = (name: string) => /^[0-9a-f]{16}\.[a-z]+$/i.test(name);

function newestInInbox(ctx: Context): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(ctx.paths.inboxDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => !n.startsWith('.') && !isJobAdCopy(n) && (RESUME_EXTS as readonly string[]).includes(path.extname(n).toLowerCase()))
    .map((n) => path.join(ctx.paths.inboxDir, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || a.localeCompare(b));
  return candidates[0] ?? null;
}

export function resolveResumeFile(ctx: Context, file?: string): { abs: string; ext: string; picked: boolean } {
  let abs: string | null = null;
  let picked = false;
  if (file && file.trim()) {
    const direct = path.resolve(expandHome(file.trim()));
    const inInbox = path.join(ctx.paths.inboxDir, path.basename(file.trim()));
    abs = fs.existsSync(direct) ? direct : fs.existsSync(inInbox) ? inInbox : null;
    if (!abs) throw new SljError('NOT_FOUND', `No file at ${direct} (nor in user/inbox/).`, { path: direct });
  } else {
    abs = newestInInbox(ctx);
    picked = true;
    if (!abs) {
      throw new SljError('NOT_FOUND', `No CV found. Put a PDF, Word (.docx), text or photo of the CV in ${ctx.paths.inboxDir}, or give its path.`, {
        inbox: ctx.paths.inboxDir,
        accepted: RESUME_EXTS,
      });
    }
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.doc') {
    throw new SljError('FILE_REJECTED', 'Old Word .doc files cannot be read. Open it in Word or LibreOffice and save it as .docx or PDF, then import that.');
  }
  if (!(RESUME_EXTS as readonly string[]).includes(ext)) {
    throw new SljError('FILE_REJECTED', `A CV must be one of: ${RESUME_EXTS.join(', ')}. Got "${ext || 'no extension'}".`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new SljError('FILE_REJECTED', `${abs} is not a file.`);
  if (stat.size === 0) throw new SljError('FILE_REJECTED', `${abs} is empty.`);
  if (stat.size > MAX_BYTES) throw new SljError('FILE_REJECTED', 'CV files must be 20 MB or smaller.');
  return { abs, ext, picked };
}

/** Keeps the original in user/inbox/, named by content, so importing the same file twice changes nothing. */
function keepOriginal(ctx: Context, abs: string, bytes: Buffer, ext: string, hash: string): string {
  const inbox = path.resolve(ctx.paths.inboxDir);
  if (path.dirname(path.resolve(abs)) === inbox) return abs;
  fs.mkdirSync(inbox, { recursive: true });
  const dest = path.join(inbox, `resume-${hash}${ext === '.jpeg' ? '.jpg' : ext}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, bytes);
  return dest;
}

// ---------------------------------------------------------------- page images for vision

const CANVAS_MODULE = '@napi-rs/canvas';

async function canvasAvailable(): Promise<boolean> {
  try {
    await import(CANVAS_MODULE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes PNGs of the given PDF pages to user/cache/resume-pages/. Uses @napi-rs/canvas when it is
 * installed; otherwise pulls out the scanned image embedded in each page (a scan is one big picture
 * per page) and encodes it without a canvas. Pages that yield nothing are left to the original file.
 */
async function pageImages(ctx: Context, data: Uint8Array, pages: number[], hash: string): Promise<{ files: string[]; renderer: ImportResult['image_renderer'] }> {
  const dir = path.join(ctx.paths.cacheDir, 'resume-pages');
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const unpdf = await import('unpdf');
  if (await canvasAvailable()) {
    try {
      for (const n of pages) {
        const png = await unpdf.renderPageAsImage(new Uint8Array(data), n, { canvasImport: () => import(CANVAS_MODULE), scale: 2 } as never);
        const file = path.join(dir, `${hash}-p${n}.png`);
        fs.writeFileSync(file, Buffer.from(png as Uint8Array));
        files.push(file);
      }
      return { files, renderer: 'canvas' };
    } catch {
      files.length = 0;
    }
  }
  try {
    const doc = await unpdf.getDocumentProxy(new Uint8Array(data), { verbosity: 0 } as never);
    for (const n of pages) {
      const imgs = await unpdf.extractImages(doc, n);
      const big = imgs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!big || big.width * big.height < 200 * 200) continue;
      const channels = Math.round(big.data.length / (big.width * big.height));
      const file = path.join(dir, `${hash}-p${n}.png`);
      fs.writeFileSync(file, encodePng(big.data, big.width, big.height, channels));
      files.push(file);
    }
  } catch {
    // Fall back to the original file.
  }
  return { files, renderer: files.length ? 'embedded-image' : 'original' };
}

// ---------------------------------------------------------------- import

interface LastImport {
  hash: string;
  path: string;
  method: ImportMethod;
  imported_at: string;
}

/** The newest `resume import` row (rows written by `resume save` have path 'resume.md'). */
export function lastImport(ctx: Context): LastImport | null {
  const row = ctx
    .db()
    .prepare("SELECT hash, path, method, imported_at FROM resumes WHERE path <> 'resume.md' ORDER BY id DESC LIMIT 1")
    .get() as LastImport | undefined;
  return row ?? null;
}

export async function importResume(ctx: Context, opts: { file?: string; force?: boolean } = {}): Promise<ImportResult> {
  const { abs, ext, picked } = resolveResumeFile(ctx, opts.file);
  const bytes = fs.readFileSync(abs);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const original = keepOriginal(ctx, abs, bytes, ext, hash);
  const warnings: string[] = [];

  let method: ImportMethod;
  let markdown = '';
  let status: ImportResult['status'] = 'ok';
  let images: string[] = [];
  let renderer: ImportResult['image_renderer'] = null;
  const counts = { pages: 1, headings: 0, bullets: 0, tables: 0, links: 0 };
  let twoColumnPages: number[] = [];
  let scannedPages: number[] = [];

  if (ext === '.md' || ext === '.txt') {
    method = 'plain';
    markdown = bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    if (!markdown) throw new SljError('FILE_REJECTED', `${abs} has no text in it.`);
    markdown += '\n';
    counts.headings = (markdown.match(/^#{1,6} /gm) ?? []).length;
    counts.bullets = (markdown.match(/^\s*([-*+]|\d+\.) /gm) ?? []).length;
  } else if (ext === '.docx') {
    method = 'docx';
    let conv;
    try {
      conv = await docxToMarkdown(bytes);
    } catch (err) {
      throw new SljError('FILE_REJECTED', `Could not read ${path.basename(abs)} as a Word file: ${(err as Error).message}. Save it again as .docx or PDF.`);
    }
    markdown = conv.markdown;
    Object.assign(counts, { headings: conv.headings, bullets: conv.bullets, tables: conv.tables, links: conv.links });
    warnings.push(...conv.warnings);
    if (markdown.replace(/\s/g, '').length < 200) {
      warnings.push('The Word file gave very little text. If the CV is built from text boxes or is a picture pasted into Word, export it as PDF and import that.');
    }
  } else if (IMAGE_EXTS.has(ext)) {
    method = 'vision';
    status = 'NEEDS_VISION';
    images = [original];
    renderer = 'original';
  } else {
    let conv;
    try {
      conv = await pdfToMarkdown(new Uint8Array(bytes));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/password/i.test(msg)) throw new SljError('FILE_REJECTED', 'This PDF is password-protected. Save an unprotected copy (Print → Save as PDF) and import that.');
      throw new SljError('FILE_REJECTED', `Could not read ${path.basename(abs)} as a PDF: ${msg}`);
    }
    counts.pages = conv.pages;
    twoColumnPages = conv.twoColumnPages;
    scannedPages = conv.scannedPages;
    Object.assign(counts, { headings: conv.headings, bullets: conv.bullets, tables: conv.tables, links: conv.links });
    warnings.push(...conv.warnings);
    const textChars = conv.pageChars.reduce((s, n) => s + n, 0);
    const noText = scannedPages.length === conv.pages || textChars < MIN_PAGE_CHARS * conv.pages;
    if (noText) {
      method = 'vision';
      status = 'NEEDS_VISION';
      scannedPages = Array.from({ length: conv.pages }, (_, i) => i + 1);
    } else {
      method = 'text';
      markdown = conv.markdown;
      if (scannedPages.length) status = 'NEEDS_VISION';
    }
    if (status === 'NEEDS_VISION') {
      const r = await pageImages(ctx, new Uint8Array(bytes), scannedPages, hash);
      images = r.files;
      renderer = r.renderer;
      if (!images.length) {
        images = [original];
        warnings.push('No page images could be made here (no canvas package installed and no scanned image found inside the PDF). Read the original PDF directly.');
      }
    }
    if (conv.pages > 6) warnings.push(`The CV has ${conv.pages} pages. Most Sri Lankan employers expect 1–3.`);
  }

  let rawPath: string | null = null;
  let resumeWritten = false;
  fs.mkdirSync(ctx.paths.userDir, { recursive: true });
  if (markdown) {
    fs.writeFileSync(ctx.paths.resumeRawFile, markdown);
    rawPath = ctx.paths.resumeRawFile;
    if (!fs.existsSync(ctx.paths.resumeFile) || opts.force) {
      fs.writeFileSync(ctx.paths.resumeFile, markdown);
      resumeWritten = true;
    } else {
      warnings.push('user/resume.md already exists and was kept as it is. Run again with --force if this file is the CV to use from now on.');
    }
  }

  const prev = lastImport(ctx);
  const already = !!prev && prev.hash === hash && prev.method === method;
  if (!already) {
    ctx
      .db()
      .prepare('INSERT INTO resumes (hash, path, imported_at, method) VALUES (?, ?, ?, ?)')
      .run(hash, path.relative(ctx.paths.userDir, original), ctx.now().toISOString(), method);
  }

  const characters = markdown.length;
  if (status === 'ok' && markdown.replace(/\s/g, '').length < 300) {
    warnings.push('Very little text came out of this CV. Compare resume.raw.md with the original before going on.');
  }

  let next: string;
  if (status === 'NEEDS_VISION' && !markdown) {
    next =
      'This CV is a picture, not text. Open each file in `images` with your own vision and type out the whole CV as Markdown, exactly as written (no additions), ' +
      'into user/resume.md. Then run `slj resume save`.';
  } else if (status === 'NEEDS_VISION') {
    next =
      `Pages ${scannedPages.join(', ')} are scans. Read them from \`images\` with your own vision and add their text, exactly as written, where they belong ` +
      'when you clean resume.raw.md into user/resume.md. Then run `slj resume save`.';
  } else if (resumeWritten) {
    next =
      'Read user/resume.raw.md and tidy it into user/resume.md: rejoin broken lines, fix bullets and headings, put two-column sections in a sensible order. ' +
      'Never add content. Then run `slj resume save`.';
  } else {
    next = 'user/resume.md was kept. If this file replaces the old CV, run `slj resume import` again with --force; otherwise compare it with resume.raw.md.';
  }

  return {
    status,
    method,
    source_path: abs,
    original_path: original,
    picked_from_inbox: picked,
    raw_path: rawPath,
    resume_path: ctx.paths.resumeFile,
    resume_written: resumeWritten,
    images,
    image_renderer: renderer,
    hash,
    already_imported: already,
    pages: counts.pages,
    characters,
    headings: counts.headings,
    bullets: counts.bullets,
    tables: counts.tables,
    links: counts.links,
    two_column: twoColumnPages.length > 0,
    two_column_pages: twoColumnPages,
    scanned_pages: scannedPages,
    warnings,
    next_step: next,
  };
}
