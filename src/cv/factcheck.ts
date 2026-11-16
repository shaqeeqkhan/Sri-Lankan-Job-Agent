import fs from 'node:fs';
import YAML from 'yaml';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { loadFacts, readResume, type Fact } from '../user/profile.ts';
import { readCvMd, requireJob, sha16 } from './cvmd.ts';
import {
  ALIASES, ALLOWED_ACRONYMS, COMMON, EMPLOYER_HINTS, GRADE, INSTITUTION_HINTS, MONTHS, QUALIFICATIONS, STOP,
  TITLE_HINTS, TOOLS, VERBS, WORD_NUMBERS,
} from './lexicon.ts';

/**
 * `slj factcheck`: a deterministic fact gate for a tailored cv.md (PRD §5.5 step 5, §10).
 *
 * Every claim-shaped thing in cv.md (numbers, dates, percentages, amounts, phone, email, links,
 * capitalised entity phrases, known tools and qualifications, technology-shaped tokens, O/L and A/L
 * grades) must be found in the allowed corpus: user/resume.md, the confirmed facts in user/facts.yml
 * and the name in user/profile.yml. The job ad is never part of the corpus, so a tool copied from the
 * ad that the person never claimed fails.
 *
 * Honest rewording passes because only claims are compared, not sentences: verbs, word order and
 * merged bullets do not matter; the employers, titles, dates, numbers and tools inside them do.
 */

export type ClaimKind =
  | 'employer' | 'title' | 'institution' | 'entity' | 'tool' | 'qualification'
  | 'number' | 'percentage' | 'amount' | 'year' | 'date' | 'month_year' | 'date_range'
  | 'phone' | 'email' | 'url' | 'grade';

export interface Unsupported {
  line: number;
  kind: ClaimKind;
  claim: string;
  context: string;
  reason: string;
  /** The corpus line that shares the most words with this cv.md line, with where it came from. */
  nearest: { source: string; text: string } | null;
}

export interface CheckResult {
  claims_checked: number;
  unsupported: Unsupported[];
}

// ---------------------------------------------------------------- normalisation

function ascii(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function wordNumbers(s: string): string {
  return s.replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\b/gi, (w) => String(WORD_NUMBERS[w.toLowerCase()]));
}

/** Lower-case, ASCII, aliases applied, markdown and punctuation removed. `dots` decides "node.js" → "nodejs" or "node js". */
export function norm(s: string, dots: 'join' | 'split' = 'join'): string {
  let t = ` ${ascii(s).toLowerCase()} `;
  t = t.replace(/<[^>]+>/g, ' ').replace(/\]\([^)]*\)/g, ' ');
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  t = dots === 'join' ? t.replace(/(?<=[a-z0-9])\.(?=[a-z0-9])/g, '') : t.replace(/\./g, ' ');
  t = t.replace(/[^a-z0-9+#\s]/g, ' ').replace(/(?<![a-z0-9+])[+#]+|(?<=\s)#/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  const a = norm(s, 'join');
  return a ? a.split(' ') : [];
}

const content = (toks: string[]) => toks.filter((t) => !STOP.has(t));

// ---------------------------------------------------------------- numeric extraction

interface Numeric {
  emails: string[];
  urls: string[];
  phones: string[];
  dates: string[];
  yms: string[];
  years: number[];
  percents: number[];
  amounts: number[];
  numbers: number[];
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|lk|org|net|io|dev|me|edu|co|info|app)\b(?:\/[^\s)|,>\]]*)?/gi;
const NOT_URL = /^(asp|vb|ado)\.net$/i;
const PHONE = /(?:\+\s?94|(?<![\d])0)[\d \-()]{8,14}\d/g;
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_NUM = /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)\d{2})\b/g;
const DATE_ISO = /\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/g;
const DATE_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'gi');
const DATE_MDY = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`, 'gi');
const YM_WORD = new RegExp(`\\b${MONTH}\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'gi');
const YM_NUM = /\b(\d{1,2})[/.-]((?:19|20)\d{2})\b/g;
const PERCENT = /(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi;
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, lakh: 1e5, lakhs: 1e5, lac: 1e5 };
const AMOUNT = /(?:\b(?:rs|lkr|usd|slr)\b\.?|\$)\s?(\d[\d,]*(?:\.\d+)?)\s*(k|mn|m|million|bn|b|billion|lakhs?|lac|thousand)?\b/gi;
const NUM_MULT = /\b(\d[\d,]*(?:\.\d+)?)\s*(k|mn|million|bn|billion|lakhs?|lac|thousand)\b/gi;
const YEAR = /\b(19[5-9]\d|20[0-4]\d)\b/g;
const ORDINAL = /\b(\d+)(?:st|nd|rd|th)\b/gi;
const NUMBER = /(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?![\w])/g;

