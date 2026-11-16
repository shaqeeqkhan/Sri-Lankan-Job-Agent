/**
 * PDF text layer → Markdown, using pdf.js through `unpdf`.
 *
 * pdf.js gives positioned text runs, not structure. This rebuilds the structure a CV needs from
 * positions and fonts: headings from font size and weight, bullets from bullet glyphs or a hanging
 * indent, wrapped lines rejoined when the next line's first word would not have fitted on the
 * previous one, aligned rows as Markdown tables, link annotations as Markdown links, and two-column
 * layouts read one column at a time.
 */
import { getDocumentProxy, inspectPages } from 'unpdf';

export interface PdfConversion {
  markdown: string;
  pages: number;
  /** Visible text characters (whitespace excluded) per page, from pdf.js. */
  pageChars: number[];
  /** 1-based pages that look like scans: no usable text layer, mostly image. */
  scannedPages: number[];
  /** 1-based pages read as two columns. */
  twoColumnPages: number[];
  /** True when most of the text is an invisible OCR layer (a scanner's own text recognition). */
  ocrLayer: boolean;
  headings: number;
  bullets: number;
  tables: number;
  links: number;
  warnings: string[];
}

interface Run {
  text: string;
  x: number;
  x1: number;
  bold: boolean;
  link?: string;
}

interface Item extends Run {
  /** Baseline, measured from the top of the page. */
  y: number;
  size: number;
}

interface Line {
  y: number;
  size: number;
  x: number;
  x1: number;
  runs: Run[];
  /** Runs split where a wide horizontal gap separates them (table cells, right-aligned dates). */
  cells: Run[][];
  bold: boolean;
  text: string;
}

type Element =
  | { kind: 'h'; size: number; bold: boolean; text: string; line: Line }
  | { kind: 'li'; text: string; x: number; ordered: string | null; line: Line; marker: boolean }
  | { kind: 'p'; text: string; x: number; line: Line }
  | { kind: 'table'; rows: string[][]; header: boolean };

const BULLET_CHARS = '•●▪■◦‣⁃○◆◇❖♦►▶➢➤✓✔∙·*–—-';
const BULLET_RE = new RegExp(`^\\s*[${BULLET_CHARS.replace(/[-\\\]^]/g, '\\$&')}]\\s*`);
const ORDERED_RE = /^\s*(\(?[0-9]{1,2}[.)]|\(?[a-h][.)])\s+/;
const TERMINAL_RE = /[.!?:;]["')\]]?$/;
const PAGE_NUMBER_RE = /^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i;

// ---------------------------------------------------------------- width estimates

/** Rough advance widths (em) for a proportional sans font: good enough to ask "would this word fit?". */
function charEm(ch: string): number {
  if (ch === ' ') return 0.28;
  if ('il.,:;|!\'`ıj'.includes(ch)) return 0.25;
  if ('ftrI()[]-'.includes(ch)) return 0.34;
  if ('mwMW@'.includes(ch)) return 0.86;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.56;
  return 0.52;
}
const textEm = (s: string) => [...s].reduce((sum, ch) => sum + charEm(ch), 0);

// ---------------------------------------------------------------- reading the PDF

interface RawPage {
  width: number;
  height: number;
  items: Item[];
  /** Link annotations, top-down rects. */
  links: { url: string; x0: number; x1: number; y0: number; y1: number }[];
}

type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;

async function readPages(doc: PdfDoc): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [, , w, h] = page.view as number[];
      const content = await page.getTextContent();
      // Font names (e.g. "ABCDEF+Arial-BoldMT") are only resolvable after the operator list is built.
      const boldFonts = new Set<string>();
      try {
        await page.getOperatorList();
        for (const id of Object.keys(content.styles)) {
          try {
            const font = page.commonObjs.get(id) as { name?: string; bold?: boolean; black?: boolean } | undefined;
            if (font && (font.bold || font.black || /bold|black|heavy|semibold|demi/i.test(font.name ?? ''))) boldFonts.add(id);
          } catch {
            // Font not resolved: treat as regular.
          }
        }
      } catch {
        // No operator list: no bold detection on this page.
      }
      const items: Item[] = [];
      for (const raw of content.items as { str?: string; transform?: number[]; width?: number; fontName?: string }[]) {
        if (typeof raw.str !== 'string' || !raw.transform) continue;
        const text = raw.str.replace(/ /g, ' ').replace(/­/g, '');
        if (!text.trim()) continue;
        const [a, b, c, d, e, f] = raw.transform;
        const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
        items.push({ text, x: e, x1: e + (raw.width ?? textEm(text) * size), y: h - f, size, bold: boldFonts.has(raw.fontName ?? '') });
      }
      const links: RawPage['links'] = [];
      try {
        for (const a of (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
          const url = a.url ?? a.unsafeUrl;
          if (a.subtype !== 'Link' || !url || !a.rect) continue;
          const [x0, y0, x1, y1] = a.rect;
          links.push({ url, x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: h - Math.max(y0, y1), y1: h - Math.min(y0, y1) });
        }
      } catch {
        // Annotations are optional.
      }
      pages.push({ width: w, height: h, items: applyLinks(items, links), links });
      page.cleanup();
    }
  }
  return pages;
}

