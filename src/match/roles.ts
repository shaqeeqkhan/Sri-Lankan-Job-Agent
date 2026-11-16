/**
 * Job-title matching for the prefilter (PRD §5.3 stage 1). Deterministic and explainable.
 *
 * A title is read as one or more roles. Each role has a HEAD (the role noun: engineer, accountant,
 * executive, assistant, manager…) and FUNCTIONS (what the role is about: software, accounts,
 * marketing…). Two titles are the same kind of role when the wanted title's functions are covered by
 * the job's, and the heads are compatible. A word shared anywhere is not enough: "Business
 * Development Executive – ERP & Software Solutions" is a sales executive, not a software engineer.
 *
 *   "Senior Software Engineer – Full Stack (Java)"  head engineer, functions {software}, qualifiers {fullstack, java}, level senior
 *   "Executive - Digital Marketing"                 head executive, functions {digital, marketing}
 *   "Accountant | Assistant Accountant"             two roles; the best one counts
 *
 * Seniority words (intern, junior, senior, lead, head of…) never decide the kind of role; they give the
 * job's level, which `seniorityFit` compares with the person's.
 *
 * The tables below are deliberately small and tuned to Sri Lankan job boards (checked against ~985 real
 * open titles on 15 Nov 2026). Add a word only with a test in test/match-roles.test.ts.
 */
import { round } from './text.ts';

// ---------------------------------------------------------------- tables