const pad = (n: number | string) => String(n).padStart(2, '0');
const monthNo = (m: string) => MONTHS[m.toLowerCase().replace(/\.$/, '')];
const num = (s: string) => Number(s.replace(/,/g, ''));

function normUrl(u: string): string {
  return u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/.]+$/, '');
}

export function extractNumeric(line: string): Numeric {
  const out: Numeric = { emails: [], urls: [], phones: [], dates: [], yms: [], years: [], percents: [], amounts: [], numbers: [] };
  let s = wordNumbers(ascii(line));
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    s = s.replace(re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      const m = Object.assign([...groups], { index: 0, input: '' }) as unknown as RegExpExecArray;
      fn(m);
      return ' ';
    });
  };
  take(EMAIL, (m) => out.emails.push(m[0].toLowerCase()));
  s = s.replace(URL, (u) => {
    if (NOT_URL.test(u)) return u;
    out.urls.push(normUrl(u));
    return ' ';
  });
  s = s.replace(PHONE, (p) => {
    const d = p.replace(/\D/g, '');
    if (d.length < 9 || d.length > 12) return p;
    out.phones.push(d.slice(-9));
    return ' ';
  });
  const date = (y: string | number, mo: number | undefined, d: string | number) => {
    if (!mo || mo > 12 || Number(d) < 1 || Number(d) > 31) return;
    out.dates.push(`${y}-${pad(mo)}-${pad(d)}`);
  };
  take(DATE_ISO, (m) => date(m[1], Number(m[2]), m[3]));
  take(DATE_NUM, (m) => date(m[3], Number(m[2]), m[1]));
  take(DATE_DMY, (m) => date(m[3], monthNo(m[2]), m[1]));
  take(DATE_MDY, (m) => date(m[3], monthNo(m[1]), m[2]));
  take(YM_WORD, (m) => out.yms.push(`${m[2]}-${pad(monthNo(m[1]))}`));
  take(YM_NUM, (m) => Number(m[1]) >= 1 && Number(m[1]) <= 12 && out.yms.push(`${m[2]}-${pad(m[1])}`));
  take(PERCENT, (m) => out.percents.push(Number(m[1])));
  take(AMOUNT, (m) => out.amounts.push(num(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1)));
  take(NUM_MULT, (m) => out.amounts.push(num(m[1]) * MULT[m[2].toLowerCase()]));
  take(YEAR, (m) => out.years.push(Number(m[1])));
  take(ORDINAL, (m) => out.numbers.push(Number(m[1])));
  take(NUMBER, (m) => {
    const n = num(m[1]);
    if (Number.isFinite(n)) out.numbers.push(n);
  });
  return out;
}

/** "12 branch managers" → [12, "branch"]: a count and the first word after it. */
const UNIT = /(?<![\w.,])(\d+(?:,\d{3})*(?:\.\d+)?)\s*\+?\s+([A-Za-z][A-Za-z-]*)(?:\s+([A-Za-z][A-Za-z-]*))?(?:\s+([A-Za-z][A-Za-z-]*))?/g;
const CURRENCY_BEFORE = /(?:\brs\.?|\blkr|\busd|\$)\s*$/i;
const stem = (w: string) => w.toLowerCase().replace(/(?<=..)(es|s)$/, '');
export function unitPairs(line: string): { n: number; w: string }[] {
  const out: { n: number; w: string }[] = [];
  const text = wordNumbers(ascii(line));
  for (const m of text.matchAll(UNIT)) {
    if (CURRENCY_BEFORE.test(text.slice(Math.max(0, m.index - 6), m.index))) continue; // an amount, checked as one
    const n = num(m[1]);
    if (n >= 1950 && n <= 2049 && !m[1].includes(',')) continue; // a year
    const w = [m[2], m[3]].find((x) => x && !STOP.has(x.toLowerCase()) && !(x.toLowerCase() in MONTHS));
    if (w) out.push({ n, w: stem(w) });
  }
  return out;
}

