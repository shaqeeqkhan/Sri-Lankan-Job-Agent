import { cleanDescription, cleanHtml } from './clean.ts';
import { parseDate } from './normalize.ts';
import type { ApplyMethod, JobFields } from './schema.ts';

/**
 * Deterministic extraction from an ad's text or HTML. No LLM: this is the cheap first pass.
 * Anything it cannot read with confidence is left out and flagged, and the agent fills it in.
 */
export interface Extraction {
  fields: Partial<JobFields>;
  /** Fields read from loose text patterns rather than structured data. Shown for confirmation. */
  uncertain: string[];
  candidates: { emails: string[]; phones: string[] };
  warnings: string[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
    'i',
  );
  const m = html.match(re);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v).trim() : undefined;
}

type Json = any;

function findJobPosting(node: Json): Json | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findJobPosting(n);
      if (hit) return hit;
    }
    return undefined;
  }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
  return findJobPosting(node['@graph']);
}

function fromJsonLd(html: string): Partial<JobFields> {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data: Json;
    try {
      data = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const jp = findJobPosting(data);
    if (!jp) continue;
    const org = typeof jp.hiringOrganization === 'string' ? jp.hiringOrganization : jp.hiringOrganization?.name;
    const loc = [jp.jobLocation].flat()[0]?.address;
    const locality = typeof loc === 'string' ? loc : [loc?.addressLocality, loc?.addressRegion].filter(Boolean).join(', ');
    const salary = jp.baseSalary?.value;
    const salaryText =
      salary && typeof salary === 'object'
        ? [jp.baseSalary.currency, salary.minValue ?? salary.value, salary.maxValue && `- ${salary.maxValue}`, salary.unitText && `per ${String(salary.unitText).toLowerCase()}`]
            .filter(Boolean)
            .join(' ')
        : undefined;
    const out: Partial<JobFields> = {
      title: str(jp.title),
      company: str(org),
      location: str(locality),
      description: jp.description ? cleanDescription(String(jp.description)) || undefined : undefined,
      closing_date: parseDate(str(jp.validThrough)?.slice(0, 10)) ?? undefined,
      posted_at: str(jp.datePosted),
      salary_text: str(salaryText),
      category: str(jp.occupationalCategory) ?? str(jp.industry),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null)) as Partial<JobFields>;
  }
  return {};
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// Sri Lankan mobiles (07X XXX XXXX) and landlines (0XX XXX XXXX), with or without +94.
const PHONE = /(?<![\d+])(?:\+94|0094|0)[\s-]?(?:7\d|[1-9]\d)[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
const IGNORED_EMAIL = /^(no-?reply|donotreply|privacy|abuse|webmaster|support|noreply-.*)@|@(example\.(com|org)|sentry\.io|.*\.png|.*\.jpg)$/i;

const CLOSING = [
  /closing\s+date\s*(?:for\s+applications?)?\s*(?:is|:|-|–)?\s*([^\n.;]{6,40})/i,
  /(?:apply|applications?\s+(?:should|must)\s+reach\s+(?:us|the\s+[a-z ]+)?)\s+(?:on\s+or\s+)?before\s+([^\n.;]{6,40})/i,
  /on\s+or\s+before\s+([^\n.;]{6,40})/i,
  /deadline\s*(?::|-|–|is)?\s*([^\n.;]{6,40})/i,
  /last\s+date\s*(?:for\s+applications?)?\s*(?::|-|–|is)?\s*([^\n.;]{6,40})/i,
];

const SUBJECT = [
  /[^.\n]*\b(?:state|mention|indicate|quote|include|specify|write)\b[^.\n]{0,60}\bsubject(?:\s+line)?\b[^.\n]*[.\n]?/i,
  /[^.\n]*\bsubject(?:\s+line)?\s*(?:should|must)\b[^.\n]*[.\n]?/i,
  /[^.\n]*\b(?:post|position)\s+applied\s+for\b[^.\n]{0,40}\b(?:top\s+left|left\s+hand|envelope|subject)\b[^.\n]*[.\n]?/i,
];

const DOCS: [RegExp, string][] = [
  [/\b(cv|curriculum vitae|resume|résumé)\b/i, 'CV'],
  [/\bcover(ing)?\s+letter\b/i, 'Cover letter'],
  [/\b(passport[- ]size|recent)\s+(colou?r\s+)?photo(graph)?s?\b/i, 'Photo'],
  [/\b(copies\s+of\s+)?(educational|professional)?\s*certificates?\b/i, 'Certificates'],
  [/\bcopy\s+of\s+(the\s+|your\s+)?(nic|national\s+identity\s+card)\b|\bnic\s+copy\b/i, 'NIC copy'],
  [/\b(two|2)\s+non[- ]related\s+referees?\b|\breferees?\b/i, 'Referees'],
  [/\bbirth\s+certificate\b/i, 'Birth certificate'],
  [/\bservice\s+letter\b/i, 'Service letter'],
];

const SALARY = /(?:rs\.?|lkr)\s*[\d,]+(?:\.\d+)?(?:\s*(?:-|–|to)\s*(?:rs\.?|lkr)?\s*[\d,]+)?(?:\s*(?:\/-)?\s*(?:per\s+month|p\.?m\.?|monthly))?|[\d,]{5,}\s*(?:\/-)?\s*(?:lkr|rupees)/i;

const POSTAL = /\b(registered\s+post|by\s+post|under\s+registered\s+cover|p\.?\s?o\.?\s+box|send\s+(?:your\s+)?applications?\s+to\s+the\s+address)\b/i;
const WHATSAPP = /\bwhats\s?app\b/i;

export function extract(input: { html?: string; text?: string }): Extraction {
  const html = input.html;
  // Hidden elements, scripts and attributes never reach the extractors (cleanHtml drops them), so
  // an "email this address instead" hidden in the page cannot become the apply address.
  const text = html ? htmlToText(cleanHtml(html)) : (input.text ?? '').trim();
  const fields: Partial<JobFields> = html ? fromJsonLd(html) : {};
  const uncertain: string[] = [];
  const warnings: string[] = [];

  if (html && !fields.title) {
    const t = metaContent(html, 'og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    if (t) {
      fields.title = decodeEntities(t).split(/\s+[|–-]\s+/)[0].trim();
      uncertain.push('title');
    }
  }
  if (!fields.description && text) fields.description = (html ? cleanDescription(html) : text).slice(0, 20_000);

  const emails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.toLowerCase()))].filter((e) => !IGNORED_EMAIL.test(e));
  const phones = [...new Set((text.match(PHONE) ?? []).map((p) => p.replace(/[\s-]/g, '')))];

  if (emails.length === 1) {
    fields.apply_email = emails[0];
    uncertain.push('apply_email');
  } else if (emails.length > 1) {
    warnings.push(`Found ${emails.length} email addresses; pick the one the ad says to apply to.`);
  }
  if (phones.length) {
    fields.apply_phone = phones[0];
    if (phones.length > 1) warnings.push(`Found ${phones.length} phone numbers.`);
  }

  if (!fields.closing_date) {
    for (const re of CLOSING) {
      const m = text.match(re);
      const d = m && parseDate(m[1]);
      if (d) {
        fields.closing_date = d;
        uncertain.push('closing_date');
        break;
      }
    }
  }

  for (const re of SUBJECT) {
    const m = text.match(re);
    if (m) {
      fields.subject_instruction = m[0].trim().replace(/\s+/g, ' ');
      break;
    }
  }

  if (!fields.salary_text) {
    const m = text.match(SALARY);
    if (m) fields.salary_text = m[0].trim();
  }

  const docs = DOCS.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (docs.length) fields.required_docs = docs;

  let method: ApplyMethod | undefined;
  if (POSTAL.test(text)) method = 'post';
  else if (fields.apply_email) method = 'email';
  else if (phones.length && WHATSAPP.test(text)) method = 'phone';
  if (method) fields.apply_method = method;

  if (html && text.length < 300 && /<img\b/i.test(html)) {
    fields.is_image_ad = true;
    warnings.push('The ad looks like an image with little text. Read the image and pass the fields.');
  }

  return { fields, uncertain, candidates: { emails, phones }, warnings, text };
}
