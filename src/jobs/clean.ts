/**
 * Job description cleaner (PRD §7.2, ported from ThreatHire `utils/text.py` `clean_description`).
 *
 * Safe by construction: the intermediate HTML is written by `serialise()`, which emits exactly two
 * things, a keep-list tag with NO attributes, and text with &, < and > escaped. Scripts, styles,
 * hidden elements, comments, CDATA, forms and foreign content are dropped whole; every other tag is
 * unwrapped to its text. That HTML is then turned into Markdown for the agent, which saves tokens
 * and keeps prompt-injection carriers (hidden text, attributes, scripts) away from the LLM.
 */
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const KEEP = new Set(['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'br']);
/** Headings outside the keep-list are mapped onto it. */
const RENAME: Record<string, string> = { h1: 'h2', h5: 'h4', h6: 'h4' };
const DROP = new Set([
  'script', 'style', 'iframe', 'noscript', 'head', 'meta', 'link', 'button', 'form', 'input', 'textarea',
  'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'template', 'svg', 'math', 'object', 'embed', 'applet',
  'select', 'option', 'nav', 'img', 'picture', 'video', 'audio', 'canvas',
]);
/** Leaf block containers become paragraphs so Lever-style <div> lines keep their breaks. */
const BLOCK = new Set(['div', 'section', 'article', 'tr', 'header', 'footer', 'main', 'aside', 'blockquote', 'dd', 'dt', 'figure', 'address', 'center', 'table', 'tbody', 'thead']);
const CELL = new Set(['td', 'th']);
const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d]))/i;
const HIDDEN_CLASS = /(^|\s)(hidden|d-none|sr-only|visually-hidden|screen-reader-text|invisible)(\s|$)/i;

const REAL_MARKUP = /<[a-zA-Z/!?]/;

type Node = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: Node[] };

function isHidden(n: Node): boolean {
  const a = n.attribs ?? {};
  return 'hidden' in a || a['aria-hidden'] === 'true' || HIDDEN_STYLE.test(a.style ?? '') || HIDDEN_CLASS.test(a.class ?? '');
}