// ---------------------------------------------------------------- corpus

export interface CorpusLine {
  source: string;
  text: string;
  toks: string[];
}

export interface Corpus {
  lines: CorpusLine[];
  textJoin: string;
  textSplit: string;
  tokens: Set<string>;
  joined: Set<string>;
  bigrams: Set<string>;
  emails: Set<string>;
  urls: Set<string>;
  phones: Set<string>;
  dates: Set<string>;
  yms: Set<string>;
  years: Set<number>;
  percents: Set<number>;
  numbers: Set<number>;
  /** "n|word" for every count followed by a word, and the word after that. */
  units: Set<string>;
}

export function buildCorpus(docs: { source: string; text: string }[]): Corpus {
  const c: Corpus = {
    lines: [], textJoin: ' ', textSplit: ' ', tokens: new Set(), joined: new Set(), bigrams: new Set(),
    emails: new Set(), urls: new Set(), phones: new Set(), dates: new Set(), yms: new Set(), years: new Set(),
    percents: new Set(), numbers: new Set(), units: new Set(),
  };
  const textsJ: string[] = [];
  const textsS: string[] = [];
  for (const doc of docs) {
    doc.text.split(/\r?\n/).forEach((raw, i) => {
      if (!raw.trim()) return;
      const source = doc.source.includes(':') ? doc.source : `${doc.source}:${i + 1}`;
      for (const variant of ['join', 'split'] as const) {
        const toks = norm(raw, variant).split(' ').filter(Boolean);
        (variant === 'join' ? textsJ : textsS).push(toks.join(' '));
        toks.forEach((t) => c.tokens.add(t));
        for (let k = 0; k < toks.length; k++) {
          if (k + 1 < toks.length) c.joined.add(toks[k] + toks[k + 1]);
          if (k + 2 < toks.length) c.joined.add(toks[k] + toks[k + 1] + toks[k + 2]);
        }
        const ct = content(toks);
        // Word pairs, also skipping one word, so "Bachelor of Commerce (Special) in Accounting" supports
        // "Bachelor of Commerce in Accounting" but "Senior" + "Accountant" from different lines stays unsupported.
        for (let k = 0; k + 1 < ct.length; k++) {
          c.bigrams.add(`${ct[k]} ${ct[k + 1]}`);
          if (k + 2 < ct.length) c.bigrams.add(`${ct[k]} ${ct[k + 2]}`);
        }
        if (variant === 'join') c.lines.push({ source, text: raw.trim(), toks });
      }
      const n = extractNumeric(raw);
      n.emails.forEach((x) => c.emails.add(x));
      n.urls.forEach((x) => c.urls.add(x));
      n.phones.forEach((x) => c.phones.add(x));
      for (const d of n.dates) {
        c.dates.add(d);
        c.yms.add(d.slice(0, 7));
        const [y, m, day] = d.split('-').map(Number);
        c.years.add(y);
        c.numbers.add(m);
        c.numbers.add(day);
        c.numbers.add(y);
      }
      for (const ym of n.yms) {
        c.yms.add(ym);
        c.years.add(Number(ym.slice(0, 4)));
        c.numbers.add(Number(ym.slice(0, 4)));
      }
      n.years.forEach((y) => (c.years.add(y), c.numbers.add(y)));
      n.percents.forEach((p) => (c.percents.add(p), c.numbers.add(p)));
      n.amounts.forEach((a) => c.numbers.add(a));
      n.numbers.forEach((x) => c.numbers.add(x));
      for (const m of wordNumbers(ascii(raw)).matchAll(UNIT)) {
        for (const w of [m[2], m[3], m[4]]) if (w) c.units.add(`${num(m[1])}|${stem(w)}`);
      }
    });
  }
  c.textJoin = ` ${textsJ.join(' | ')} `;
  c.textSplit = ` ${textsS.join(' | ')} `;
  return c;
}

