/**
 * Deciding whether two rows are the same job, strongest tier first (PRD §7.2, ported from
 * ThreatHire `utils/identity.py`).
 *
 * - Tier 1: the posting's own id. An ATS posting id parsed from the apply link wins (it is the same
 *   whoever found the job, so it catches cross-source copies); otherwise the source's own
 *   `platform|external_id`.
 * - Tier 1b: company + the normalised apply link, only when the link has an id-shaped segment, so a
 *   generic careers page never merges an employer's whole board. Company stays in the key because a
 *   bare link is a weaker claim than a posting id.
 * - Tier 2: company + normalised title + PLACE, where place is the parsed district slug from
 *   `places.ts`, never the raw location text. When the company is unknown (social posts), the apply
 *   email or phone stands in for it; with neither, there is no tier 2 (a wrong merge is worse than a
 *   duplicate, rule 11).
 *
 *   A trailing title segment that is only a Sri Lankan place ("| Colombo 03", "(Kiribathgoda)") is
 *   dropped from the title part (I1, found live: XpressJobs appends it, ikman does not).
 *
 * CHANGING TIER 2 RE-KEYS EVERY STORED JOB. test/identity.test.ts pins it with a table.
 */
import { normCompany, normText } from './normalize.ts';
import { parsePlace, stripTitlePlace } from './places.ts';

export interface IdentityInput {
  platform: string;
  external_id?: string | null;
  company?: string | null;
  title: string;
  location?: string | null;
  apply_url?: string | null;
  /** Stand-ins for the company in tier 2 when it is unknown. */
  apply_email?: string | null;
  apply_phone?: string | null;
}

export interface IdentityKeys {
  tier1: string | null;
  tier1b: string | null;
  tier2: string | null;
}

const ATS: [string, RegExp][] = [
  ['greenhouse', /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i],
  ['lever', /jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i],
  ['ashby', /jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i],
  ['smartrecruiters', /smartrecruiters\.com\/([^/?#]+)\/(\d{6,})/i],
  ['workable', /apply\.workable\.com\/([^/?#]+)\/j\/([A-Za-z0-9]+)/i],
];
const WORKDAY_SITE = /https?:\/\/wd\d+\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([a-z0-9-]+)\/[^/]+\/job\/[^/]+\/([^/?#]+)/i;
const WORKDAY = /https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com\/(?:[^/]+\/)*job\/[^/]+\/([^/?#]+)/i;

/** `ats|<family>|<board>|<posting id>` for a recognised ATS link, else null. */
export function postingRef(applyUrl: string | null | undefined): string | null {
  if (!applyUrl) return null;
  for (const [ats, rx] of ATS) {
    const m = applyUrl.match(rx);
    if (m) return `ats|${ats}|${m[1].toLowerCase()}|${m[2].toLowerCase()}`;
  }
  // wdN.myworkdaysite.com/recruiting/<tenant>/<site>/job/... names the tenant in the path (I1, Sysco LABS).
  const site = applyUrl.match(WORKDAY_SITE);
  const m = applyUrl.match(WORKDAY) ?? (site ? [site[0], site[1], site[2]] : null);
  if (m && m[2].includes('_')) {
    // The requisition id is after the last "_"; a trailing -1/-2 is Workday's repost counter.
    const req = m[2].slice(m[2].lastIndexOf('_') + 1).replace(/-\d{1,2}$/, '').toLowerCase();
    if (req) return `ats|workday|${m[1].toLowerCase()}|${req}`;
  }
  return null;
}

const TRACKING = new Set(['oga', 'gh_src', 'source', 'src', 'ref', 'referrer', 'trackid', 'lang', 'recruiter', 'campaign', 'fbclid', 'gclid', 'igshid', 'si']);
const ID_LIKE = /(?:\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}|[A-Za-z0-9]{10,})/;

/** The apply link reduced to what identifies the posting (host + path + sorted real params), else null. */
export function linkKey(applyUrl: string | null | undefined): string | null {
  if (!applyUrl) return null;
  let u: URL;
  try {
    u = new URL(applyUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const query = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const qs = new URLSearchParams(query).toString();
  if (!host || !(path || qs)) return null;
  if (!ID_LIKE.test(path + qs)) return null;
  return host + path + (qs ? `?${qs}` : '');
}

function contactKey(email?: string | null, phone?: string | null): string {
  if (email) return `@${email.trim().toLowerCase()}`;
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^(94|0)/, '');
  return digits.length >= 9 ? `#${digits}` : '';
}

export function identityKeys(job: IdentityInput): IdentityKeys {
  const ref = postingRef(job.apply_url);
  const ext = job.external_id?.trim();
  const tier1 = ref ?? (ext ? `${job.platform}|${ext}` : null);

  const company = normCompany(job.company);
  const link = linkKey(job.apply_url);
  const tier1b = link && company ? `url|${company}|${link}` : null;

  const who = company || contactKey(job.apply_email, job.apply_phone);
  // A place appended to the title ("Sales Executive | Colombo 03") is the place part, not the title.
  const title = normText(stripTitlePlace(job.title));
  const tier2 = who && title ? `job|${who}|${title}|${parsePlace(job.location).slug ?? ''}` : null;
  return { tier1, tier1b, tier2 };
}

/** The tier 2 key without its place part ("job|company|title|"), for matching a copy that names no place. */
export function tier2Prefix(tier2: string): string {
  return tier2.slice(0, tier2.lastIndexOf('|') + 1);
}
