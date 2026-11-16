/**
 * The seams between S8 (match) and S2 (src/jobs/*). Match keeps districts lower-case ("colombo",
 * "nuwara eliya") internally; `places.ts` returns display names ("Colombo", "Nuwara Eliya"), which is
 * also what `jobs.district` stores. These thin wrappers convert, so match code compares like with like.
 */
import { requirementsExcerpt as excerpt } from '../jobs/clean.ts';
import { DISTRICTS as DISPLAY_DISTRICTS, nearbyDistricts as nearby, parsePlace } from '../jobs/places.ts';

export { colomboToday } from '../commands/jobs.ts';

export interface Place {
  district: string | null;
  slug: string | null;
  remote: boolean;
}

/** A district name or slug in match's form: lower-case, single spaces ("Nuwara-Eliya" → "nuwara eliya"). */
export function districtKey(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, ' ');
}

export const DISTRICTS: string[] = DISPLAY_DISTRICTS.map((d) => districtKey(d));

/** Location text → district (lower-case), identity slug and remote flag. Unknown text gives district null. */
export function placeOf(location: string | null | undefined): Place {
  const p = parsePlace(location);
  return { district: p.district ? districtKey(p.district) : null, slug: p.slug, remote: p.remote };
}

/** The districts that border this one (lower-case), not including itself. */
export function nearbyDistricts(district: string | null | undefined): string[] {
  if (!district) return [];
  return nearby(district).map((d) => districtKey(d));
}

/** The part of a job description an agent needs to score it, at most `max` characters. */
export function requirementsExcerpt(description: string | null | undefined, max = 1500): string {
  return excerpt(description, max);
}