function hasPhrase(c: Corpus, phrase: string): boolean {
  const j = norm(phrase, 'join');
  const s = norm(phrase, 'split');
  if (!j) return true;
  if (c.textJoin.includes(` ${j} `) || c.textSplit.includes(` ${s} `)) return true;
  const squashed = j.replace(/ /g, '');
  return c.tokens.has(squashed) || c.joined.has(squashed);
}

function hasToken(c: Corpus, t: string): boolean {
  return c.tokens.has(t) || c.joined.has(t);
}

/** A capitalised phrase is supported when it appears as a phrase, or every word and every adjacent word pair does. */
function phraseSupported(c: Corpus, phrase: string): boolean {
  if (hasPhrase(c, phrase)) return true;
  // "Power BI and SQL": a list of things, each supported on its own.
  const parts = phrase.split(/\s+(?:and|&)\s+/i);
  if (parts.length > 1) return parts.every((p) => phraseSupported(c, p));
  const ct = content(tokens(phrase)).filter((t) => t.length > 1);
  if (!ct.length) return true;
  if (!ct.every((t) => hasToken(c, t))) return false;
  for (let k = 0; k + 1 < ct.length; k++) if (!c.bigrams.has(`${ct[k]} ${ct[k + 1]}`)) return false;
  return true;
}

function nearest(c: Corpus, context: string): Unsupported['nearest'] {
  const want = new Set(content(tokens(context)).filter((t) => t.length > 1));
  let best: CorpusLine | null = null;
  let bestScore = 0;
  for (const l of c.lines) {
    let score = 0;
    for (const t of new Set(l.toks)) if (want.has(t)) score++;
    if (score > bestScore || (score === bestScore && best && score > 0 && l.text.length < best.text.length)) {
      best = l;
      bestScore = score;
    }
  }
  return best && bestScore > 0 ? { source: best.source, text: best.text.slice(0, 200) } : null;
}

// ---------------------------------------------------------------- cv.md claims

interface Word {
  raw: string;
  start: boolean;
  /** Punctuation before this word ends any capitalised run. */
  brk: boolean;
}

