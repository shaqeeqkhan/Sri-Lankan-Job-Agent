/**
 * Ashby posting API (port of ThreatHire scrapers/ashby.py).
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
 *
 * One call returns every listed job with its HTML description. The structured address carries the
 * primary location's country; secondary locations carry their own.
 */
import { isSriLanka, joinLocations, str } from '../ats-common.ts';

export const listUrl = (org: string) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`;

interface Address {
  postalAddress?: { addressCountry?: string; addressLocality?: string; addressRegion?: string };
}
export interface AbJob {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: { location?: string; address?: Address }[];
  address?: Address;
  department?: string;
  team?: string;
  employmentType?: string;
  workplaceType?: string;
  isRemote?: boolean;
  isListed?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string } | null;
}

export function locationsOf(j: AbJob): string[] {
  return [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter((s): s is string => !!str(s));
}

/** Sri Lanka: primary address country, else any secondary address country, else the location text. */
export function jobIsSriLanka(j: AbJob): boolean {
  if (j.isListed === false) return false;
  const primary = j.address?.postalAddress?.addressCountry;
  if (isSriLanka({ country: primary, locations: locationsOf(j) })) return true;
  return (j.secondaryLocations ?? []).some((s) => isSriLanka({ country: s.address?.postalAddress?.addressCountry, locations: [s.location] }));
}

/** Fully remote from `workplaceType`; `isRemote` is also true for hybrid roles, so it is only a fallback. */
export function remoteOf(j: AbJob): boolean | null {
  const w = (j.workplaceType ?? '').trim().toLowerCase();
  if (w) return w === 'remote';
  return typeof j.isRemote === 'boolean' ? j.isRemote : null;
}

const EMPLOYMENT: Record<string, string> = { FullTime: 'Full time', PartTime: 'Part time', Intern: 'Internship', Contract: 'Contract', Temporary: 'Temporary' };

export function mapJob(org: string, company: string | null, j: AbJob) {
  return {
    title: j.title,
    company: company ?? org,
    location: joinLocations(locationsOf(j)),
    category: str(j.department) ?? str(j.team),
    salary_text: str(j.compensation?.scrapeableCompensationSalarySummary) ?? str(j.compensation?.compensationTierSummary),
    description: j.descriptionHtml ?? null,
    posted_at: j.publishedAt ?? null,
    employment_type: j.employmentType ? EMPLOYMENT[j.employmentType] ?? j.employmentType : null,
    remote: remoteOf(j),
    country_code: 'LK',
    apply_url: j.jobUrl ?? j.applyUrl ?? null,
  };
}