/**
 * Splits text items so each link annotation covers whole runs. pdf.js gives one item per text run,
 * and a run often holds several links ("email · LinkedIn · GitHub"), so the link's place inside the
 * run is found by its address when the address is written out, else by estimated character positions.
 */
function applyLinks(items: Item[], links: RawPage['links']): Item[] {
  if (!links.length) return items;
  const out: Item[] = [];
  const placed = new Set<number>();
  for (const it of items) {
    const ranges: { start: number; end: number; url: string }[] = [];
    links.forEach((l, i) => {
      const midY = it.y - it.size * 0.3;
      if (midY < l.y0 - 2 || midY > l.y1 + 2 || l.x1 < it.x || l.x0 > it.x1) return;
      const r = locateLink(it, l);
      if (r && !ranges.some((o) => r.start < o.end && o.start < r.end)) {
        ranges.push({ ...r, url: l.url });
        placed.add(i);
      }
    });
    if (!ranges.length) {
      out.push(it);
      continue;
    }
    ranges.sort((p, q) => p.start - q.start);
    const totalEm = textEm(it.text) || 1;
    const xAt = (idx: number) => it.x + ((it.x1 - it.x) * textEm(it.text.slice(0, idx))) / totalEm;
    let pos = 0;
    const push = (start: number, end: number, link?: string) => {
      const text = it.text.slice(start, end);
      if (text.trim()) out.push({ ...it, text, x: xAt(start), x1: xAt(end), ...(link ? { link } : {}) });
    };
    for (const r of ranges) {
      push(pos, r.start);
      push(r.start, r.end, r.url);
      pos = r.end;
    }
    push(pos, it.text.length);
  }
  // A link that sits on no text (an icon) is kept as a bare run so the address is not lost.
  links.forEach((l, i) => {
    if (placed.has(i)) return;
    const label = l.url.replace(/^mailto:/, '');
    const covered = items.some((it) => it.text.includes(label));
    if (!covered) out.push({ text: label, x: l.x0, x1: l.x1, y: l.y1 - 1, size: Math.max(6, l.y1 - l.y0), bold: false, link: l.url });
  });
  return out;
}

