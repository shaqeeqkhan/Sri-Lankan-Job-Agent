import MiniSearch from 'minisearch';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { loadProfile, readResume, type Profile } from '../user/profile.ts';
import { jobRef, recordWidening } from './day-report.ts';
import { nearbyDistricts, placeOf, requirementsExcerpt } from './deps.ts';
import { adText, freshScoreHashes, jobsById, matchKey, openJobs, type MatchJob, type MatchKey } from './jobs.ts';
import { rescuable, parseTitle, personRange, seniorityFit, titleMatch, type ParsedTitle } from './roles.ts';
import { keywords, round, words } from './text.ts';

/**
 * Stage 1 of matching (PRD §5.3): code only, no LLM. Ranks open jobs for the CV by title match to the
 * target (and adjacent) titles (src/match/roles.ts: head noun and function, not any shared word), BM25
 * overlap between the CV's skills / resume text and the ad, location fit and recency, scaled by how well the
 * job's level fits the person's seniority, and hands back the ones not yet scored for
 * (resume_hash, job_hash, rubric_version).
 *
 *   total = (0.45 title + 0.30 skills + 0.15 location + 0.10 recency) × (0.55 + 0.45 seniority)
 */

export const WEIGHTS = { title: 0.45, skills: 0.3, location: 0.15, recency: 0.1 } as const;
/** How much seniority fit scales the total: an intern post for a mid-level person keeps about 70% of its score. */
export const SENIORITY_FLOOR = 0.55;
/** A job is eligible on title when its match to a wanted title is at least this: "Business Analyst" is not a "Data Analyst" until titles are widened. */
export const TITLE_GATE = 0.6;
/**
 * Skills rescue: a job whose title is unusual ("Forward Deployed Engineer") is still eligible when its head
 * noun is compatible with a wanted title's (an engineer for an engineer, not a sales executive) and its ad names
 * at least RESCUE_MIN_SKILLS of the CV's skills, covering at least RESCUE_MIN_COVERAGE of them.
 */
export const RESCUE_MIN_SKILLS = 3;
export const RESCUE_MIN_COVERAGE = 0.25;
/** Image ads with no transcribed text get this share of the pool's median skills score instead of 0. */
const IMAGE_SKILLS_SHARE = 1;
const RECENCY_DAYS = 60;
export const EXCERPT_MAX = 1500;

export type TitleScope = 'target' | 'adjacent' | 'any' | 'custom';
export type DistrictScope = 'home' | 'nearby' | 'any' | 'district';

export interface PoolOptions {
  /** ['target'] (default), ['adjacent'] (targets + adjacent titles), ['any'] (no title gate), or a custom title list. */
  titles?: string[];
  /** 'home' (default: profile location + districts_ok + remote + unknown), 'nearby', 'any', or one district name. */
  district?: string;
  /** Only remote jobs. */
  remote?: boolean;
  /** A job id or "#n": rank by likeness to this job as well. */
  like?: string;
  /** "14d", "30", "60d", "all", or YYYY-MM-DD. Default settings.scan.since_days. */
  since?: string;
}

export interface SubScores {
  total: number;
  title: number;
  skills: number;
  location: number;
  recency: number;
  /** 0–1: the job's level (from its title) against the person's (profile seniority, years, target titles). */
  seniority: number;
  /** Why the job is in the pool: its title matched, or the ad's skills rescued an unusual title. */
  eligible_by: 'title' | 'skills';
  /** An image ad with no transcribed text: `skills` is the pool median, not a reading of the ad. */
  skills_imputed?: boolean;
}

export interface Ranked {
  job: MatchJob;
  sub: SubScores;
  /** A fresh cached score exists for this resume, rubric and job text. */
  scored: boolean;
  /** A score exists but the job text changed since. */
  stale: boolean;
}

export interface Applied {
  titles: TitleScope;
  title_list: string[];
  since: string;
  since_days: number | null;
  district: DistrictScope;
  district_name: string | null;
  remote_only: boolean;
  like: string | null;
}

export interface Pool {
  key: MatchKey;
  open: number;
  ranked: Ranked[];
  applied: Applied;
  /** Widening steps these options amount to (PRD §5.4a step 3). */
  widening: string[];
}

function parseSince(raw: string | undefined, defaultDays: number): { days: number | null; date: string | null; label: string } {
  if (raw == null || raw === '') return { days: defaultDays, date: null, label: `${defaultDays}d` };
  const s = raw.trim().toLowerCase();
  if (s === 'all' || s === 'any') return { days: null, date: null, label: 'all' };
  const m = s.match(/^(\d{1,4})\s*d?$/);
  if (m) return { days: Number(m[1]), date: null, label: `${Number(m[1])}d` };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { days: null, date: s, label: s };
  throw new SljError('INVALID_INPUT', `--since is a number of days ("30d") or a date (YYYY-MM-DD) or "all", not "${raw}".`);
}

