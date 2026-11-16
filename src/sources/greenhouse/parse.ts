/**
 * Greenhouse job board API (port of ThreatHire scrapers/greenhouse.py).
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs          list, no descriptions
 *   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}     one posting with `content`
 *
 * Greenhouse has no country field. The location name decides, then the offices (detail only),
 * then a custom field named Location or Country.
 */
import { decodeEntities, isSriLanka, str } from '../ats-common.ts';

export const API = 'https://boards-api.greenhouse.io/v1/boards';
export const listUrl = (slug: string) => `${API}/${encodeURIComponent(slug)}/jobs`;
export const detailUrl = (slug: string, id: string) => `${API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}`;

export interface GhJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  first_published?: string;
  updated_at?: string;
  application_deadline?: string | null;
  company_name?: string;
  metadata?: { name?: string; value?: unknown }[] | null;
  content?: string;
  offices?: { name?: string; location?: string | null }[];
  departments?: { name?: string }[];
}

const COUNTRY_FIELD = /^(job |work )?(location|country)s?$/i;

function metadataLocations(j: GhJob): string[] {
  const out: string[] = [];
  for (const f of j.metadata ?? []) {
    if (!COUNTRY_FIELD.test(f.name ?? '')) continue;
    const vals = Array.isArray(f.value) ? f.value : [f.value];
    for (const v of vals) if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

/** Sri Lanka on the list entry: location name or a Location/Country custom field. */
export function listIsSriLanka(j: GhJob): boolean {
  return isSriLanka({ locations: [j.location?.name, ...metadataLocations(j)] });
}

/** The hosted Greenhouse page, not a custom-domain `absolute_url` (identity and recheck need it). */
export function applyUrl(slug: string, j: GhJob): string {
  const abs = j.absolute_url ?? '';
  if (abs.includes('greenhouse.io/') || j.id == null) return abs;
  return `https://boards.greenhouse.io/${slug}/jobs/${j.id}`;
}

export function mapJob(slug: string, company: string | null, list: GhJob, detail: GhJob) {
  const content = typeof detail.content === 'string' ? decodeEntities(detail.content) : null;
  const offices = (detail.offices ?? []).map((o) => o.location || o.name);
  return {
    title: str(detail.title) ?? str(list.title),
    company: company ?? str(detail.company_name) ?? str(list.company_name) ?? slug,
    location: str(list.location?.name) ?? str(offices[0]),
    category: str(detail.departments?.[0]?.name),
    description: content,
    // first_published is when it went up; updated_at is the last edit (a bulk edit re-dates a board).
    posted_at: list.first_published ?? list.updated_at ?? null,
    closing_date: list.application_deadline ?? detail.application_deadline ?? null,
    country_code: 'LK',
    apply_url: applyUrl(slug, list),
  };
}
