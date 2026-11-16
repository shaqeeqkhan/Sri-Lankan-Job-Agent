/**
 * Lever postings API (port of ThreatHire scrapers/lever.py).
 *
 *   GET https://api.lever.co/v0/postings/{slug}?mode=json&skip={n}&limit={k}
 *
 * One call carries everything, descriptions included. Lever publishes the posting's ISO country
 * (`country`, e.g. "LK") and its work arrangement (`workplaceType`).
 */
import { isSriLanka, joinLocations, str } from '../ats-common.ts';

export const PAGE_SIZE = 100;
export const listUrl = (slug: string, skip = 0, limit = PAGE_SIZE) =>
  `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&skip=${skip}&limit=${limit}`;

export interface LvPosting {
  id?: string;
  text?: string;
  country?: string | null;
  workplaceType?: string;
  createdAt?: number;
  hostedUrl?: string;
  applyUrl?: string;
  categories?: { location?: string; allLocations?: string[]; team?: string; department?: string; commitment?: string };
  description?: string;
  lists?: { text?: string; content?: string }[];
  additional?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null;
}

export function locationsOf(p: LvPosting): string[] {
  const c = p.categories ?? {};
  return [c.location, ...(c.allLocations ?? [])].filter((s): s is string => !!str(s));
}

export function postingIsSriLanka(p: LvPosting): boolean {
  return isSriLanka({ country: p.country, locations: locationsOf(p) });
}

/** description + tagged lists + additional: Lever splits the body across all three. */
export function descriptionOf(p: LvPosting): string {
  const parts: string[] = [];
  if (p.description) parts.push(p.description);
  for (const l of p.lists ?? []) {
    if (l.text) parts.push(`<h3>${l.text}</h3>`);
    if (l.content) parts.push(`<ul>${l.content}</ul>`);
  }
  if (p.additional) parts.push(p.additional);
  return parts.join('');
}

/** Salary only when Lever publishes a structured range with a currency. */
export function salaryOf(p: LvPosting): string | null {
  const s = p.salaryRange;
  if (!s || !s.currency || (s.min == null && s.max == null)) return null;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const range = s.min != null && s.max != null && s.min !== s.max ? `${fmt(s.min)}–${fmt(s.max)}` : fmt((s.min ?? s.max)!);
  const per = s.interval ? ` ${s.interval.replace(/-/g, ' ')}` : '';
  return `${s.currency} ${range}${per}`;
}

export function mapPosting(slug: string, company: string | null, p: LvPosting) {
  const w = (p.workplaceType ?? '').toLowerCase();
  return {
    title: p.text,
    company: company ?? slug,
    location: joinLocations(locationsOf(p)),
    category: str(p.categories?.team) ?? str(p.categories?.department),
    salary_text: salaryOf(p),
    description: descriptionOf(p),
    posted_at: p.createdAt ?? null,
    employment_type: p.categories?.commitment ?? null,
    remote: w === 'remote' ? true : w === 'hybrid' || w === 'onsite' ? false : null,
    country_code: 'LK',
    apply_url: p.hostedUrl ?? p.applyUrl ?? null,
  };
}
