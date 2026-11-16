/**
 * Workday CxS parsing (port of ThreatHire scrapers/workday.py).
 *
 *   POST https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *        {"appliedFacets": {...}, "limit": 20, "offset": n, "searchText": ""}
 *   GET  https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
 *
 * Sri Lanka is found through the board's own location facets: the country facet
 * (`locationCountry` and tenant variants) carries a "Sri Lanka" value, whose id is applied as a
 * filter. Only when a board exposes no facets does the scan fall back to searching "Sri Lanka" and
 * filtering location text.
 */
import { isSriLanka, joinLocations, str, textIsSriLanka, type WorkdayBoard } from '../ats-common.ts';

export const PAGE_SIZE = 20; // CxS hard cap per page

export function baseUrl(b: WorkdayBoard): string {
  return `https://${b.tenant}.${b.wd}.myworkdayjobs.com`;
}
export function searchUrl(b: WorkdayBoard): string {
  return `${baseUrl(b)}/wday/cxs/${b.tenant}/${b.site}/jobs`;
}
export function detailUrl(b: WorkdayBoard, externalPath: string): string {
  return `${baseUrl(b)}/wday/cxs/${b.tenant}/${b.site}${externalPath}`;
}
export function postingUrl(b: WorkdayBoard, externalPath: string): string {
  return `${baseUrl(b)}/${b.site}${externalPath}`;
}

export function searchBody(appliedFacets: Record<string, string[]>, offset: number, searchText = ''): unknown {
  return { appliedFacets, limit: PAGE_SIZE, offset, searchText };
}

export interface WdPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
export interface WdSearch {
  total?: number;
  jobPostings?: WdPosting[];
  facets?: WdFacet[];
}
interface WdFacet {
  facetParameter?: string;
  descriptor?: string;
  id?: string;
  count?: number;
  values?: WdFacet[];
}

/**
 * The facet filter that selects Sri Lanka on this board, or null when the board has facets but
 * none for Sri Lanka (it has no Sri Lanka roles), or 'none' when the board exposes no location facets.
 * A country facet wins; otherwise every location value that names a Sri Lankan place.
 */
export function sriLankaFacet(search: WdSearch): { param: string; ids: string[]; count: number } | null | 'none' {
  const countryHits: { param: string; id: string; count: number }[] = [];
  const placeHits: { param: string; id: string; count: number }[] = [];
  let sawLocationFacet = false;
  const walk = (facets: WdFacet[] | undefined) => {
    for (const f of facets ?? []) {
      const param = f.facetParameter ?? '';
      if (/country|location/i.test(param)) sawLocationFacet = true;
      for (const v of f.values ?? []) {
        if (v.values) {
          walk([v]);
          continue;
        }
        if (!v.id || !v.descriptor) continue;
        if (/country/i.test(param) && /^\s*sri[-\s]?lanka\s*$/i.test(v.descriptor)) countryHits.push({ param, id: v.id, count: v.count ?? 0 });
        else if (/location/i.test(param) && textIsSriLanka(v.descriptor)) placeHits.push({ param, id: v.id, count: v.count ?? 0 });
      }
    }
  };
  walk(search.facets);
  const pick = (hits: { param: string; id: string; count: number }[]) => {
    const param = hits[0].param;
    const same = hits.filter((h) => h.param === param);
    return { param, ids: same.map((h) => h.id), count: same.reduce((n, h) => n + h.count, 0) };
  };
  if (countryHits.length) return pick(countryHits);
  if (placeHits.length) return pick(placeHits);
  return sawLocationFacet ? null : 'none';
}

const PLACEHOLDER_LOC = /^\s*(\d+\s+locations?|unknown|remote|)\s*$/i;
export function isPlaceholder(location: string | null | undefined): boolean {
  return PLACEHOLDER_LOC.test(location ?? '');
}