function hasBlock(n: Node): boolean {
  return (n.children ?? []).some((c) => c.type === 'tag' && (BLOCK.has(c.name!) || c.name === 'p' || c.name === 'ul' || c.name === 'ol' || hasBlock(c)));
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textOf(n: Node): string {
  if (n.type === 'text') return n.data ?? '';
  return (n.children ?? []).map(textOf).join('');
}

/** Iterative so deep nesting can never hit the stack limit. */
function serialise(root: Node): string {
  const out: string[] = [];
  const stack: [Node | string, boolean][] = (root.children ?? []).map((c) => [c, false] as [Node, boolean]).reverse();
  while (stack.length) {
    const [item, closing] = stack.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (closing) continue;
    const n = item;
    if (n.type === 'text') {
      out.push(escapeText(n.data ?? ''));
      continue;
    }
    // comment, directive, cdata, script, style: never text, dropped.
    if (n.type !== 'tag') continue;
    let name = n.name!.toLowerCase();
    if (DROP.has(name) || isHidden(n)) continue;
    name = RENAME[name] ?? name;
    let open = '';
    let close = '';
    if (name === 'br') {
      open = '<br>';
    } else if (KEEP.has(name)) {
      if ((name === 'p' || name === 'li') && !textOf(n).replace(/ /g, '').trim()) continue;
      open = `<${name}>`;
      close = `</${name}>`;
    } else if (BLOCK.has(name) && !hasBlock(n)) {
      if (!textOf(n).replace(/ /g, '').trim()) continue;
      open = '<p>';
      close = '</p>';
    } else if (CELL.has(name)) {
      close = ' ';
    } else if (BLOCK.has(name)) {
      close = '\n';
    }
    if (close) stack.push([close, false]);
    for (const c of [...(n.children ?? [])].reverse()) stack.push([c, false]);
    if (open) out.push(open);
  }
  return out.join('');
}

function decodeEntitiesOnce(s: string): string {
  return cheerio.load(`<p>${s.replace(/</g, '&lt;')}</p>`, null, false)('p').text();
}

/** Plain text → paragraphs and line breaks, escaped. */
function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split('\n').map((l) => escapeText(l.trim())).join('<br>')}</p>`)
    .join('');
}

/** The safe keep-list HTML (no attributes, everything else escaped). Exported for tests. */
export function cleanHtml(htmlOrText: string): string {
  if (!htmlOrText || !htmlOrText.trim()) return '';
  let input = htmlOrText.replace(/\u0000/g, '');
  // Descriptions stored entity-encoded ("&lt;h2&gt;"): decode once, only when there is no real markup.
  if (!REAL_MARKUP.test(input)) {
    const decoded = decodeEntitiesOnce(input);
    if (!REAL_MARKUP.test(decoded)) return textToHtml(decoded);
    input = decoded;
  }
  const $ = cheerio.load(input, null, false);
  const root = $.root()[0] as unknown as Node;
  return serialise(root)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let td: TurndownService | undefined;
function turndown(): TurndownService {
  if (td) return td;
  td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**', br: '  ' });
  return td;
}

const MAX_CHARS = 100_000;

const ENTITY = /&(gt|lt|amp|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;

/**
 * Our own output: no markup, and no entity other than the `&lt;` written for a "<" before a letter
 * (turndown writes & and > literally). Entity-encoded HTML ("&lt;h2&gt;") always carries &gt;.
 */
function isOwnOutput(s: string): boolean {
  return !REAL_MARKUP.test(s) && !ENTITY.test(s.replace(/&lt;/g, ''));
}

/**
 * HTML or plain text → Markdown, through the keep-list. Idempotent: cleaning its own output again
 * changes nothing (adapters may clean, and `jobs scan` always does). Anything that would read as an
 * HTML tag in the result (`<img`, `</x`, `<!`) is written as `&lt;` so no renderer can turn ad text
 * back into markup.
 */
/** Cloudflare's email obfuscation: hex where the first byte XORs the rest. null when it does not decode to an address. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(out) ? out : null;
}

/** Replaces Cloudflare-protected addresses ("[email protected]" links) with the address itself, before
 *  attributes are dropped (I1: a quarter of itpro.lk ads hid their apply address this way). */
function revealCfEmails(html: string): string {
  if (!/cfemail|email-protection/i.test(html)) return html;
  return html.replace(/<a\b[^>]*?(?:data-cfemail=["']([0-9a-f]+)["']|email-protection#([0-9a-f]+))[^>]*>[\s\S]*?<\/a>/gi, (whole, a?: string, b?: string) => {
    const email = decodeCfEmail(a ?? b ?? '');
    return email ?? whole;
  }).replace(/<span\b[^>]*data-cfemail=["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/span>/gi, (whole, h: string) => decodeCfEmail(h) ?? whole);
}

export function cleanDescription(htmlOrText: string | null | undefined): string {
  const input = revealCfEmails((htmlOrText ?? '').replace(/\u0000/g, ''));
  if (!input.trim()) return '';
  let md: string;
  const decoded = REAL_MARKUP.test(input) || isOwnOutput(input) ? input : decodeEntitiesOnce(input);
  if (!REAL_MARKUP.test(decoded)) {
    // Plain text (or our own output): kept as written. Entities left after one decode (text escaped
    // twice or more) are decoded too; the "<" escaping below keeps any markup they spell out inert.
    let text = decoded;
    for (let i = 0; i < 3 && ENTITY.test(text.replace(/&lt;(?=[a-zA-Z/!?])/g, '')); i++) text = decodeEntitiesOnce(text);
    md = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  } else {
    md = turndown().turndown(cleanHtml(decoded));
  }
  md = md
    .replace(/<(?=[a-zA-Z/!?])/g, '&lt;')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md.length > MAX_CHARS ? md.slice(0, MAX_CHARS) : md;
}

// ---------------------------------------------------------------- requirements excerpt

const REQ_HEAD = /(requirements?|qualifications?|what you('ll)? need|what we('re| are)? looking for|who (you are|we are looking for)|skills( required| needed| and experience)?|eligibility|must have|key competenc|experience( required)?|essential|you (will )?have|candidate profile|job specification|the ideal candidate|criteria)/i;
const END_HEAD = /(benefits|what we offer|we offer|perks|about (us|the company)|how to apply|application|salary|remuneration|closing date|contact)/i;

interface Section {
  head: string;
  body: string[];
}

function sections(md: string): Section[] {
  const out: Section[] = [{ head: '', body: [] }];
  for (const line of md.split('\n')) {
    const t = line.trim();
    // A heading: "## x", or a short bold line "**Requirements**", or a short line ending in ":".
    const isHead =
      /^#{1,6}\s/.test(t) ||
      /^\*\*[^*]{2,80}\*\*:?$/.test(t) ||
      (/^[^-*\d].{1,60}:$/.test(t) && !/[.!?]/.test(t.slice(0, -1))) ||
      // A bare short line that is itself a section name ("Requirements", "Benefits"), common in plain-text ads.
      (t.length <= 40 && /^[A-Za-z][A-Za-z '&/()-]*$/.test(t) && (REQ_HEAD.test(t) || END_HEAD.test(t)) && t.split(' ').length <= 5);
    if (isHead) out.push({ head: t.replace(/^#+\s*|\*\*|:$/g, '').trim(), body: [line] });
    else out[out.length - 1].body.push(line);
  }
  return out;
}

function cut(text: string, maxChars: number): string {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const nl = slice.lastIndexOf('\n');
  return (nl > maxChars * 0.6 ? slice.slice(0, nl) : slice).trimEnd();
}

/**
 * The requirements / qualifications part of a Markdown description, at most `maxChars`, for LLM
 * scoring (PRD §5.3). Starts at the first requirements-like heading and runs until a benefits /
 * how-to-apply heading. With no such heading, the start of the description.
 */
export function requirementsExcerpt(markdown: string | null | undefined, maxChars = 1500): string {
  const md = (markdown ?? '').trim();
  if (!md) return '';
  const secs = sections(md);
  const start = secs.findIndex((s) => s.head && REQ_HEAD.test(s.head) && !END_HEAD.test(s.head));
  if (start < 0) return cut(md, maxChars);
  const picked: string[] = [];
  for (let i = start; i < secs.length; i++) {
    if (i > start && secs[i].head && END_HEAD.test(secs[i].head) && !REQ_HEAD.test(secs[i].head)) break;
    picked.push(secs[i].body.join('\n'));
    if (picked.join('\n').length >= maxChars) break;
  }
  return cut(picked.join('\n'), maxChars);
}
