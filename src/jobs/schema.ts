import { z } from 'zod';

export const APPLY_METHODS = ['email', 'portal', 'form', 'phone', 'post', 'unknown'] as const;
export const ApplyMethod = z.enum(APPLY_METHODS);
export type ApplyMethod = z.infer<typeof ApplyMethod>;

/** Platform values that are not adapters: where the ad came from when no portal is involved. */
export const NON_ADAPTER_PLATFORMS = ['email', 'social', 'newspaper', 'other'] as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);

/** Fields that describe a job. Shared by the scrapers, `jobs add` and the store. */
export const JobFields = z.object({
  title: text(300),
  company: text(200).nullish(),
  location: text(200).nullish(),
  category: text(100).nullish(),
  salary_text: text(200).nullish(),
  description: z.string().max(100_000).nullish(),
  closing_date: IsoDate.nullish(),
  apply_method: ApplyMethod.nullish(),
  apply_url: z.url({ protocol: /^https?$/ }).nullish(),
  apply_email: z.email().nullish(),
  apply_phone: text(40).nullish(),
  apply_instructions: text(2000).nullish(),
  subject_instruction: text(500).nullish(),
  required_docs: z.array(text(100)).max(30).nullish(),
  is_image_ad: z.boolean().nullish(),
  posted_at: z.string().max(40).nullish(),
  /** The site's own posting id (from the URL or the API), stable across scans. Identity tier 1. */
  external_id: text(200).nullish(),
  /** ISO 3166-1 alpha-2, e.g. "LK". */
  country_code: z.string().regex(/^[A-Z]{2}$/, 'use a 2-letter country code').nullish(),
  remote: z.boolean().nullish(),
  employment_type: text(60).nullish(),
  /** ISO time the scraper read the posting. */
  scraped_at: z.string().max(40).nullish(),
});
export type JobFields = z.infer<typeof JobFields>;

export interface JobRow {
  id: string;
  source: string;
  source_url: string | null;
  platform: string;
  title: string;
  company: string | null;
  location: string | null;
  category: string | null;
  salary_text: string | null;
  description: string | null;
  closing_date: string | null;
  apply_method: ApplyMethod;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  apply_instructions: string | null;
  subject_instruction: string | null;
  required_docs: string;
  is_image_ad: number;
  image_path: string | null;
  needs_review: number;
  review_reasons: string;
  posted_at: string | null;
  fetched_at: string;
  updated_at: string;
  hash: string;
  // migration 2
  external_id: string | null;
  country_code: string | null;
  remote: number | null;
  employment_type: string | null;
  scraped_at: string | null;
  district: string | null;
  identity_t1: string | null;
  identity_t1b: string | null;
  identity_t2: string | null;
  closed_at: string | null;
  closed_reason: string | null;
}