/** Multi-word phrases joined into one token before anything else (order: longest first). */
const PHRASES: [RegExp, string][] = [
  [/\bfull[\s-]?stack\b/g, ' fullstack '],
  [/\bback[\s-]?end\b/g, ' backend '],
  [/\bfront[\s-]?end\b/g, ' frontend '],
  [/\bserver[\s-]side\b/g, ' backend '],
  [/\bquality\s+assurance\b/g, ' qa '],
  [/\bquality\s+engineer(ing)?\b/g, ' qa engineer '],
  [/\bsoftware\s+test(ing|er)?\b/g, ' qa '],
  [/\bsite\s+reliability\b/g, ' sre '],
  [/\bmachine\s+learning\b/g, ' ml '],
  [/\bhuman\s+resources?\b/g, ' hr '],
  [/\bbusiness\s+develop(ment|er)\b/g, ' sales '],
  [/\bkey\s+accounts?\b/g, ' sales '],
  [/\baccounts?\s+manage(r|ment)\b/g, ' sales manager '],
  [/\bsocial\s+media\b/g, ' socialmedia '],
  [/\bcustomer\s+(service|care|support)\b/g, ' customerservice '],
  [/\bdata\s+entry\b/g, ' dataentry '],
  [/\btech(nical)?\s+lead(er)?\b/g, ' techlead '],
  [/\bteam\s+lead(er)?\b/g, ' teamlead '],
  [/\bhead\s+of\b/g, ' headof '],
  [/\bgeneral\s+manager\b/g, ' gm '],
  [/\bentry[\s-]level\b/g, ' entrylevel '],
  [/\bc\+\+/g, ' cplusplus '],
  [/\bc#/g, ' csharp '],
  [/\.net\b/g, ' dotnet '],
  [/\bnode\.?js\b/g, ' node '],
  [/\bui\s*\/\s*ux\b/g, ' uiux '],
  [/\be-?commerce\b/g, ' ecommerce '],
];

/** Same meaning, one spelling. */
const CANON: Record<string, string> = {
  developer: 'engineer', programmer: 'engineer', dev: 'engineer',
  accounting: 'accounts', account: 'accounts', acc: 'accounts', accts: 'accounts',
  payable: 'accounts', payables: 'accounts', receivable: 'accounts', receivables: 'accounts',
  tester: 'qa', testing: 'qa', test: 'qa',
  administrative: 'admin', administration: 'admin',
  marketer: 'marketing', telemarketing: 'sales',
  exec: 'executive', executives: 'executive', officers: 'officer', engineers: 'engineer', developers: 'engineer',
  accountants: 'accountant', assistants: 'assistant', managers: 'manager', interns: 'intern', trainees: 'trainee',
  internship: 'intern', sr: 'senior', snr: 'senior', jr: 'junior', jnr: 'junior',
  js: 'javascript', reactjs: 'react', golang: 'go',
  ux: 'uiux', ui: 'uiux', mgr: 'manager', asst: 'assistant',
};

/** Role nouns (the head of a title) and their group. Same group = compatible heads. */
const HEADS: Record<string, string> = {
  engineer: 'eng', architect: 'eng', techlead: 'eng',
  accountant: 'pro', executive: 'pro', officer: 'pro', specialist: 'pro', coordinator: 'pro', administrator: 'pro',
  consultant: 'pro', representative: 'pro', associate: 'pro',
  assistant: 'asst', clerk: 'asst',
  manager: 'mgr', headof: 'mgr', director: 'mgr', teamlead: 'mgr', lead: 'mgr', gm: 'mgr', supervisor: 'mgr', head: 'mgr',
  analyst: 'analyst', designer: 'design', technician: 'tech', operator: 'tech', mechanic: 'tech',
  lecturer: 'teach', teacher: 'teach', instructor: 'teach', tutor: 'teach', counselor: 'teach', counsellor: 'teach',
  driver: 'driver', cashier: 'cashier', receptionist: 'reception', nurse: 'nurse', chef: 'chef', cook: 'chef',
  agent: 'agent', auditor: 'auditor', controller: 'mgr', writer: 'writer', steward: 'hospitality', attendant: 'hospitality',
  draftsman: 'design', electrician: 'tech', plumber: 'tech', welder: 'tech', labourer: 'labour', helper: 'labour',
  merchandiser: 'merch', planner: 'pro', buyer: 'pro', tutorinstructor: 'teach',
};
/** How compatible two head groups are (symmetric; missing = 0.1, same group = 0.85, same head = 1). */
const HEAD_GROUP_SIM: Record<string, number> = {
  'pro|asst': 0.6, 'pro|mgr': 0.5, 'asst|mgr': 0.3, 'eng|pro': 0.3, 'pro|analyst': 0.5, 'eng|analyst': 0.3,
  'eng|tech': 0.3, 'pro|auditor': 0.5, 'eng|design': 0.3,
};

/** A head that implies a function: an accountant does accounts, a programmer writes software. */
const HEAD_IMPLIES: Record<string, string[]> = { accountant: ['accounts'], techlead: ['software'], auditor: ['audit'] };

/** Child function → parent function (an implied, slightly weaker match): a Java developer is a software developer. */
const PARENT: Record<string, string> = {
  java: 'software', dotnet: 'software', csharp: 'software', python: 'software', node: 'software', typescript: 'software',
  javascript: 'software', php: 'software', react: 'software', angular: 'software', flutter: 'software', go: 'software',
  kotlin: 'software', swift: 'software', cplusplus: 'software', web: 'software', backend: 'software', frontend: 'software',
  fullstack: 'software', mobile: 'software', android: 'software', ios: 'software', wordpress: 'software', laravel: 'software',
  socialmedia: 'marketing', seo: 'marketing', brand: 'marketing', digital: 'marketing', content: 'marketing',
  payroll: 'hr', recruitment: 'hr', talent: 'hr',
};
/** Close but not the same function (symmetric). */
const RELATED: Record<string, number> = {
  'backend|fullstack': 0.9, 'frontend|fullstack': 0.9, 'accounts|finance': 0.7, 'audit|accounts': 0.5,
  'admin|hr': 0.4, 'customerservice|sales': 0.4, 'sre|devops': 0.9, 'ml|ai': 0.9, 'data|ml': 0.6, 'data|ai': 0.5,
};
/**
 * Functions that make a role a different job when the wanted title does not ask for them. A job title with
 * one of these the wanted title does not cover loses a fifth of its match per extra ("Sales and Marketing
 * Executive" is a little less a Marketing Executive). Unknown words (places, products) cost nothing.
 */
const KNOWN_FUNCTIONS = new Set([
  'software', 'accounts', 'finance', 'audit', 'marketing', 'sales', 'hr', 'admin', 'qa', 'devops', 'sre', 'data', 'ml', 'ai',
  'security', 'network', 'support', 'uiux', 'it', 'civil', 'electrical', 'mechanical', 'customerservice', 'dataentry',
  'logistics', 'procurement', 'legal', 'teaching', 'nursing', 'production', 'quality', 'merchandising', 'design', 'graphic',
  'ecommerce', 'operations', 'tax', 'credit', 'banking', 'insurance', 'travel', 'tour', 'hospitality',
]);

/** Seniority words → level (0 intern … 5 head/director). They never count as a function. */
const LEVELS: Record<string, number> = {
  intern: 0, trainee: 0.5, graduate: 0.5, fresher: 0.5, freshers: 0.5, entrylevel: 0.5, apprentice: 0.5, cadet: 0.5,
  junior: 1, assistant: 1, associate: 1.5, senior: 3, lead: 4, techlead: 4, teamlead: 4, principal: 4, staff: 3.5,
  manager: 4.5, headof: 5, head: 5, director: 5, chief: 5, vp: 5, gm: 5,
};
/** Seniority words that are never a role head. */
const PURE_LEVEL = new Set(['intern', 'trainee', 'graduate', 'fresher', 'freshers', 'entrylevel', 'apprentice', 'cadet', 'junior', 'senior', 'principal', 'staff', 'chief', 'vp']);

const STOP = new Set([
  'and', 'of', 'the', 'for', 'in', 'to', 'a', 'an', 'with', 'at', 'on', 'or', 'cum', 'amp', 'i', 'ii', 'iii', 'iv', 'v',
  'grade', 'level', 'urgent', 'vacancy', 'vacancies', 'wanted', 'required', 'needed', 'hiring', 'immediate', 'immediately',
  'post', 'position', 'positions', 'role', 'job', 'jobs', 'opening', 'full', 'part', 'time', 'contract', 'permanent', 'temporary',
  'male', 'female', 'males', 'females', 'remote', 'hybrid', 'onsite', 'wfh', 'ref', 'experienced', 'levels',
]);

// ---------------------------------------------------------------- parsing

export interface Role {
  /** Canonical head noun, or null when the title names no role noun. */
  head: string | null;
  /** Functions in the role's own words ("software", "accounts"), canonical. */
  funcs: string[];
  /** Functions from qualifiers: brackets and dash-separated parts ("(Java)", "– Full Stack"). */
  qual: string[];
  /** Seniority levels this role's own words name ("Senior Accounts Executive" → [3]). */
  levels: number[];
}
export interface ParsedTitle {
  roles: Role[];
  /** Seniority levels named anywhere in the title (empty = not stated). */
  levels: number[];
}

function tokens(s: string): string[] {
  let t = ` ${s.normalize('NFKC').toLowerCase()} `;
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  return t
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => CANON[w] ?? w)
    .filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
}

