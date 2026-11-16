/** Small, deterministic text helpers for the prefilter and for checking quoted JD phrases. */

const TITLE_STOP = new Set([
  'and', 'of', 'the', 'for', 'in', 'to', 'a', 'an', 'with', 'at', 'on', 'or',
  // seniority words: seniority is its own rubric dimension, not part of "is this the same kind of role"
  'senior', 'junior', 'sr', 'jr', 'lead', 'trainee', 'intern', 'internship', 'associate', 'principal', 'head', 'chief',
  'i', 'ii', 'iii', 'iv', 'grade', 'level', 'graduate', 'fresher', 'freshers', 'urgent', 'vacancy', 'vacancies',
  'wanted', 'required', 'needed', 'hiring', 'post', 'position', 'role', 'job', 'jobs', 'cum', 'full', 'part', 'time',
]);

export function words(s: string | null | undefined): string[] {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/c\+\+/g, 'cplusplus')
    .replace(/c#/g, 'csharp')
    .replace(/\.net\b/g, 'dotnet')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function titleTokens(title: string): string[] {
  return [...new Set(words(title).filter((w) => !TITLE_STOP.has(w)))];
}

/** Same word, or the same stem: shared first 6 letters, or one a prefix (≥5 letters) of the other. */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6)) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 5 && l.startsWith(s);
}

/**
 * How much a job title is the same kind of role as a wanted title, 0–1. Mostly coverage of the wanted
 * title's words (all of "Data Analyst" present = high), a little for how much of the job title is explained.
 */
export function titleSimilarity(jobTitle: string, wanted: string): number {
  const j = titleTokens(jobTitle);
  const w = titleTokens(wanted);
  if (!j.length || !w.length) return 0;
  const covered = w.filter((t) => j.some((u) => tokenMatch(t, u))).length / w.length;
  const explained = j.filter((t) => w.some((u) => tokenMatch(t, u))).length / j.length;
  return round(0.75 * covered + 0.25 * explained);
}

export function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Normalises text for "does this quote appear in the ad": case, whitespace, quotes, dashes, Markdown marks. */
export function quoteNorm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[*`•·▪●◦]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '');
}

export function containsQuote(haystack: string, quote: string): boolean {
  const q = quoteNorm(quote);
  return q.length > 0 && quoteNorm(haystack).includes(q);
}

const ENGLISH_STOP = new Set(
  ('a an and are as at be by for from has have in is it its of on or that the to was were will with you your we our ' +
    'i me my this these those they them their he she his her not no yes can may also etc using used use work worked ' +
    'working job role team year years month months company ltd pvt ability skills skill experience good strong').split(' '),
);

/** The most frequent content words of a text, for a "resume text" query. Ties broken alphabetically. */
export function keywords(text: string, n = 40): string[] {
  const counts = new Map<string, number>();
  for (const w of words(text)) {
    if (w.length < 3 || ENGLISH_STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}
