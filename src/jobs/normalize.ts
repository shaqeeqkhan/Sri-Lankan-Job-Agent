import crypto from 'node:crypto';
import type { ApplyMethod, JobFields } from './schema.ts';

export function normText(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const COMPANY_SUFFIX =
  /\b(\(?pvt\.?\)?|\(?private\)?|ltd\.?|limited|plc|inc\.?|llc|co\.?|company|corporation|corp\.?|holdings)\s*$/i;

export function normCompany(s: string | null | undefined): string {
  let out = normText(s);
  for (let i = 0; i < 4; i++) {
    const next = out.replace(COMPANY_SUFFIX, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_[a-z]+|ref|ref_src|igshid|si)$/i;

export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return null;
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse the date formats Sri Lankan ads use. Numeric dates are read day-first
 * (05/11/2026 is 5 November), which is the local convention.
 *
 * Rule 11 (a wrong value is worse than a missing one): a numeric date with no year ("03/04") is
 * ambiguous and becomes null. A written date with no year ("5th November") is read only when `now`
 * is given, as the next such date from 30 days before `now`, and only if that falls within six
 * months of `now`; otherwise (and without `now`) it is null.
 */
export function parseDate(raw: string | null | undefined, opts: { now?: Date } = {}): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})\b/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})(?: of)? ([a-z]{3,9})\.? (\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3)]) return iso(+m[3], MONTHS[m[2].slice(0, 3)], +m[1]);
  m = s.match(/^([a-z]{3,9})\.? (\d{1,2}) (\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3)]) return iso(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]);
  if (!opts.now) return null;
  let day: number | undefined;
  let month: number | undefined;
  m = s.match(/^(\d{1,2})(?: of)? ([a-z]{3,9})\.?(?:\s|$)/);
  if (m && MONTHS[m[2].slice(0, 3)]) [day, month] = [+m[1], MONTHS[m[2].slice(0, 3)]];
  m = s.match(/^([a-z]{3,9})\.? (\d{1,2})(?:\s|$)/);
  if (!day && m && MONTHS[m[1].slice(0, 3)]) [day, month] = [+m[2], MONTHS[m[1].slice(0, 3)]];
  if (!day || !month) return null;
  const floor = new Date(opts.now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const ceiling = new Date(opts.now.getTime() + 183 * 86_400_000).toISOString().slice(0, 10);
  const y = opts.now.getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) {
    const d = iso(year, month, day);
    // Only a date within a month before to six months after `now` is a safe reading.
    if (d && d >= floor) return d <= ceiling ? d : null;
  }
  return null;
}

// ---------------------------------------------------------------- salary

export interface Salary {
  currency: 'LKR' | 'USD';
  min: number;
  max: number;
  period: 'month' | 'year' | 'day' | 'hour' | null;
  /** Normalised for display, e.g. "LKR 90,000–110,000 per month". */
  text: string;
}

const CUR = String.raw`(rs\.?|lkr|රු\.?|usd|us\s?\$)`;
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|mn|million|m)?(?![\d,])`;
const SALARY_RE = new RegExp(
  String.raw`${CUR}\s*${NUM}(?:\s*/-)?(?:\s*(?:-|–|—|to)\s*(?:${CUR}\s*)?${NUM}(?:\s*/-)?)?(?:\s*(?:per|a|/)\s*(month|mon|year|annum|yr|day|hour|hr)\b)?`,
  'gi',
);

function amount(num: string, unit: string | undefined): number {
  const n = Number(num.replace(/,/g, ''));
  const u = (unit ?? '').toLowerCase();
  if (u === 'k') return n * 1000;
  if (u === 'mn' || u === 'million' || u === 'm') return n * 1_000_000;
  return n;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function salaryFrom(m: RegExpMatchArray): Salary | null {
  const curA = m[1].toLowerCase();
  const currency = /usd|\$/.test(curA) ? 'USD' : 'LKR';
  if (m[4] && /usd|\$/.test(m[4].toLowerCase()) !== (currency === 'USD')) return null;
  // A bare decimal without a unit ("Rs. 1.5") is not a salary figure.
  if (!m[3] && m[2].includes('.')) return null;
  const min = amount(m[2], m[3]);
  const max = m[5] ? amount(m[5], m[6] ?? m[3]) : min;
  if (!(min > 0) || max < min) return null;
  const p = (m[7] ?? '').toLowerCase();
  const period = /^(month|mon)$/.test(p) ? 'month' : /^(year|annum|yr)$/.test(p) ? 'year' : p === 'day' ? 'day' : /^(hour|hr)$/.test(p) ? 'hour' : null;
  // Implausible figures for a monthly LKR wage are left out rather than guessed.
  if (currency === 'LKR' && (period === null || period === 'month') && (min < 5_000 || max > 10_000_000)) return null;
  const text = `${currency} ${fmt(min)}${max !== min ? `–${fmt(max)}` : ''}${period ? ` per ${period}` : ''}`;
  return { currency, min, max, period, text };
}

/**
 * A salary, only when the currency and the figure are unambiguous ("Rs. 85,000/-", "LKR 90k–110k",
 * "Rs 75,000 - 95,000 per month"). "Negotiable", a bare number, or two different salaries in the
 * same text give null (rule 11).
 */
export function parseSalary(raw: string | null | undefined): Salary | null {
  if (!raw) return null;
  const found = new Map<string, Salary>();
  for (const m of raw.matchAll(SALARY_RE)) {
    const s = salaryFrom(m);
    if (s) found.set(`${s.currency}|${s.min}|${s.max}`, s);
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// ---------------------------------------------------------------- rule 9

/**
 * Rule 9: a structured value from the source (JSON-LD, an ATS field) always wins. Parsed values
 * only fill the keys the structured side left null, undefined or empty.
 */
export function fillNulls<T extends Record<string, unknown>>(structured: T, parsed: Partial<T>): T {
  const out: Record<string, unknown> = { ...structured };
  for (const [k, v] of Object.entries(parsed)) {
    const cur = out[k];
    if ((cur == null || cur === '') && v != null && v !== '') out[k] = v;
  }
  return out as T;
}

/** Fill in apply_method when the source did not say. */
export function inferApplyMethod(f: Pick<JobFields, 'apply_method' | 'apply_email' | 'apply_url' | 'apply_phone'>, isPortal: boolean): ApplyMethod {
  if (f.apply_method) return f.apply_method;
  if (f.apply_email) return 'email';
  if (isPortal && f.apply_url) return 'portal';
  if (f.apply_url) return 'form';
  if (f.apply_phone) return 'phone';
  return 'unknown';
}

/**
 * Dedupe key across sources: the same role at the same company is one job.
 * When the company is unknown (common in social posts) the contact point stands in for it.
 */
export function jobHash(f: Pick<JobFields, 'title' | 'company' | 'apply_email' | 'apply_phone'>, fallback = ''): string {
  const company = normCompany(f.company);
  const contact = company ? '' : normText(f.apply_email ?? f.apply_phone ?? fallback);
  return crypto.createHash('sha256').update(`${normText(f.title)}|${company}|${contact}`).digest('hex');
}

export function shortId(seed: string): string {
  return `j${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 11)}`;
}
