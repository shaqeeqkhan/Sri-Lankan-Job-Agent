/** `slj profile check`: validates user/profile.yml and says, in one line, what was assumed. */
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { loadProfile, type Profile } from '../user/profile.ts';

export interface ProfileCheck {
  valid: boolean;
  path: string;
  problems: string[];
  /** Soft issues: the profile validates but matching will be weaker. */
  warnings: string[];
  /** The "I've assumed…" line to say to the person. Null when the profile is invalid. */
  summary: string | null;
  inferred_fields: string[];
  confirmed_fields: string[];
}

const orList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

const WORK_MODE: Record<Profile['work_mode']['value'], string> = {
  any: 'onsite, hybrid or remote',
  onsite: 'onsite',
  hybrid: 'hybrid OK',
  remote: 'remote work',
};

const SENIORITY: Record<Profile['seniority']['value'], string> = {
  intern: 'an internship',
  junior: 'junior',
  mid: 'mid-level',
  senior: 'senior',
  lead: 'lead',
  manager: 'manager-level',
  executive: 'executive-level',
};

export function assumptionLine(p: Profile): string {
  const titles = p.target_titles.value;
  const level = p.seniority.value;
  const hasLevel = titles.some((t) => new RegExp(`\\b(${level}|jr|sr|intern|trainee|head|chief|director)\\b`, 'i').test(t));
  const what = level === 'intern' && !hasLevel ? `${orList(titles)} internships` : `${!hasLevel && level !== 'mid' ? `${SENIORITY[level]} ` : ''}${orList(titles)} roles`;
  let where = '';
  const others = p.districts_ok.value.filter((d) => d.toLowerCase() !== (p.location.value ?? '').toLowerCase());
  if (p.location.value) where = ` in ${p.location.value}${others.length ? ` (or ${andList(others)})` : ''}`;
  else if (others.length) where = ` in ${andList(others)}`;
  const mode = p.work_mode.value === 'remote' ? ', remote' : `, ${WORK_MODE[p.work_mode.value]}`;
  const years = p.years_experience.value;
  const exp = years === null ? '' : years === 0 ? ', as a fresher' : `, with about ${years} year${years === 1 ? '' : 's'} of experience`;
  const also = p.adjacent_titles.value.length ? ` I'll also look at ${orList(p.adjacent_titles.value.slice(0, 3))}.` : '';
  const salary = p.salary_floor?.value ? ` Pay of at least Rs. ${p.salary_floor.value.toLocaleString('en-US')} a month.` : '';
  return `I've assumed you're looking for ${what}${where}${mode}${exp}.${also}${salary} Say "change" to fix any of that.`;
}

export function checkProfile(ctx: Context): ProfileCheck {
  const base = { path: ctx.paths.profileFile, warnings: [] as string[], inferred_fields: [] as string[], confirmed_fields: [] as string[] };
  let profile: Profile;
  try {
    profile = loadProfile(ctx);
  } catch (err) {
    // Missing files stay errors (the agent has a step to do); an invalid file is reported as data.
    const details = err instanceof SljError ? (err.details as { problems?: string[] } | undefined) : undefined;
    if (err instanceof SljError && err.code === 'NO_PROFILE' && (details?.problems || /not valid YAML/.test(err.message))) {
      return { ...base, valid: false, problems: details?.problems ?? [err.message], summary: null };
    }
    throw err;
  }
  const warnings: string[] = [];
  const entries = Object.entries(profile) as [string, { value: unknown; inferred: boolean } | undefined][];
  const inferred = entries.filter(([, f]) => f?.inferred).map(([k]) => k);
  const confirmed = entries.filter(([, f]) => f && !f.inferred).map(([k]) => k);
  if (profile.skills.value.length < 3) warnings.push('Fewer than 3 skills listed: matching leans on skills, so add the ones the CV shows.');
  if (!profile.location.value && !profile.districts_ok.value.length && profile.work_mode.value !== 'remote') {
    warnings.push('No location or districts: every district will count as a fit.');
  }
  if (!profile.adjacent_titles.value.length) warnings.push('No adjacent titles: the search will only use the target titles.');
  if (profile.years_experience.value === null && !['intern', 'junior'].includes(profile.seniority.value)) {
    warnings.push('Years of experience is unknown; seniority alone will be used.');
  }
  if (/^(your name|name|unknown|n\/a|candidate)$/i.test(profile.name.value)) warnings.push('The name looks like a placeholder.');
  return {
    ...base,
    valid: true,
    problems: [],
    warnings,
    summary: assumptionLine(profile),
    inferred_fields: inferred,
    confirmed_fields: confirmed,
  };
}
