/**
 * Text fallbacks shared by the S5 adapters. They only fill fields a structured value left null,
 * and an unclear value stays null (PRD §7.2 rules 9 and 11).
 */
import { htmlToText } from '../../jobs/extract.ts';
import { parseDate } from '../../jobs/normalize.ts';

const CLOSING_LABEL =
  /(?:apply\s+(?:before|by|on\s+or\s+before)|closing\s+date(?:\s+for\s+applications)?|applications?\s+close(?:s|\s+on)?|deadline(?:\s+to\s+apply)?|last\s+date(?:\s+to\s+apply)?)\s*[:\-–]?\s*/i;

/** The one closing date an ad's text states ("Apply before: 30 November 2026"), else null. */
export function closingDateFromText(htmlOrText: string | null | undefined): string | null {
  if (!htmlOrText) return null;
  const text = /<[a-z!/]/i.test(htmlOrText) ? htmlToText(htmlOrText) : htmlOrText;
  const found = new Set<string>();
  const re = new RegExp(CLOSING_LABEL.source, 'gi');
  for (const m of text.matchAll(re)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/^(?:[a-z]{3,9}day|[a-z]{3}),?\s+/i, '');
    const d = parseDate(rest);
    if (d) found.add(d);
  }
  // Two different dates under closing labels is ambiguous: null, not a guess.
  return found.size === 1 ? [...found][0] : null;
}

/** YYYY-MM-DD for `now` in Sri Lanka time (UTC+05:30). */
export function todayLk(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