/** Splits a title into role alternatives with their qualifiers. */
function rolePieces(title: string): { main: string; qual: string[] }[] {
  const out: { main: string; qual: string[] }[] = [];
  for (const alt of title.split(/\s*\|\s*|\s+\/\s+/)) {
    const qual: string[] = [];
    // Brackets are qualifiers: "(Node/TypeScript)", "(Gampaha Branch)", "(1)".
    let rest = alt.replace(/\(([^)]*)\)?|\[([^\]]*)\]/g, (_m, a, b) => {
      qual.push(a ?? b ?? '');
      return ' ';
    });
    // Dash-separated parts: "Senior Software Engineer – Full Stack", "Executive - Digital Marketing".
    const parts = rest.split(/\s+[-–—:]+\s*|\s*[-–—]+\s+|\s*[–—]\s*/).map((p) => p.trim()).filter(Boolean);
    rest = parts.shift() ?? '';
    qual.push(...parts);
    // "Accountant Cum Administrative Officer", "Lecturer, Senior Lecturer, Works Engineer", "DevOps Engineer/Senior DevOps Engineer"
    const alts = rest.split(/\s*,\s*|\s+cum\s+|\s*&\s*(?=(?:senior|junior|assistant)\b)/i).flatMap((a) => {
      const slash = a.split(/\s*\/\s*/);
      return slash.length > 1 && slash.every((x) => x.trim().split(/\s+/).length >= 2) ? slash : [a];
    });
    for (const a of alts) if (a.trim()) out.push({ main: a, qual });
  }
  return out;
}

function headOf(toks: string[]): { head: string | null; rest: string[] } {
  for (let i = toks.length - 1; i >= 0; i--) {
    if (HEADS[toks[i]] && !PURE_LEVEL.has(toks[i])) return { head: toks[i], rest: toks.filter((_, j) => j !== i) };
  }
  // No role noun: "Software Engineering Intern", "Quality Engineering", "Software Development".
  const last = [...toks].reverse().find((w) => !PURE_LEVEL.has(w));
  if (last === 'engineering' || last === 'development') return { head: 'engineer', rest: toks.filter((w) => w !== last) };
  return { head: null, rest: toks };
}