const POSTED_AGO = /(\d+)\+?\s+days?\s+ago/i;
/** "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → YYYY-MM-DD (approximate). */
export function postedOnDate(postedOn: string | undefined, now: Date): string | null {
  const t = (postedOn ?? '').toLowerCase();
  let days: number | null = null;
  if (t.includes('today')) days = 0;
  else if (t.includes('yesterday')) days = 1;
  else {
    const m = t.match(POSTED_AGO);
    if (m) days = Number(m[1]);
  }
  if (days === null) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The posting's own id from its path: `/job/Colombo-Sri-Lanka/Title_R0124493-1` → `R0124493-1`. */
export function postingId(externalPath: string): string {
  const last = externalPath.split('/').filter(Boolean).pop() ?? externalPath;
  const i = last.lastIndexOf('_');
  return i >= 0 && i < last.length - 1 ? last.slice(i + 1) : last;
}

export interface WdInfo {
  title?: string;
  jobDescription?: string;
  location?: string;
  additionalLocations?: string[];
  startDate?: string;
  endDate?: string;
  timeType?: string;
  remoteType?: string;
  externalUrl?: string;
  country?: { descriptor?: string; alpha2Code?: string };
  jobRequisitionLocation?: { descriptor?: string; country?: { descriptor?: string; alpha2Code?: string } };
}

export function detailLocations(info: WdInfo): string[] {
  return [info.location, ...(info.additionalLocations ?? [])].filter((s): s is string => !!str(s));
}

export function detailCountry(info: WdInfo): string | null {
  const c = info.jobRequisitionLocation?.country ?? info.country;
  return str(c?.alpha2Code) ?? str(c?.descriptor);
}

/** Fully remote only when the tenant says "Remote" (not "Remote/Hybrid", not "Flexible"). */
export function remoteOf(info: WdInfo): boolean | null {
  const r = str(info.remoteType);
  if (!r) return null;
  return /^\s*(fully\s+)?remote\s*$/i.test(r);
}

/** Map one search posting + its detail to job fields. */
export function mapPosting(b: WorkdayBoard, p: WdPosting, info: WdInfo, viaFacet: boolean) {
  const path = p.externalPath ?? '';
  const locs = detailLocations(info);
  const listed = str(p.locationsText);
  const location = joinLocations(locs.length && (isPlaceholder(listed) || !listed) ? locs : [listed, ...locs.filter((l) => l !== listed)]);
  const country = detailCountry(info);
  const sl = isSriLanka({ country, locations: [listed, ...locs] });
  if (!viaFacet && !sl) return null;
  return {
    title: str(info.title) ?? str(p.title),
    location,
    description: info.jobDescription ?? null,
    posted_at: info.startDate ?? null,
    closing_date: info.endDate ?? null,
    employment_type: info.timeType ?? null,
    remote: remoteOf(info),
    country_code: sl ? 'LK' : country,
    apply_url: str(info.externalUrl) ?? postingUrl(b, path),
  };
}

const WD_URL = /^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkday(?:jobs|site)\.com(?:\/[a-z]{2}-[A-Z]{2})?\/([^/?#]+)(\/job\/[^?#]+)/i;
/** A posting URL → its board coordinates and CxS path (prune_stale_jobs.py `_WD_RE`). */
/** The other public form, used by some tenants' own links (Sysco LABS): wdN.myworkdaysite.com/recruiting/<tenant>/<site>/job/... */
const WD_SITE_URL = /^https?:\/\/(wd\d+)\.myworkdaysite\.com(?:\/[a-z]{2}-[A-Z]{2})?\/recruiting\/([a-z0-9-]+)\/([^/?#]+)(\/job\/[^?#]+)/i;
export function parsePostingUrl(url: string): { tenant: string; wd: string; site: string; path: string } | null {
  const m = url.match(WD_URL);
  if (m) return { tenant: m[1].toLowerCase(), wd: m[2].toLowerCase(), site: m[3], path: m[4] };
  const s = url.match(WD_SITE_URL);
  return s ? { tenant: s[2].toLowerCase(), wd: s[1].toLowerCase(), site: s[3], path: s[4] } : null;
}