function districtOf(name: string): string {
  return placeOf(name).district ?? name.trim().toLowerCase().replace(/-/g, ' ');
}

function homeDistricts(p: Profile): string[] {
  const out = new Set<string>();
  if (p.location.value) {
    const d = placeOf(p.location.value).district;
    if (d) out.add(d);
  }
  for (const d of p.districts_ok.value) out.add(districtOf(d));
  return [...out].sort();
}

function jobDate(j: MatchJob): number {
  const posted = j.posted_at ? Date.parse(j.posted_at) : NaN;
  return Number.isFinite(posted) ? posted : Date.parse(j.fetched_at);
}

/** BM25 scores for a query, normalised to 0–1 by the best document in the corpus. */
function bm25(index: MiniSearch, query: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!query.trim()) return out;
  const hits = index.search(query, { combineWith: 'OR', boost: { title: 1.5 } });
  const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
  if (max <= 0) return out;
  for (const h of hits) out.set(String(h.id), h.score / max);
  return out;
}

/** Distinct CV skills named in the ad (title, description and any transcribed image text). */
function skillHits(skills: string[], job: MatchJob): number {
  if (!skills.length) return 0;
  const doc = ` ${words(`${job.title} ${adText(job)}`).join(' ')} `;
  return skills.filter((s) => {
    const w = words(s).join(' ');
    return w && doc.includes(` ${w} `);
  }).length;
}

