import type { Browser } from 'playwright';

/**
 * PDF printing and reading for `cv render` and `cv ats-check`.
 *
 * Browser order: the person's installed Google Chrome, then Microsoft Edge, then Playwright's bundled
 * Chromium. Nothing is downloaded. SLJ_NO_BROWSER=1 forces the "print it by hand" path (tests, and
 * people who do not want a browser launched).
 */
export interface LaunchedBrowser {
  browser: Browser;
  name: 'chrome' | 'msedge' | 'chromium';
}

export async function launchBrowser(env: NodeJS.ProcessEnv = process.env): Promise<LaunchedBrowser | null> {
  if (env.SLJ_NO_BROWSER === '1') return null;
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }
  for (const name of ['chrome', 'msedge', 'chromium'] as const) {
    try {
      const browser = await chromium.launch(name === 'chromium' ? { headless: true } : { channel: name, headless: true });
      return { browser, name };
    } catch {
      // try the next one
    }
  }
  return null;
}

export interface Margins {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Chrome's footer template for the watermark (PRD §5.5). Font size must be set explicitly: Chrome's
 * header/footer default is tiny. It is printed inside the page's bottom margin, so it never moves content.
 */
export function footerTemplate(text: string, sizePt: number, color: string): string {
  return (
    `<div style="width:100%;text-align:center;font-size:${sizePt}pt;line-height:1;color:${esc(color)};` +
    `font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${esc(text)}</div>`
  );
}

/** Always this, never Chrome's default header (date + title) or default footer (local file:// path + page numbers). */
export const EMPTY_HEADER = '<span></span>';

export interface PrintOptions {
  pageSize: 'A4' | 'Letter';
  margins: Margins;
  watermark: { text: string; sizePt: number; color: string } | null;
}

/**
 * Prints HTML to PDF. The HTML is loaded with setContent, so the page has no file:// URL at all, and
 * displayHeaderFooter is on with an empty header: with it off Chrome prints nothing, with it on and no
 * templates Chrome prints the date, title and URL. The footer is either the watermark or an empty span.
 */
export async function printPdf(b: Browser, html: string, opts: PrintOptions): Promise<Buffer> {
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: opts.pageSize,
      printBackground: true,
      preferCSSPageSize: false,
      margin: opts.margins,
      displayHeaderFooter: true,
      headerTemplate: EMPTY_HEADER,
      footerTemplate: opts.watermark ? footerTemplate(opts.watermark.text, opts.watermark.sizePt, opts.watermark.color) : EMPTY_HEADER,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export interface PdfTextItem {
  page: number;
  str: string;
  sizePt: number;
  x: number;
  y: number;
}

export interface PdfInfo {
  pages: number;
  text: string;
  items: PdfTextItem[];
  /** Info dictionary values (Title, Creator, ...), for the path-leak check. */
  meta: string[];
}

/** Page count and text layer, with each text item's font size in points (from its transform matrix). */
export async function readPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const items: PdfTextItem[] = [];
  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const strs: string[] = [];
    for (const it of tc.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
      if (typeof it.str !== 'string') continue;
      strs.push(it.str + (it.hasEOL ? '\n' : ''));
      if (!it.str.trim() || !it.transform) continue;
      const [a, b, , , e, f] = it.transform;
      items.push({ page: p, str: it.str, sizePt: Math.round(Math.hypot(a, b) * 100) / 100, x: e, y: f });
    }
    pageTexts.push(strs.join(''));
  }
  const meta: string[] = [];
  try {
    const m = (await doc.getMetadata()) as { info?: Record<string, unknown> };
    for (const v of Object.values(m.info ?? {})) if (typeof v === 'string') meta.push(v);
  } catch {
    // no metadata
  }
  const pages = doc.numPages;
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return { pages, text: pageTexts.join('\n'), items, meta };
}
