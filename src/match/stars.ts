import type { Settings } from '../config.ts';

export type StarBands = Settings['stars'];

/** The PRD §5.3 bands, used when no settings are passed. config/settings.yml is the real source. */
export const DEFAULT_BANDS: StarBands = { five: 85, four: 70, three: 55, two: 40 };

/** Stars (1–5) from rubric points (0–100) on the absolute scale. The only place stars are derived. */
export function starsFromPoints(points: number, bands: StarBands = DEFAULT_BANDS): 1 | 2 | 3 | 4 | 5 {
  if (points >= bands.five) return 5;
  if (points >= bands.four) return 4;
  if (points >= bands.three) return 3;
  if (points >= bands.two) return 2;
  return 1;
}

/** ★★★★☆ */
export function renderStars(n: number): string {
  const k = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}