function locateLink(it: Item, l: RawPage['links'][number]): { start: number; end: number } | null {
  const text = it.text;
  const bare = l.url.replace(/^mailto:/i, '').replace(/^tel:/i, '');
  const forms = [bare, bare.replace(/^https?:\/\//i, ''), bare.replace(/^https?:\/\/(www\.)?/i, ''), bare.replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/i, '')];
  for (const f of forms) {
    if (f.length < 4) continue;
    const at = text.toLowerCase().indexOf(f.toLowerCase());
    if (at >= 0) return { start: at, end: at + f.length };
  }
  // Estimate character positions inside the run, then snap to whole words.
  const totalEm = textEm(text) || 1;
  const scale = (it.x1 - it.x) / totalEm;
  let em = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const w = charEm(text[i]);
    const mid = it.x + (em + w / 2) * scale;
    em += w;
    if (text[i] === ' ') continue;
    if (mid >= l.x0 - 1 && mid <= l.x1 + 1) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  if (start < 0) return null;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  // Keep separators such as "·" or "|" outside the link.
  const inner = text.slice(start, end);
  const lead = inner.length - inner.replace(/^[\s·|•,;]+/, '').length;
  const trail = inner.length - inner.replace(/[\s·|•,;]+$/, '').length;
  return end - trail > start + lead ? { start: start + lead, end: end - trail } : null;
}

// ---------------------------------------------------------------- columns

interface Regions {
  header: Item[];
  columns: Item[][];
  gutter: number | null;
}

const chars = (items: Item[]) => items.reduce((s, it) => s + it.text.replace(/\s/g, '').length, 0);

/**
 * Finds a vertical gutter that splits the page into two columns below an optional full-width header.
 * Rejects splits that are really tables (left and right lines sitting on the same baselines) and
 * splits that hold too little of the page's text.
 */
function splitColumns(items: Item[], width: number): Regions {
  const total = chars(items);
  if (total < 200) return { header: [], columns: [items], gutter: null };
  let best: { g: number; below: number; crossBottom: number } | null = null;
  const runs: { g: number; below: number; crossBottom: number }[] = [];
  for (let g = Math.round(width * 0.22); g <= Math.round(width * 0.78); g += 2) {
    const crossing = items.filter((it) => it.x < g + 5 && it.x1 > g - 5);
    const crossBottom = crossing.length ? Math.max(...crossing.map((it) => it.y + it.size * 0.3)) : -Infinity;
    const below = items.filter((it) => it.y - it.size > crossBottom);
    const left = below.filter((it) => it.x1 <= g);
    const right = below.filter((it) => it.x >= g);
    const lc = chars(left);
    const rc = chars(right);
    if (lc < total * 0.12 || rc < total * 0.12 || lc + rc < total * 0.5) continue;
    const lys = distinctYs(left);
    const rys = distinctYs(right);
    if (lys.length < 4 || rys.length < 4) continue;
    // Vertical overlap of the two sides.
    const overlap = Math.min(lys.at(-1)!, rys.at(-1)!) - Math.max(lys[0], rys[0]);
    const shorter = Math.min(lys.at(-1)! - lys[0], rys.at(-1)! - rys[0]);
    if (shorter <= 0 || overlap < shorter * 0.4) continue;
    // A table's cells share baselines; columns of a CV mostly do not.
    const [few, many] = lys.length <= rys.length ? [lys, rys] : [rys, lys];
    const aligned = few.filter((y) => many.some((m) => Math.abs(m - y) < 1.5)).length / few.length;
    if (aligned > 0.75) continue;
    runs.push({ g, below: lc + rc, crossBottom });
  }
  if (!runs.length) return { header: [], columns: [items], gutter: null };
  // The widest stretch of valid gutters with the most text below it; take its middle.
  const top = Math.max(...runs.map((r) => r.below));
  const good = runs.filter((r) => r.below === top);
  let stretch: typeof good = [good[0]];
  let cur: typeof good = [good[0]];
  for (let i = 1; i < good.length; i++) {
    if (good[i].g - good[i - 1].g <= 2) cur.push(good[i]);
    else cur = [good[i]];
    if (cur.length > stretch.length) stretch = cur;
  }
  best = stretch[Math.floor(stretch.length / 2)];
  const g = best.g;
  const below = items.filter((it) => it.y - it.size > best.crossBottom);
  const firstLeft = Math.min(...below.filter((it) => it.x1 <= g).map((it) => it.y));
  const firstRight = Math.min(...below.filter((it) => it.x >= g).map((it) => it.y));
  // Lines above where both columns have started belong to the header, as do crossing lines.
  const colTop = Math.max(firstLeft, firstRight) - 1;
  const header: Item[] = [];
  const left: Item[] = [];
  const right: Item[] = [];
  for (const it of items) {
    if (it.y - it.size <= best.crossBottom || (it.y < colTop && it.y - it.size * 1.2 < Math.min(firstLeft, firstRight))) header.push(it);
    else if (it.x1 <= g + 2) left.push(it);
    else if (it.x >= g - 2) right.push(it);
    else header.push(it);
  }
  return { header, columns: [left, right], gutter: g };
}

function distinctYs(items: Item[]): number[] {
  const ys = [...new Set(items.map((it) => Math.round(it.y * 2) / 2))].sort((a, b) => a - b);
  return ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1);
}

// ---------------------------------------------------------------- lines

function groupLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Item[][] = [];
  for (const it of sorted) {
    const g = groups.at(-1);
    if (g && Math.abs(g[0].y - it.y) < Math.min(g[0].size, it.size) * 0.4) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const size = g.reduce((m, it) => (it.text.length > m.n ? { n: it.text.length, s: it.size } : m), { n: -1, s: g[0].size }).s;
    const runs: Run[] = g.map(({ text, x, x1, bold, link }) => ({ text, x, x1, bold, ...(link ? { link } : {}) }));
    let cells: Run[][] = [];
    let prev: Run | null = null;
    const gaps: number[] = [];
    for (const r of runs) {
      const gap = prev ? r.x - prev.x1 : 0;
      if (!prev || gap > Math.max(1.2 * size, 9)) {
        cells.push([r]);
        if (prev) gaps.push(gap);
      } else cells.at(-1)!.push(r);
      prev = r;
    }
    // Justified text stretches word gaps evenly: many wide, near-equal gaps between single words is
    // one line of prose, not a table row.
    if (gaps.length >= 3 && Math.max(...gaps) / Math.min(...gaps) < 1.35 && cells.every((c) => c.length === 1 && !/\s\S+\s/.test(c[0].text.trim()))) {
      cells = [runs];
    }
    const bold = runs.every((r) => r.bold || !/[A-Za-z0-9]/.test(r.text));
    const line: Line = { y: g[0].y, size, x: g[0].x, x1: Math.max(...g.map((it) => it.x1)), runs, cells, bold, text: '' };
    line.text = plain(runs, size);
    return line;
  });
}

