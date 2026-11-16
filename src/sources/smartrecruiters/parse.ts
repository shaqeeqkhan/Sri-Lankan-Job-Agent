/**
 * SmartRecruiters posting API (port of ThreatHire scrapers/smartrecruiters.py).
 *
 *   GET https://api.smartrecruiters.com/v1/companies/{id}/postings?country=lk&limit=100&offset={n}
 *   GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
 *
 * The `country` filter is the API's own (ISO code), so only Sri Lanka postings are listed.
 * Company ids are case-sensitive; a wrong one answers `totalFound: 0`, not 404.
 */
import { isSriLanka, str } from '../ats-common.ts';

export const API = 'https://api.smartrecruiters.com/v1/companies';
export const PAGE_SIZE = 100;
export const searchUrl = (company: string, offset = 0, limit = PAGE_SIZE, country: string | null = 'lk') =>
  `${API}/${encodeURIComponent(company)}/postings?${country ? `country=${country}&` : ''}limit=${limit}&offset=${offset}`;
export const detailUrl = (company: string, id: string) => `${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
export const postingUrl = (company: string, id: string) => `https://jobs.smartrecruiters.com/${company}/${id}`;

export interface SrLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
}
export interface SrPosting {
  id?: string | number;
  name?: string;
  releasedDate?: string;
  company?: { identifier?: string; name?: string };
  location?: SrLocation;
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { label?: string };
  active?: boolean;
  applyUrl?: string;
  postingUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
}
export interface SrSearch {
  totalFound?: number;
  content?: SrPosting[];
}

/** "Ho Chi Minh, , Vietnam" → "Ho Chi Minh, Vietnam". */
export function locationOf(p: SrPosting): string | null {
  const loc = p.location ?? {};
  const parts = str(loc.fullLocation) ? loc.fullLocation!.split(',') : [loc.city, loc.region, loc.country];
  const out = parts.map((s) => (s ?? '').trim()).filter(Boolean);
  return out.length ? out.join(', ') : null;
}

export function postingIsSriLanka(p: SrPosting): boolean {
  return isSriLanka({ country: p.location?.country, locations: [locationOf(p)] });
}

/** Role sections only; `companyDescription` is the same boilerplate on every posting. */
export function descriptionOf(d: SrPosting): string {
  const s = d.jobAd?.sections ?? {};
  const parts: string[] = [];
  for (const [label, key] of [['', 'jobDescription'], ['Qualifications', 'qualifications'], ['Additional Information', 'additionalInformation']] as const) {
    const text = s[key]?.text ?? '';
    if (text.trim()) parts.push(label ? `<h3>${label}</h3>${text}` : text);
  }
  return parts.join('');
}

export function mapPosting(companyId: string, company: string | null, p: SrPosting, d: SrPosting) {
  const id = String(p.id);
  const loc = p.location ?? {};
  return {
    title: str(d.name) ?? p.name,
    company: company ?? str(p.company?.name) ?? companyId,
    location: locationOf(p),
    category: str(p.department?.label) ?? str(p.function?.label),
    description: descriptionOf(d),
    posted_at: p.releasedDate ?? null,
    employment_type: p.typeOfEmployment?.label ?? null,
    remote: typeof loc.remote === 'boolean' ? loc.remote && !loc.hybrid : null,
    country_code: 'LK',
    apply_url: str(d.applyUrl) ?? str(d.postingUrl) ?? postingUrl(companyId, id),
  };
}
