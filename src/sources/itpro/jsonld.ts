/**
 * schema.org JobPosting → JobFields, shared by the S5 board adapters that publish JSON-LD
 * (itpro, dreamjobs). Structured values only: no text parsing here (PRD §7.2 rule 9).
 */
import { decodeEntities } from '../../jobs/extract.ts';
import type { JobFields } from '../../jobs/schema.ts';

type Json = any;

/** The first JobPosting anywhere in the page's JSON-LD blocks (handles arrays and @graph). */
export function findJobPosting(blocks: unknown[]): Json | null {
  const visit = (n: Json): Json | null => {
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n)) {
      for (const x of n) {
        const hit = visit(x);
        if (hit) return hit;
      }
      return null;
    }
    const t = n['@type'];
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return n;
    return n['@graph'] ? visit(n['@graph']) : null;
  };
  return visit(blocks);
}

/** "2026-11-29T23:59:59+1100" → "2026-11-29": the date the site wrote, whatever its offset. */
export function dateOnly(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Whole days from date a to date b (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function str(v: unknown, max = 300): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function places(loc: Json): Json[] {
  if (!loc) return [];
  return Array.isArray(loc) ? loc : [loc];
}

/** "Kandy" / "Colombo, Galle" from jobLocation addresses (locality, else region). */
export function postingLocation(ld: Json): string | null {
  const names: string[] = [];
  for (const p of places(ld?.jobLocation)) {
    const a = p?.address ?? {};
    const name = str(a.addressLocality, 100) ?? str(a.addressRegion, 100) ?? (typeof p?.name === 'string' ? str(p.name, 100) : null);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(', ').slice(0, 200) : null;
}

export function postingCountry(ld: Json): string | null {
  for (const p of places(ld?.jobLocation)) {
    const c = p?.address?.addressCountry;
    const v = typeof c === 'string' ? c : typeof c?.name === 'string' ? c.name : null;
    if (!v) continue;
    if (/^(lk|lka|sri\s*lanka)$/i.test(v.trim())) return 'LK';
    if (/^[a-z]{2}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  return null;
}

function money(n: unknown): string | null {
  const x = typeof n === 'number' ? n : typeof n === 'string' && /^\d+(\.\d+)?$/.test(n.trim()) ? Number(n) : NaN;
  return Number.isFinite(x) && x > 0 ? Math.round(x).toLocaleString('en-US') : null;
}

/** baseSalary → "LKR 100,000–150,000 per month", only when a currency and a figure are both given. */
export function postingSalary(ld: Json): string | null {
  const s = ld?.baseSalary;
  if (!s || typeof s !== 'object') return null;
  const cur = str(s.currency, 10);
  if (!cur) return null;
  const v = s.value;
  let figure: string | null = null;
  let unit: string | null = null;
  if (v && typeof v === 'object') {
    const lo = money(v.minValue);
    const hi = money(v.maxValue);
    const one = money(v.value);
    figure = lo && hi && lo !== hi ? `${lo}–${hi}` : (lo ?? hi ?? one);
    unit = str(v.unitText, 20);
  } else {
    figure = money(v);
  }
  if (!figure) return null;
  return `${cur.toUpperCase()} ${figure}${unit ? ` per ${unit.toLowerCase()}` : ''}`;
}

/** The structured JobFields a JobPosting carries. closing_date is validThrough as given. */
export function postingFields(ld: Json): Partial<JobFields> {
  const org = ld?.hiringOrganization;
  const employment = Array.isArray(ld?.employmentType) ? ld.employmentType.join(', ') : ld?.employmentType;
  const out: Partial<JobFields> = {
    title: str(ld?.title) ?? undefined,
    company: str(typeof org === 'string' ? org : org?.name, 200),
    location: postingLocation(ld),
    category: str(ld?.occupationalCategory, 100) ?? str(ld?.industry, 100),
    salary_text: postingSalary(ld),
    description: typeof ld?.description === 'string' && ld.description.trim() ? ld.description : null,
    closing_date: dateOnly(ld?.validThrough),
    posted_at: dateOnly(ld?.datePosted),
    employment_type: str(employment, 60),
    country_code: postingCountry(ld),
  };
  if (ld?.jobLocationType === 'TELECOMMUTE') out.remote = true;
  return out;
}