function funcWords(toks: string[], head: string | null): string[] {
  const out = toks.filter((w) => !(w in LEVELS) && !HEADS[w] && !(head === 'engineer' && (w === 'engineering' || w === 'development')));
  for (const w of HEAD_IMPLIES[head ?? ''] ?? []) out.push(w);
  // A bare "Developer" or "Programmer" is a software developer.
  return [...new Set(out)];
}

export function parseTitle(title: string): ParsedTitle {
  const levels = new Set<number>();
  const roles: Role[] = [];
  const pieces = rolePieces(title);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const mainToks = tokens(p.main);
    let qualToks = p.qual.flatMap(tokens);
    const own = new Set<number>();
    for (const w of [...mainToks, ...qualToks]) if (w in LEVELS) own.add(LEVELS[w]);
    for (const l of own) levels.add(l);
    let { head, rest } = headOf(mainToks);
    let merged = -1;
    // "Intern - Software Engineering": the first part is only a level, the role is in the next part.
    if (!rest.some((w) => !(w in LEVELS)) && p.qual.length) {
      merged = p.qual.findIndex((q) => tokens(q).length > 0);
      if (merged >= 0) {
        const h2 = headOf(tokens(p.qual[merged]));
        if (!head) head = h2.head;
        rest = [...rest, ...h2.rest];
        qualToks = p.qual.filter((_, k) => k !== merged).flatMap(tokens);
      }
    }
    // A qualifier with its own role noun is another role ("Accountant - Finance Lead").
    for (const [k, q] of p.qual.entries()) {
      if (k === merged) continue;
      const qt = tokens(q);
      const h = headOf(qt);
      if (h.head && h.head !== head && !(h.head in LEVELS && qt.length === 1)) pieces.push({ main: q, qual: [] });
    }
    let funcs = funcWords(rest, head);
    if (head === 'engineer' && !funcs.length && /\b(developer|programmer)s?\b/i.test(p.main)) funcs = ['software'];
    const qual = [...new Set(qualToks.filter((w) => !(w in LEVELS) && !HEADS[w]))];
    if (head || funcs.length) roles.push({ head, funcs, qual, levels: [...own].sort((a, b) => a - b) });
  }
  return { roles, levels: [...levels].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------- similarity

function headSim(a: string | null, b: string | null): number {
  if (!a || !b) return 0.6;
  if (a === b) return 1;
  const ga = HEADS[a];
  const gb = HEADS[b];
  if (ga && ga === gb) return 0.85;
  return HEAD_GROUP_SIM[`${ga}|${gb}`] ?? HEAD_GROUP_SIM[`${gb}|${ga}`] ?? 0.1;
}

function related(a: string, b: string): number {
  return RELATED[`${a}|${b}`] ?? RELATED[`${b}|${a}`] ?? 0;
}

/** How well the job's function word `j` serves the wanted function `w`, 0–1. */
function funcHit(w: string, j: string): number {
  if (w === j) return 1;
  if (PARENT[j] === w) return 0.85; // wanted software, job says Java
  if (PARENT[w] === j) return 0.6;  // wanted Java, job says software
  if (PARENT[w] && PARENT[w] === PARENT[j]) return Math.max(0.5, related(w, j));
  return related(w, j);
}

export interface TitleMatch {
  score: number;
  /** Index of the job's best-matching role in `parseTitle(job).roles` (-1 when nothing matched). */
  role: number;
  /** Head compatibility and function coverage of the best role pair, for explaining the score. */
  head: number;
  func: number;
}

function roleSim(j: Role, w: Role): TitleMatch {
  const h = headSim(j.head, w.head);
  let f: number;
  if (!w.funcs.length) f = j.funcs.length ? 0.8 : 1; // wanted "Manager": any manager
  else if (!j.funcs.length && !j.qual.length) f = 0.5; // job says only "Engineer"
  else {
    const hits = w.funcs.map((wf) =>
      Math.max(0, ...j.funcs.map((jf) => funcHit(wf, jf)), ...j.qual.map((qf) => 0.9 * funcHit(wf, qf))),
    );
    f = hits.reduce((a, b) => a + b, 0) / hits.length;
    // A known function the wanted title does not ask for makes it a different job, a little.
    const extras = j.funcs.filter((jf) => KNOWN_FUNCTIONS.has(PARENT[jf] ?? jf) && !w.funcs.some((wf) => funcHit(wf, jf) > 0 || funcHit(jf, wf) > 0));
    f *= Math.max(0.6, 0.8 ** extras.length);
  }
  return { score: round(f * (0.4 + 0.6 * h)), role: -1, head: round(h), func: round(f) };
}

/**
 * How much a job title is the same kind of role as a wanted title, 0–1: the best pair of roles, scored as
 * function coverage × head compatibility. Seniority is ignored here (see `seniorityFit`).
 */
export function titleMatch(jobTitle: string | ParsedTitle, wanted: string | ParsedTitle): TitleMatch {
  const j = typeof jobTitle === 'string' ? parseTitle(jobTitle) : jobTitle;
  const w = typeof wanted === 'string' ? parseTitle(wanted) : wanted;
  let best: TitleMatch = { score: 0, role: -1, head: 0, func: 0 };
  j.roles.forEach((jr, i) => {
    for (const wr of w.roles) {
      const m = roleSim(jr, wr);
      if (m.score > best.score) best = { ...m, role: i };
    }
  });
  return best;
}

export function roleSimilarity(jobTitle: string, wanted: string): number {
  return titleMatch(jobTitle, wanted).score;
}

/**
 * The skills rescue may take a job whose title is UNUSUAL: a role whose functions are words the tables do
 * not know ("Technical Onboarding Engineer", "Forward Deployed Engineer"), with a head noun compatible with a
 * wanted title's. A title that clearly names another function ("QA Engineer", "Sales Executive") is not
 * unusual, it is a different job, and stays out until the titles are widened.
 */
export function rescuable(job: ParsedTitle, wanted: ParsedTitle[]): boolean {
  return job.roles.some(
    (jr) =>
      !jr.funcs.some((f) => KNOWN_FUNCTIONS.has(PARENT[f] ?? f)) &&
      wanted.some((w) => w.roles.some((wr) => headSim(jr.head, wr.head) >= 0.6)),
  );
}

// ---------------------------------------------------------------- seniority

export const PROFILE_LEVEL: Record<string, number> = { intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, manager: 4.5, executive: 5 };

export function yearsLevel(years: number): number {
  return years < 1 ? 0.5 : years < 3 ? 1 : years < 6 ? 2 : years < 10 ? 3 : 4;
}

/**
 * The levels the person fits: their profile seniority, their years of experience, and the levels their
 * own target titles name (not the adjacent titles: those widen the kind of role, not the level) ("Senior Software Engineer" as a target opens senior jobs to a mid-level person).
 */
export function personRange(seniority: string, years: number | null, targets: ParsedTitle[]): [number, number] {
  const ls = [PROFILE_LEVEL[seniority] ?? 2];
  if (years != null) ls.push(yearsLevel(years));
  for (const t of targets) ls.push(...t.levels);
  return [Math.min(...ls), Math.max(...ls)];
}

/**
 * 0–1: how well the job's level fits the person. A title that names no level counts as mid-level
 * (1.5–3, what most Sri Lankan ads without a level mean). One step off costs a little; an intern post for
 * a mid-level person or a "Head of" post for a junior costs a lot.
 */
export function seniorityFit(job: ParsedTitle, person: [number, number], role = -1): { fit: number; job_level: [number, number] } {
  // In a multi-role title ("Student Counselor | Marketing Executive | Enrollment Manager") the level comes
  // from the role that matched, not from another role in the same ad.
  const levels = role >= 0 && job.roles.length > 1 ? (job.roles[role]?.levels ?? []) : job.levels;
  const lo = levels.length ? levels[0] : 1.5;
  const hi = levels.length ? levels[levels.length - 1] : 3;
  const d = hi < person[0] ? person[0] - hi : lo > person[1] ? lo - person[1] : 0;
  const fit = d <= 0 ? 1 : d <= 0.5 ? 0.85 : d <= 1 ? 0.7 : d <= 1.5 ? 0.5 : d <= 2 ? 0.3 : 0.1;
  return { fit, job_level: [lo, hi] };
}