/** An image ad whose picture has not been read yet: its text is not in the database. */
function textless(j: MatchJob): boolean {
  return j.is_image_ad && !j.ad_text;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildPool(ctx: Context, opts: PoolOptions = {}): Pool {
  const key = matchKey(ctx);
  const settings = ctx.config().settings;
  const profile = loadProfile(ctx);
  const resume = readResume(ctx);
  const db = ctx.db();
  const now = ctx.now().getTime();
  const open = openJobs(db, key.today);

  // ---- titles
  const t = opts.titles?.map((s) => s.trim()).filter(Boolean) ?? [];
  const scopeWord = t.length === 1 ? t[0].toLowerCase() : null;
  const titleScope: TitleScope =
    !t.length || scopeWord === 'target' ? 'target' : scopeWord === 'adjacent' ? 'adjacent' : scopeWord === 'any' ? 'any' : 'custom';
  const targets = titleScope === 'custom' ? t : profile.target_titles.value;
  const adjacent = titleScope === 'custom' ? [] : profile.adjacent_titles.value;

  // ---- anchor ("more like #3")
  let anchor: MatchJob | null = null;
  if (opts.like) {
    const id = jobRef(db, key, opts.like);
    anchor = jobsById(db, [id]).get(id) ?? null;
  }

  // ---- since
  const since = parseSince(opts.since, settings.scan.since_days);
  const cutoff = since.days != null ? now - since.days * 86_400_000 : since.date ? Date.parse(`${since.date}T00:00:00+05:30`) : null;

  // ---- location
  const home = homeDistricts(profile);
  const raw = opts.district?.trim().toLowerCase();
  let districtScope: DistrictScope = 'home';
  let districtName: string | null = null;
  if (raw === 'nearby') districtScope = 'nearby';
  else if (raw === 'any' || raw === 'all') districtScope = 'any';
  else if (raw && raw !== 'home') {
    districtScope = 'district';
    districtName = districtOf(raw);
  }
  if (districtScope === 'home' && !home.length) districtScope = 'any';
  const near = new Set(home.flatMap((d) => nearbyDistricts(d)).filter((d) => !home.includes(d)));
  const homeSet = new Set(home);
  const mode = profile.work_mode.value;
  const remoteOk = mode !== 'onsite';

  const locationFit = (j: MatchJob): number => {
    if (j.remote && remoteOk) return 1;
    if (!home.length) return j.remote ? 0.6 : 0.5;
    if (j.district && homeSet.has(j.district)) return mode === 'remote' ? 0.6 : 1;
    if (j.district && near.has(j.district)) return mode === 'remote' ? 0.4 : 0.6;
    if (!j.district) return 0.5;
    return j.remote ? 0.5 : 0.1;
  };
  const locationGate = (j: MatchJob): boolean => {
    if (opts.remote && !j.remote) return false;
    switch (districtScope) {
      case 'any':
        return true;
      case 'district':
        return j.district === districtName;
      case 'nearby':
        return (j.remote && remoteOk) || !j.district || homeSet.has(j.district) || near.has(j.district) || opts.remote === true;
      case 'home':
        return (j.remote && remoteOk) || !j.district || homeSet.has(j.district) || opts.remote === true;
    }
  };

  // ---- BM25 corpus: every open job, inserted in id order, so normalisation does not depend on filters.
  const index = new MiniSearch({
    fields: ['title', 'description'],
    idField: 'id',
    tokenize: (s) => words(s),
    processTerm: (term) => (term.length < 2 ? null : term),
  });
  index.addAll(open.map((j) => ({ id: j.id, title: j.title, description: adText(j) })));
  const skills = profile.skills.value;
  const bmSkills = bm25(index, skills.join(' '));
  const bmResume = bm25(index, keywords(resume, 40).join(' '));
  const bmLike = anchor ? bm25(index, keywords(`${anchor.title} ${anchor.title} ${anchor.description}`, 30).join(' ')) : null;

  const fresh = freshScoreHashes(db, key);
  const targetP = targets.map(parseTitle);
  const adjacentP = adjacent.map(parseTitle);
  const anchorP = anchor ? parseTitle(anchor.title) : null;
  const person = personRange(profile.seniority.value, profile.years_experience.value, targetP);
  const best = (jt: ParsedTitle, ws: ParsedTitle[]) =>
    ws.reduce((b, w) => {
      const m = titleMatch(jt, w);
      return m.score > b.score ? m : b;
    }, { score: 0, role: -1 } as { score: number; role: number });

  type Row = { job: MatchJob; title: number; skill: number; imputed: boolean; location: number; recency: number; seniority: number; by: 'title' | 'skills' };
  const rows: Row[] = [];
  for (const j of open) {
    if (anchor && j.id === anchor.id) continue;
    const date = jobDate(j);
    if (cutoff != null && Number.isFinite(date) && date < cutoff) continue;
    if (!locationGate(j)) continue;

    const jt = parseTitle(j.title);
    const tm = best(jt, targetP);
    const am = best(jt, adjacentP);
    const lm = anchorP ? titleMatch(jt, anchorP) : { score: 0, role: -1 };
    const target = tm.score;
    const adj = am.score;
    const like = lm.score;
    const role = [tm, am, lm].reduce((b, m) => (m.score > b.score ? m : b)).role;
    const gateScore = titleScope === 'any' ? 1 : Math.max(target, titleScope === 'adjacent' ? adj : 0, like);
    const title = round(Math.max(target, 0.75 * adj, like));

    const hits = skillHits(skills, j);
    let skill = skills.length
      ? 0.55 * (bmSkills.get(j.id) ?? 0) + 0.3 * (hits / skills.length) + 0.15 * (bmResume.get(j.id) ?? 0)
      : bmResume.get(j.id) ?? 0;
    if (bmLike) skill = 0.5 * skill + 0.5 * (bmLike.get(j.id) ?? 0);

    let by: Row['by'] = 'title';
    if (gateScore < TITLE_GATE) {
      // Skills rescue: an unusual title whose ad clearly asks for this CV's skills. A job that matches an
      // adjacent title is not unusual: it waits for the "adjacent titles" widening step (PRD §5.4a).
      const wanted = titleScope === 'adjacent' ? [...targetP, ...adjacentP] : targetP;
      const rescued = titleScope !== 'custom' && !(titleScope === 'target' && adj >= TITLE_GATE) && !textless(j) && skills.length > 0 && hits >= RESCUE_MIN_SKILLS &&
        hits / skills.length >= RESCUE_MIN_COVERAGE && rescuable(jt, wanted);
      if (!rescued) continue;
      by = 'skills';
    }
    const ageDays = Number.isFinite(date) ? Math.max(0, (now - date) / 86_400_000) : RECENCY_DAYS / 2;
    rows.push({
      job: j, title, skill, imputed: textless(j), location: locationFit(j), recency: Math.max(0, 1 - ageDays / RECENCY_DAYS),
      seniority: seniorityFit(jt, person, role).fit, by,
    });
  }
  // An image ad has no text yet, so a skills score of 0 would only measure that. It gets the median of the
  // text ads in the same pool (an average ad), until its image is transcribed.
  const typical = IMAGE_SKILLS_SHARE * median(rows.filter((r) => !r.imputed).map((r) => r.skill));
  const ranked: Ranked[] = rows.map((r) => {
    const skill = round(r.imputed ? typical : r.skill);
    const location = round(r.location);
    const recency = round(r.recency);
    const seniority = round(r.seniority);
    const base = WEIGHTS.title * r.title + WEIGHTS.skills * skill + WEIGHTS.location * location + WEIGHTS.recency * recency;
    const total = round(base * (SENIORITY_FLOOR + (1 - SENIORITY_FLOOR) * seniority));
    const stored = fresh.get(r.job.id);
    const scored = stored !== undefined && stored === r.job.job_hash;
    const sub: SubScores = { total, title: r.title, skills: skill, location, recency, seniority, eligible_by: r.by, ...(r.imputed ? { skills_imputed: true } : {}) };
    return { job: r.job, sub, scored, stale: stored !== undefined && !scored };
  });
  ranked.sort(
    (a, b) =>
      b.sub.total - a.sub.total ||
      (a.job.closing_date ?? '9999-99-99').localeCompare(b.job.closing_date ?? '9999-99-99') ||
      a.job.id.localeCompare(b.job.id),
  );

  const widening: string[] = [];
  if (titleScope === 'adjacent' || titleScope === 'any') widening.push('adjacent');
  if (since.days == null || since.days > settings.scan.since_days) widening.push(`since:${since.label}`);
  if (districtScope === 'nearby' || (districtScope === 'any' && home.length)) widening.push('nearby_remote');

  return {
    key,
    open: open.length,
    ranked,
    applied: {
      titles: titleScope,
      title_list: [...targets, ...(titleScope === 'adjacent' || titleScope === 'any' ? adjacent : [])],
      since: since.label,
      since_days: since.days,
      district: districtScope,
      district_name: districtName,
      remote_only: !!opts.remote,
      like: anchor?.id ?? null,
    },
    widening,
  };
}

export interface PrefilterInput extends PoolOptions {
  limit: number;
  offset: number;
  include_scored?: boolean;
  /** Widening the agent did outside slj, recorded for `top`'s next_step (e.g. a slow-source scan). */
  widened?: string[];
}

/**
 * The window [offset, offset + limit) of the ranked eligible pool, minus jobs already scored (unless
 * include_scored). Offsets therefore count scored jobs too: after scoring window 0, re-running offset 0 returns
 * nothing, and `--offset 60` is the next window (PRD §5.4a step 2).
 */
export function prefilter(ctx: Context, input: PrefilterInput) {
  const pool = buildPool(ctx, input);
  const { ranked } = pool;
  const end = input.offset + input.limit;
  const window = ranked.slice(input.offset, end);
  const picked = input.include_scored ? window : window.filter((r) => !r.scored);
  const unscoredIdx = ranked.map((r, i) => (r.scored ? -1 : i)).filter((i) => i >= 0);
  const firstAfter = unscoredIdx.find((i) => i >= end);
  const before = unscoredIdx.filter((i) => i < input.offset).length;
  const alreadyScored = ranked.filter((r) => r.scored).length;

  const steps = [...pool.widening, ...(input.widened ?? [])];
  const widened = steps.length ? recordWidening(ctx.db(), pool.key, steps, ctx.now()) : undefined;

  return {
    resume_hash: pool.key.resume_hash,
    rubric_version: pool.key.rubric_version,
    today: pool.key.today,
    applied: pool.applied,
    widened: widened ?? [],
    pool: {
      open: pool.open,
      eligible: ranked.length,
      already_scored: alreadyScored,
      remaining: ranked.length - alreadyScored,
    },
    window: { offset: input.offset, limit: input.limit, size: window.length },
    /** Unscored jobs ranked above this window (new since the last run): re-run with offset 0 to get them. */
    unscored_before: before,
    /** Offset of the next window that still has unscored jobs, or null. */
    next_offset: firstAfter == null ? null : input.offset + input.limit * Math.floor((firstAfter - input.offset) / input.limit),
    candidates: picked.map((r) => ({
      rank: ranked.indexOf(r) + 1,
      id: r.job.id,
      title: r.job.title,
      company: r.job.company,
      location: r.job.location,
      district: r.job.district,
      remote: r.job.remote,
      closing_date: r.job.closing_date,
      posted_at: r.job.posted_at,
      platform: r.job.platform,
      requirements_excerpt: requirementsExcerpt(r.job.ad_text ?? r.job.description, EXCERPT_MAX).slice(0, EXCERPT_MAX),
      is_image_ad: r.job.is_image_ad,
      ...(r.job.is_image_ad
        ? {
            image_urls: r.job.image_urls,
            /** true once `slj jobs transcribe` saved what the image says; until then, read the image before scoring. */
            transcribed: !!r.job.ad_text,
          }
        : {}),
      prefilter: r.sub,
      ...(r.stale ? { rescore: true } : {}),
      ...(input.include_scored ? { scored: r.scored } : {}),
    })),
  };
}