const WORD = /[A-Za-z0-9][A-Za-z0-9.+#'’/-]*[A-Za-z0-9+#]|[A-Za-z0-9]/g;

function words(text: string, exemptStarts: boolean): Word[] {
  const out: Word[] = [];
  let m: RegExpExecArray | null;
  let prevEnd = 0;
  let prev = '';
  let first = true;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(text))) {
    const gap = text.slice(prevEnd, m.index);
    // "Mr. R. Fernando": the dot after an honorific or an initial does not end a sentence.
    const abbrev = /^\.\s*$/.test(gap) && (HONORIFIC.test(prev) || /^[A-Za-z]$/.test(prev));
    const start = exemptStarts && (first || (!abbrev && /[.!?:;•]\s*$|\s[-–—]\s*$|\(\s*$/.test(gap)));
    const brk = /[,;:|()\[\]—–]|\s-\s/.test(gap);
    out.push({ raw: m[0].replace(/[.'’]+$/, ''), start, brk });
    prevEnd = m.index + m[0].length;
    prev = m[0];
    first = false;
  }
  return out;
}

const CONNECT = new Set(['of', 'and', '&', 'for', 'the', 'de', 'in']);
const HONORIFIC = /^(mr|mrs|ms|miss|dr|prof|rev|hon|eng|no|st)$/i;
const isCap = (w: string) => /^[A-Z]/.test(w) || /^[a-z]+[A-Z]/.test(w);
const techShaped = (w: string) =>
  (/[a-z][A-Z]/.test(w) && !/^(Mc|Mac|De|Di|La|Le)[A-Z]/.test(w)) ||
  (/[A-Za-z]\d|\d[A-Za-z]/.test(w) && !/^\d+(st|nd|rd|th)$/i.test(w)) ||
  /\+\+$|[A-Za-z]#$/.test(w) ||
  /^[A-Za-z]+\.[A-Za-z]{2,}$/.test(w) ||
  /^[A-Z]{2,6}s?$/.test(w);

function verbish(w: string): boolean {
  const l = w.toLowerCase();
  if (VERBS.has(l) || (l.endsWith('s') && VERBS.has(l.slice(0, -1)))) return true;
  if (l.length > 4 && /(ed|ing|ly)$/.test(l)) return true;
  return /^[A-Z][a-z]+-[a-z]/.test(w);
}

function classify(phrase: string): ClaimKind {
  if (EMPLOYER_HINTS.test(phrase)) return 'employer';
  if (INSTITUTION_HINTS.test(phrase)) return 'institution';
  if (TITLE_HINTS.test(phrase)) return 'title';
  const n = ` ${norm(phrase)} `;
  if (QUALIFICATIONS.some((q) => n.includes(` ${norm(q)} `))) return 'qualification';
  if (TOOLS.some((t) => n.includes(` ${norm(t)} `))) return 'tool';
  return 'entity';
}

/** Capitalised runs ("University of Colombo", "Ceylon Analytics (Pvt) Ltd"). Sentence-initial verbs and adjectives are dropped. */
function runs(text: string, exemptStarts: boolean): string[] {
  const ws = words(text, exemptStarts);
  const out: string[] = [];
  let cur: Word[] = [];
  const flush = () => {
    while (cur.length && CONNECT.has(cur[cur.length - 1].raw.toLowerCase())) cur.pop();
    // A lone capitalised word that starts a sentence is just a capital letter ("Import hotel rate sheets ...").
    // Tools and qualifications in that position are still caught by the lexicon pass.
    const lone = cur.length === 1 && cur[0].start && !techShaped(cur[0].raw);
    if (cur.length && !lone) out.push(cur.map((w) => w.raw).join(' '));
    cur = [];
  };
  for (const w of ws) {
    if (w.brk) flush();
    const lw = w.raw.toLowerCase();
    const cap = (isCap(w.raw) || techShaped(w.raw)) && !(lw in MONTHS) && lw !== 'present';
    if (cap && w.start && cur.length === 0 && verbish(w.raw) && !techShaped(w.raw)) continue;
    if (cap && w.start && cur.length) flush();
    if (cap) cur.push(w);
    else if (cur.length && CONNECT.has(w.raw.toLowerCase())) cur.push(w);
    else flush();
  }
  flush();
  return out.filter((r) => {
    const ct = content(tokens(r)).filter((t) => t.length > 1 || /^[a-z]$/.test(t) === false);
    return ct.some((t) => !COMMON.has(t) && !/^\d+$/.test(t) && t.length > 1);
  });
}

function lexiconHits(normLine: string): { term: string; kind: ClaimKind }[] {
  const hits: { term: string; kind: ClaimKind }[] = [];
  const padded = ` ${normLine} `;
  for (const t of TOOLS) if (padded.includes(` ${norm(t)} `)) hits.push({ term: t, kind: 'tool' });
  for (const q of QUALIFICATIONS) if (padded.includes(` ${norm(q)} `)) hits.push({ term: q, kind: 'qualification' });
  // Drop a hit contained in a longer hit ("excel" inside "microsoft excel").
  return hits.filter((h) => !hits.some((o) => o !== h && o.term.length > h.term.length && ` ${norm(o.term)} `.includes(` ${norm(h.term)} `)));
}

/** In a corpus line containing the subject, the first grade after it must be this grade. */
function gradeSupported(c: Corpus, subject: string, grade: string): boolean {
  const st = tokens(subject);
  const g = grade.toLowerCase();
  if (!st.length) return true;
  for (const l of c.lines) {
    for (let i = 0; i + st.length <= l.toks.length; i++) {
      if (st.every((t, k) => l.toks[i + k] === t)) {
        const after = l.toks.slice(i + st.length, i + st.length + 5);
        const firstGrade = after.find((t) => GRADE.test(t));
        if (firstGrade === g) return true;
      }
    }
  }
  return false;
}

/** The years in an entry heading must sit within a few lines of that entry's employer or institution in the corpus. */
function entryYearsSupported(c: Corpus, anchor: string, years: number[]): boolean {
  const a = ` ${norm(anchor)} `;
  for (let i = 0; i < c.lines.length; i++) {
    if (!` ${c.lines[i].toks.join(' ')} `.includes(a)) continue;
    const win = c.lines.slice(Math.max(0, i - 2), i + 4).filter((l) => l.source.split(':')[0] === c.lines[i].source.split(':')[0]);
    const ys = new Set<number>();
    for (const l of win) {
      const n = extractNumeric(l.text);
      n.years.forEach((y) => ys.add(y));
      n.yms.forEach((ym) => ys.add(Number(ym.slice(0, 4))));
      n.dates.forEach((d) => ys.add(Number(d.slice(0, 4))));
    }
    if (years.every((y) => ys.has(y))) return true;
  }
  return false;
}

export interface CheckOptions {
  watermarkText?: string;
  /** Job title and company: allowed only inside an Objective section ("seeking the Data Analyst role at X"). */
  target?: { title?: string | null; company?: string | null };
}

const SKIP_FRONT_KEYS = new Set(['role', 'style']);

export function checkCv(cvText: string, corpus: Corpus, opts: CheckOptions = {}): CheckResult {
  const unsupported: Unsupported[] = [];
  const seen = new Set<string>();
  let checked = 0;
  const mark = opts.watermarkText ? norm(opts.watermarkText) : null;
  const target = buildCorpus([
    { source: 'job:title', text: opts.target?.title ?? '' },
    { source: 'job:company', text: opts.target?.company ?? '' },
  ]);

  const lines = cvText.split(/\r?\n/);
  let inFront = lines[0]?.trim() === '---';
  let section = '';
  let inComment = false;
  let tableHeaderNext = false;

  const report = (line: number, kind: ClaimKind, claim: string, context: string, reason: string) => {
    const key = `${line}|${kind}|${claim.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    unsupported.push({ line, kind, claim, context: context.trim().slice(0, 200), reason, nearest: nearest(corpus, context) });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let raw = lines[i];
    if (i === 0 && inFront) continue;
    if (inFront) {
      if (raw.trim() === '---') {
        inFront = false;
        continue;
      }
      const key = /^\s*([A-Za-z_]+)\s*:/.exec(raw)?.[1];
      if (key && SKIP_FRONT_KEYS.has(key)) continue;
    }
    if (inComment) {
      if (raw.includes('-->')) inComment = false;
      continue;
    }
    raw = raw.replace(/<!--.*?-->/g, '');
    if (raw.includes('<!--')) {
      inComment = true;
      raw = raw.slice(0, raw.indexOf('<!--'));
    }
    if (!raw.trim()) {
      tableHeaderNext = false;
      continue;
    }
    if (/slj-mark/.test(raw) || (mark && norm(raw).includes(mark))) continue;

    // Structure
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(raw);
    const level = heading ? heading[1].length : 0;
    let text = heading ? heading[2] : raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, '');
    text = text.replace(/<[^>]+>/g, ' ').replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2').replace(/[*_`~]/g, '');
    if (level === 2) section = text;
    const isTable = /^\s*\|/.test(raw);
    if (isTable && /^\s*\|?\s*:?-{2,}/.test(raw)) continue;
    if (isTable && !tableHeaderNext && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      tableHeaderNext = true;
      continue; // header row: labels, not claims
    }
    const inObjective = /objective|career goal|career aim/i.test(section);
    const ok = (fn: (c: Corpus) => boolean) => fn(corpus) || (inObjective && fn(target));

    // Label: value → only the value is a claim. Front matter lines are key: value too.
    const label = /^([A-Za-z][A-Za-z ./()'-]{0,40}?)\s*:\s+(.*)$/.exec(text);
    if (label && label[1].trim().split(/\s+/).length <= 5) text = label[2];

    const cells = isTable ? text.split('|').map((x) => x.trim()).filter(Boolean) : [text];
    const exempt = !isTable && level === 0;

    // Numbers, dates, contact details.
    const n = extractNumeric(text);
    for (const e of n.emails) (checked++, !ok((c) => c.emails.has(e)) && report(lineNo, 'email', e, raw, 'email address not in resume.md'));
    for (const u of n.urls) (checked++, !ok((c) => c.urls.has(u)) && report(lineNo, 'url', u, raw, 'link not in resume.md'));
    for (const p of n.phones) (checked++, !ok((c) => c.phones.has(p)) && report(lineNo, 'phone', p, raw, 'phone number not in resume.md'));
    for (const d of n.dates) (checked++, !ok((c) => c.dates.has(d)) && report(lineNo, 'date', d, raw, 'date not in resume.md or facts.yml'));
    for (const ym of n.yms) (checked++, !ok((c) => c.yms.has(ym)) && report(lineNo, 'month_year', ym, raw, 'month and year not in resume.md or facts.yml'));
    for (const y of n.years) (checked++, !ok((c) => c.years.has(y)) && report(lineNo, 'year', String(y), raw, 'year not in resume.md or facts.yml'));
    for (const p of n.percents) (checked++, !ok((c) => c.percents.has(p)) && report(lineNo, 'percentage', `${p}%`, raw, 'percentage not in resume.md or facts.yml'));
    for (const a of n.amounts) (checked++, !ok((c) => c.numbers.has(a)) && report(lineNo, 'amount', String(a), raw, 'amount not in resume.md or facts.yml'));
    for (const x of n.numbers) {
      if (x <= 1) continue;
      checked++;
      if (!ok((c) => c.numbers.has(x))) report(lineNo, 'number', String(x), raw, 'number not in resume.md or facts.yml');
    }
    // A number that exists, but counting something else ("5 client brands" is not "5 years").
    for (const u of unitPairs(text)) {
      if (u.n <= 1 || !ok((c) => c.numbers.has(u.n))) continue;
      checked++;
      if (!ok((c) => c.units.has(`${u.n}|${u.w}`))) {
        report(lineNo, 'number', `${u.n} ${u.w}`, raw, `${u.n} is in resume.md or facts.yml, but not as "${u.n} ${u.w}..."`);
      }
    }

    // Entry headings: the years must belong to that entry, not to another job.
    const years = [...n.years, ...n.yms.map((y) => Number(y.slice(0, 4))), ...n.dates.map((d) => Number(d.slice(0, 4)))];
    if (level >= 3 && years.length) {
      const anchors = runs(text.replace(/\|[^|]*$/, ''), false).filter((r) => phraseSupported(corpus, r));
      const anchor = anchors.sort((a, b) => b.length - a.length)[0];
      if (anchor) {
        checked++;
        if (!entryYearsSupported(corpus, anchor, years)) {
          report(lineNo, 'date_range', `${anchor}: ${[...new Set(years)].join('–')}`, raw, `these years are not next to "${anchor}" in resume.md or facts.yml`);
        }
      }
    }

    if (level === 1 || level === 2) {
      if (level === 1) {
        for (const r of runs(text, false)) (checked++, !ok((c) => phraseSupported(c, r)) && report(lineNo, 'entity', r, raw, 'name not in resume.md'));
      }
      continue; // section names are not claims
    }

    // Grades in result tables.
    if (isTable && cells.length >= 2) {
      const gradeIdx = cells.findIndex((x) => GRADE.test(x));
      const subject = cells.find((x, k) => k !== gradeIdx && /[A-Za-z]{3,}/.test(x) && !GRADE.test(x));
      if (gradeIdx >= 0 && subject) {
        checked++;
        if (!gradeSupported(corpus, subject, cells[gradeIdx])) {
          report(lineNo, 'grade', `${subject}: ${cells[gradeIdx]}`, raw, 'this grade for this subject is not in resume.md or facts.yml');
        }
      }
    }

    // Entities: capitalised runs, then known tools/qualifications, then technology-shaped tokens.
    const badRuns: string[] = [];
    for (const cell of cells) {
      for (const r of runs(cell, exempt)) {
        checked++;
        if (!ok((c) => phraseSupported(c, r))) {
          badRuns.push(r.toLowerCase());
          report(lineNo, classify(r), r, raw, 'not in resume.md or facts.yml');
        }
      }
    }
    const nl = norm(text);
    for (const h of lexiconHits(nl)) {
      checked++;
      if (!ok((c) => hasPhrase(c, h.term))) {
        if (badRuns.some((b) => ` ${norm(b)} `.includes(` ${norm(h.term)} `))) continue;
        report(lineNo, h.kind, h.term, raw, `${h.kind === 'tool' ? 'tool' : 'qualification'} not in resume.md or facts.yml (the job ad does not count)`);
      }
    }
    for (const w of words(text, false)) {
      if (!techShaped(w.raw)) continue;
      const t = norm(w.raw);
      if (!t || COMMON.has(t) || ALLOWED_ACRONYMS.has(t) || STOP.has(t)) continue;
      if (/^\d/.test(t)) continue;
      checked++;
      if (!ok((c) => hasPhrase(c, w.raw))) {
        if (badRuns.some((b) => ` ${norm(b)} `.includes(` ${t} `))) continue;
        report(lineNo, 'tool', w.raw, raw, 'not in resume.md or facts.yml (the job ad does not count)');
      }
    }
  }
  return { claims_checked: checked, unsupported };
}

// ---------------------------------------------------------------- the command's work

export interface FactcheckReport {
  job_id: string;
  passed: boolean;
  cv_md: string;
  cv_hash: string;
  corpus_hash: string;
  claims_checked: number;
  unsupported: Unsupported[];
  sources: { resume: string; facts: number };
}

function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** sha of resume.md + facts.yml: a factcheck result is only valid while both are unchanged. */
export function corpusHash(ctx: Pick<Context, 'paths'>): string {
  return sha16(`${readOptional(ctx.paths.resumeFile)}\n--facts.yml--\n${readOptional(ctx.paths.factsFile)}`);
}

function profileName(ctx: Pick<Context, 'paths'>): string | null {
  try {
    const p = YAML.parse(readOptional(ctx.paths.profileFile)) as { name?: { value?: unknown } } | null;
    return typeof p?.name?.value === 'string' ? p.name.value : null;
  } catch {
    return null;
  }
}

export function corpusFor(ctx: Pick<Context, 'paths'>, facts: Fact[] = loadFacts(ctx)): Corpus {
  const docs = [{ source: 'resume.md', text: readResume(ctx) }];
  for (const f of facts) docs.push({ source: `facts.yml:${f.id}`, text: f.text });
  const name = profileName(ctx);
  if (name) docs.push({ source: 'profile.yml:name', text: name });
  return buildCorpus(docs);
}

export function runFactcheck(ctx: Context, jobId: string): FactcheckReport {
  const job = requireJob(ctx, jobId);
  const { file, text } = readCvMd(ctx, jobId);
  const facts = loadFacts(ctx);
  const corpus = corpusFor(ctx, facts);
  const settings = ctx.config().settings;
  const res = checkCv(text, corpus, { watermarkText: settings.cv.watermark.text, target: { title: job.title, company: job.company } });
  const report: FactcheckReport = {
    job_id: jobId,
    passed: res.unsupported.length === 0,
    cv_md: file,
    cv_hash: sha16(text),
    corpus_hash: corpusHash(ctx),
    claims_checked: res.claims_checked,
    unsupported: res.unsupported,
    sources: { resume: ctx.paths.resumeFile, facts: facts.length },
  };
  ctx
    .db()
    .prepare('INSERT INTO cv_factchecks (job_id, cv_hash, corpus_hash, passed, unsupported_json, checked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobId, report.cv_hash, report.corpus_hash, report.passed ? 1 : 0, JSON.stringify(report.unsupported), ctx.now().toISOString());
  return report;
}

/** Throws FACTCHECK_FAILED unless the latest factcheck for this job passed for these exact cv.md, resume.md and facts.yml bytes. */
export function requirePassedFactcheck(ctx: Context, jobId: string, cvText: string): void {
  const row = ctx
    .db()
    .prepare('SELECT cv_hash, corpus_hash, passed, unsupported_json FROM cv_factchecks WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId) as { cv_hash: string; corpus_hash: string; passed: number; unsupported_json: string } | undefined;
  const why =
    !row ? 'factcheck has not been run for this job'
    : row.cv_hash !== sha16(cvText) ? 'cv.md changed after the last factcheck'
    : row.corpus_hash !== corpusHash(ctx) ? 'resume.md or facts.yml changed after the last factcheck'
    : !row.passed ? 'the last factcheck failed'
    : null;
  if (why) {
    throw new SljError('FACTCHECK_FAILED', `Not rendering: ${why}. Run \`slj factcheck --job ${jobId}\`, fix every unsupported claim, and run it again.`, {
      job_id: jobId,
      reason: why,
      ...(row && !row.passed ? { unsupported: JSON.parse(row.unsupported_json) } : {}),
    });
  }
}