function needsSpace(prev: Run, next: Run, size: number): boolean {
  if (/\s$/.test(prev.text) || /^\s/.test(next.text)) return false;
  return next.x - prev.x1 > size * 0.15;
}

function plain(runs: Run[], size: number): string {
  let s = '';
  runs.forEach((r, i) => {
    if (i > 0 && needsSpace(runs[i - 1], r, size)) s += ' ';
    s += r.text;
  });
  return s.replace(/\s+/g, ' ').trim();
}

/** Inline Markdown for runs: **bold** (only when the line mixes weights) and [text](url). */
function inline(runs: Run[], size: number, markBold: boolean): string {
  type Seg = { text: string; bold: boolean; link?: string };
  const segs: Seg[] = [];
  runs.forEach((r, i) => {
    const space = i > 0 && needsSpace(runs[i - 1], r, size) ? ' ' : '';
    const last = segs.at(-1);
    const bold = markBold && r.bold;
    if (last && last.bold === bold && last.link === r.link) last.text += space + r.text;
    else {
      if (last && space) last.text += space;
      segs.push({ text: r.text, bold, ...(r.link ? { link: r.link } : {}) });
    }
  });
  return segs
    .map((s) => {
      const lead = s.text.match(/^\s*/)![0];
      const trail = s.text.match(/\s*$/)![0];
      let core = s.text.trim();
      if (!core) return s.text;
      if (s.link) core = `[${core.replace(/[[\]]/g, '\\$&')}](${s.link})`;
      if (s.bold && /[A-Za-z0-9]/.test(core)) core = `**${core}**`;
      return lead + core + trail;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- structure

interface DocStats {
  body: number;
  /** Heading font sizes, largest first, clustered within 6%. */
  headingSizes: number[];
  /** The usual baseline-to-baseline distance inside a paragraph, per rounded font size. */
  pitch: Map<number, number>;
}

const sizeKey = (size: number) => Math.round(size * 2) / 2;

function docStats(regions: Line[][]): DocStats {
  const lines = regions.flat();
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(sizeKey(l.size), (weight.get(sizeKey(l.size)) ?? 0) + l.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const big = [...new Set(lines.filter((l) => isSizeHeading(l, body)).map((l) => sizeKey(l.size)))].sort((a, b) => b - a);
  const headingSizes: number[] = [];
  for (const s of big) if (!headingSizes.length || headingSizes.at(-1)! / s > 1.06) headingSizes.push(s);
  // Line pitch: the most common gap between consecutive lines of the same size (within ±0.3 pt).
  const gaps = new Map<number, number[]>();
  for (const region of regions) {
    for (let i = 1; i < region.length; i++) {
      const a = region[i - 1];
      const b = region[i];
      if (sizeKey(a.size) !== sizeKey(b.size)) continue;
      const g = b.y - a.y;
      if (g > a.size * 0.9 && g < a.size * 2.2) gaps.set(sizeKey(a.size), [...(gaps.get(sizeKey(a.size)) ?? []), g]);
    }
  }
  const pitch = new Map<number, number>();
  for (const [k, gs] of gaps) {
    let best = gs[0];
    let bestN = 0;
    for (const g of gs) {
      const n = gs.filter((o) => Math.abs(o - g) <= 0.3).length;
      if (n > bestN || (n === bestN && g < best)) [best, bestN] = [g, n];
    }
    if (bestN >= 2) pitch.set(k, best);
  }
  return { body, headingSizes, pitch };
}

/** True when the vertical gap between two lines is more than the usual line pitch: paragraph or item spacing. */
function spaced(prev: Line, next: Line, st: DocStats): boolean {
  const p = st.pitch.get(sizeKey(next.size));
  if (p === undefined || sizeKey(prev.size) !== sizeKey(next.size)) return false;
  return next.y - prev.y > p + Math.max(0.6, next.size * 0.05);
}

const isSizeHeading = (l: Line, body: number) => l.size >= body * 1.12 && l.text.length <= 90 && l.cells.length === 1;

function headingCandidate(l: Line, st: DocStats): boolean {
  if (l.cells.length > 1 || BULLET_RE.test(l.text) && !/^[A-Z]/.test(l.text)) return false;
  if (isSizeHeading(l, st.body)) return true;
  const words = l.text.split(' ').length;
  const letters = l.text.replace(/[^A-Za-z]/g, '');
  if (l.bold && l.text.length <= 80 && words <= 12 && !/[.,;]$/.test(l.text) && letters.length >= 2) return true;
  if (letters.length >= 4 && letters === letters.toUpperCase() && l.text.length <= 40 && words <= 5 && !/\d{3}/.test(l.text)) return true;
  return false;
}

function headingLevel(l: { size: number; bold: boolean }, st: DocStats, h1Count: number): number {
  const rounded = Math.round(l.size * 2) / 2;
  const idx = st.headingSizes.findIndex((s) => rounded >= s / 1.06);
  if (idx === 0 && h1Count <= 2) return 1;
  if (idx >= 0) return Math.min(3, idx + (h1Count <= 2 ? 1 : 2));
  return 3;
}

/** Turns one region's lines (a column, or a whole single-column page) into elements. */
function structure(lines: Line[], st: DocStats): Element[] {
  if (!lines.length) return [];
  const body = lines.filter((l) => !headingCandidate(l, st) && l.cells.length === 1);
  const right = body.length ? Math.max(...body.map((l) => l.x1)) : Math.max(...lines.map((l) => l.x1));
  // The left edge body text starts at: the leftmost start that carries a fair share of the text,
  // or a left-aligned heading's edge when every body line is indented under the headings.
  const starts = new Map<number, number>();
  for (const l of body) starts.set(Math.round(l.x), (starts.get(Math.round(l.x)) ?? 0) + l.text.length);
  const bodyChars = body.reduce((s, l) => s + l.text.length, 0);
  const common = [...starts.entries()].filter(([, n]) => n >= bodyChars * 0.1).map(([x]) => x);
  const headingXs = lines.filter((l) => headingCandidate(l, st)).map((l) => l.x);
  const textBase = Math.min(...(common.length ? common : lines.map((l) => l.x)), ...headingXs.filter((x) => x < (common[0] ?? Infinity)));
  const width = Math.max(1, right - textBase);
  const center = (textBase + right) / 2;

  const out: Element[] = [];
  let prev: Line | null = null;
  const tableRows: Line[] = [];

  const flushTable = () => {
    if (tableRows.length >= 2 && alignedTable(tableRows)) {
      const header = tableRows[0].bold;
      out.push({ kind: 'table', rows: tableRows.map((l) => l.cells.map((c) => inline(c, l.size, !l.bold).replace(/\|/g, '\\|'))), header });
    } else {
      for (const l of tableRows) out.push({ kind: 'p', text: l.cells.map((c) => inline(c, l.size, !l.bold)).join(' | '), x: l.x, line: l });
    }
    tableRows.length = 0;
  };

  for (const original of lines) {
    let l = original;
    const lastEl = out.at(-1);

    // Inside a table, split a row at the table's column edges even when the gap is narrow
    // (a long subject name pushed up against its grade).
    if (tableRows.length && l.cells.length < tableRows[0].cells.length && !spacedFar(tableRows.at(-1)!, l)) {
      const re = resplit(l, tableRows[0]);
      if (re) l = re;
    }
    if (l.cells.length > 1 && !headingCandidate(l, st)) {
      if (tableRows.length && (tableRows[0].cells.length !== l.cells.length || spacedFar(tableRows.at(-1)!, l))) flushTable();
      tableRows.push(l);
      prev = l;
      continue;
    }
    if (tableRows.length) flushTable();

    if (PAGE_NUMBER_RE.test(l.text)) {
      prev = l;
      continue;
    }

    const continues =
      prev !== null &&
      lastEl !== undefined &&
      lastEl.kind !== 'table' &&
      l.y - prev.y < Math.max(prev.size, l.size) * 2.1 &&
      Math.abs(prev.size - l.size) < 0.8 &&
      // With explicit bullet glyphs every new item is marked, so spacing is not needed to tell items apart
      // (and a glyph from a fallback font can make its line box taller than the usual pitch).
      ((lastEl.kind === 'li' && lastEl.marker) || !spaced(prev, l, st)) &&
      (prev.x1 - textBase) / width >= 0.6 &&
      wrapped(prev, l, right);

    if (headingCandidate(l, st)) {
      if (lastEl?.kind === 'h' && continues && lastEl.line.size === l.size && lastEl.bold === l.bold) {
        lastEl.text += ` ${l.text}`;
        lastEl.line = l;
      } else out.push({ kind: 'h', size: l.size, bold: l.bold, text: l.text, line: l });
      prev = l;
      continue;
    }

    const marker = l.text.match(BULLET_RE);
    const ordered = l.text.match(ORDERED_RE);
    const dash = !!marker && /^\s*[-–—]/.test(marker[0]);
    // A bullet needs text after it; a dash that starts a wrapped line ("(January 2019 / – May 2021)") is not one.
    const isMarker =
      !!marker && /[A-Za-z0-9(]/.test(l.text.slice(marker[0].length, marker[0].length + 2)) && !/^[-–—]\d/.test(l.text) && !(dash && continues);
    const text = inline(l.runs, l.size, !l.bold);

    if (isMarker || (ordered && !continues)) {
      out.push({ kind: 'li', text: isMarker ? stripLead(text) : text.slice(ordered![0].length), x: l.x, ordered: isMarker ? null : ordered![1], line: l, marker: true });
      prev = l;
      continue;
    }

    if (continues && (lastEl.kind === 'p' || lastEl.kind === 'li') && l.x >= lastEl.x - 3) {
      const sameEdge = lastEl.kind === 'li' ? l.x <= lastEl.x + 14 + 3 * l.size : Math.abs(l.x - lastEl.x) <= 6;
      if (sameEdge || Math.abs((l.x + l.x1) / 2 - center) < 12) {
        lastEl.text = joinWrapped(lastEl.text, text);
        lastEl.line = l;
        prev = l;
        continue;
      }
    }

    const indent = l.x - textBase;
    const centered = Math.abs((l.x + l.x1) / 2 - center) < 12 && indent > 30;
    if (indent >= 6 && indent <= 45 && !centered) out.push({ kind: 'li', text, x: l.x, ordered: null, line: l, marker: false });
    else out.push({ kind: 'p', text, x: l.x, line: l });
    prev = l;
  }
  if (tableRows.length) flushTable();
  return out;
}

/** More than two line heights apart: a table does not run across that. */
const spacedFar = (a: Line, b: Line) => b.y - a.y > Math.max(a.size, b.size) * 2.6;

/** Re-splits a line into cells at a table's column edges. Null when it does not line up. */
function resplit(l: Line, model: Line): Line | null {
  const edges = model.cells.slice(1).map((c) => c[0].x);
  const cells: Run[][] = [[]];
  let e = 0;
  for (const r of l.runs) {
    const cur = cells.at(-1)!;
    if (e < edges.length && r.x >= edges[e] - 4 && cur.length && r.x - cur.at(-1)!.x1 >= l.size * 0.25) {
      cells.push([r]);
      e++;
    } else cur.push(r);
  }
  return cells.length === model.cells.length ? { ...l, cells } : null;
}

/** Removes a leading bullet glyph from inline Markdown. */
function stripLead(md: string): string {
  const m = md.match(BULLET_RE);
  return m ? md.slice(m[0].length) : md;
}

/** True when `next` continues `prev`: its first word would not have fitted at the end of `prev`. */
function wrapped(prev: Line, next: Line, right: number): boolean {
  const first = next.text.split(' ')[0] ?? '';
  if (!first) return false;
  const room = right - prev.x1;
  const need = (textEm(first) + charEm(' ')) * next.size;
  if (need <= room - next.size * 0.4) return false;
  // A short line ending a sentence, followed by a capital, is more likely a new item.
  if (TERMINAL_RE.test(prev.text) && /^[A-Z]/.test(first) && room > (right - prev.x) * 0.25) return false;
  return true;
}

function joinWrapped(a: string, b: string): string {
  // A word hyphenated across lines ("manage-" + "ment"): drop the hyphen.
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

function alignedTable(rows: Line[]): boolean {
  const n = rows[0].cells.length;
  if (!rows.every((r) => r.cells.length === n)) return false;
  for (let c = 0; c < n; c++) {
    const xs = rows.map((r) => r.cells[c][0].x);
    if (Math.max(...xs) - Math.min(...xs) > 8) {
      // Right-aligned or centred columns: compare right edges instead.
      const rs = rows.map((r) => r.cells[c].at(-1)!.x1);
      const cs = rows.map((r) => (r.cells[c][0].x + r.cells[c].at(-1)!.x1) / 2);
      if (Math.max(...rs) - Math.min(...rs) > 8 && Math.max(...cs) - Math.min(...cs) > 8) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- rendering

function render(elements: Element[], st: DocStats, h1Count: number, counts: { headings: number; bullets: number; tables: number }): string {
  const blocks: string[] = [];
  let list: string[] = [];
  let listBase = 0;
  const flushList = () => {
    if (list.length) blocks.push(list.join('\n'));
    list = [];
  };
  for (const el of elements) {
    if (el.kind === 'li') {
      if (!list.length) listBase = el.x;
      const nested = el.x > listBase + 8 ? '  ' : '';
      list.push(`${nested}${el.ordered ? `${el.ordered.replace(/[()]/g, '').replace(/\)$/, '.')}${/[.)]$/.test(el.ordered) ? '' : '.'}` : '-'} ${el.text}`);
      counts.bullets++;
      continue;
    }
    flushList();
    if (el.kind === 'h') {
      blocks.push(`${'#'.repeat(headingLevel(el, st, h1Count))} ${el.text}`);
      counts.headings++;
    } else if (el.kind === 'p') {
      blocks.push(el.text.replace(/^(#+|\d+\.|[-*+]) /, '\\$1 '));
    } else {
      counts.tables++;
      const width = el.rows[0].length;
      const row = (cells: string[]) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
      const head = el.header ? el.rows[0] : Array.from({ length: width }, () => '');
      const body = el.header ? el.rows.slice(1) : el.rows;
      blocks.push([row(head), `|${' --- |'.repeat(width)}`, ...body.map(row)].join('\n'));
    }
  }
  flushList();
  return blocks.join('\n\n');
}

/** Drops running headers and footers: the same text near the top or bottom of every page. */
function dropRunningLines(pages: { lines: Line[]; height: number }[]): void {
  if (pages.length < 2) return;
  const key = (l: Line) => l.text.replace(/\d+/g, '#').toLowerCase();
  const edge = (l: Line, h: number) => l.y < h * 0.07 || l.y > h * 0.93;
  const counts = new Map<string, number>();
  for (const p of pages) for (const k of new Set(p.lines.filter((l) => edge(l, p.height)).map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const p of pages) p.lines = p.lines.filter((l) => !(edge(l, p.height) && (counts.get(key(l)) ?? 0) >= pages.length));
}

// ---------------------------------------------------------------- entry point

export async function pdfToMarkdown(data: Uint8Array): Promise<PdfConversion> {
  const warnings: string[] = [];
  // verbosity 0: pdf.js would otherwise print warnings about damaged files to the console.
  const doc = await getDocumentProxy(new Uint8Array(data), { fontExtraProperties: true, verbosity: 0 } as never);
  let inspection: Awaited<ReturnType<typeof inspectPages>>;
  let raw: RawPage[];
  try {
    inspection = await inspectPages(doc);
    raw = await readPages(doc);
  } finally {
    await (doc as { destroy?: () => Promise<void> }).destroy?.();
  }
  const pageChars = inspection.pages.map((p) => Math.max(0, p.textLength - p.invisibleTextLength));
  const scannedPages = inspection.pages
    .map((p, i) => ({ p, n: i + 1 }))
    .filter(({ p }) => p.textLength - p.invisibleTextLength < 40 && (p.imageCount > 0 || p.textLength === 0) && p.invisibleTextLength < 40)
    .map(({ n }) => n);
  const invisible = inspection.pages.reduce((s, p) => s + p.invisibleTextLength, 0);
  const visible = inspection.pages.reduce((s, p) => s + p.textLength, 0);
  const ocrLayer = invisible > 0 && invisible >= visible * 0.6;

  const twoColumnPages: number[] = [];
  const pageRegions = raw.map((p, i) => {
    const regions = splitColumns(p.items, p.width);
    if (regions.gutter !== null) twoColumnPages.push(i + 1);
    return { regions, height: p.height };
  });

  // Lines per region, then running headers/footers dropped across pages.
  const regionLines = pageRegions.map(({ regions, height }) => ({
    height,
    parts: [regions.header, ...regions.columns].map((items) => groupLines(items)),
  }));
  const flat = regionLines.map((p) => ({ lines: p.parts.flat(), height: p.height }));
  dropRunningLines(flat);
  const keep = new Set(flat.flatMap((p) => p.lines));
  const allLines = flat.flatMap((p) => p.lines);
  const st = docStats(regionLines.flatMap((p) => p.parts.map((lines) => lines.filter((l) => keep.has(l)))));
  const topSize = st.headingSizes[0];
  const h1Count = topSize ? allLines.filter((l) => isSizeHeading(l, st.body) && Math.round(l.size * 2) / 2 >= topSize / 1.06).length : 0;

  const counts = { headings: 0, bullets: 0, tables: 0 };
  const pageMd: string[] = [];
  regionLines.forEach((p, i) => {
    const parts = p.parts.map((lines) => lines.filter((l) => keep.has(l))).filter((lines) => lines.length);
    const md = parts.map((lines) => render(structure(lines, st), st, h1Count, counts)).filter(Boolean);
    if (md.length) pageMd.push(md.join('\n\n'));
    if (twoColumnPages.includes(i + 1)) {
      const [left, right] = pageRegions[i].regions.columns;
      const firstHead = (items: Item[]) => groupLines(items).find((l) => headingCandidate(l, st))?.text;
      const lh = firstHead(left);
      const rh = firstHead(right);
      warnings.push(
        `Page ${i + 1} has a two-column layout. It was read as the left column${lh ? ` (starting "${lh}")` : ''} and then the right column${rh ? ` (starting "${rh}")` : ''}. Check that the sections read in a sensible order.`,
      );
    }
  });

  if (ocrLayer) warnings.push("This PDF's text comes from a scanner's own text recognition (an invisible OCR layer). Check names, numbers and dates against the original.");
  if (scannedPages.length && scannedPages.length < raw.length) {
    warnings.push(`Page(s) ${scannedPages.join(', ')} have no text layer (scanned). Their content is not in the conversion; read them from the page images or the original file.`);
  }
  const links = raw.reduce((s, p) => s + p.links.length, 0);
  let markdown = pageMd.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  markdown = markdown ? `${markdown}\n` : '';
  return { markdown, pages: raw.length, pageChars, scannedPages, twoColumnPages, ocrLayer, ...counts, links, warnings };
}
