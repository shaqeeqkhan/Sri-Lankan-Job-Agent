/**
 * cache.ts — on-disk page cache for the fetch ladder (PRD §7.3).
 *
 * One JSON file per URL under `user/cache/<source>/<sha256(url)[0:32]>.json`, holding
 * the html, final URL, status, tier and fetched_at. The same store serves two purposes:
 *   - fresh hits: listing pages for 6 h, detail pages for 24 h (settings.scan.*_cache_hours);
 *   - T5 "last good": any age, returned with that age so the result can be marked stale.
 * Only good pages are written, so a block never overwrites the last good copy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Tier } from './types.ts';

export interface CachedPage {
  url: string;
  finalUrl: string;
  status: number | null;
  html: string;
  tier: Tier;
  fetched_at: string;
}

export interface PageCacheOptions {
  /** user/cache (the source id is appended). */
  cacheDir: string;
  source: string;
  now: () => Date;
  listingTtlHours?: number;
  detailTtlHours?: number;
}

export interface PageCache {
  dir: string;
  /** A copy younger than the TTL for `kind` (default listing, the shorter one), or null. */
  fresh(url: string, kind?: 'listing' | 'detail'): CachedPage | null;
  /** The last good copy at any age, with its age in seconds, or null. */
  lastGood(url: string): { page: CachedPage; ageS: number } | null;
  put(page: Omit<CachedPage, 'fetched_at'> & { fetched_at?: string }): void;
}

export function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export function createPageCache(opts: PageCacheOptions): PageCache {
  const dir = path.join(opts.cacheDir, opts.source.replace(/[^a-z0-9_-]/gi, '_'));
  const ttlMs = {
    listing: (opts.listingTtlHours ?? 6) * 3_600_000,
    detail: (opts.detailTtlHours ?? 24) * 3_600_000,
  };
  const file = (url: string) => path.join(dir, `${cacheKey(url)}.json`);

  function read(url: string): CachedPage | null {
    try {
      const data = JSON.parse(fs.readFileSync(file(url), 'utf8')) as CachedPage;
      if (data.url !== url || typeof data.html !== 'string' || typeof data.fetched_at !== 'string') return null;
      return data;
    } catch {
      return null; // missing or corrupt: a cache miss, never an error
    }
  }
  const ageMs = (p: CachedPage) => opts.now().getTime() - Date.parse(p.fetched_at);

  return {
    dir,
    fresh(url, kind = 'listing') {
      const p = read(url);
      if (!p) return null;
      const age = ageMs(p);
      return age >= 0 && age < ttlMs[kind] ? p : null;
    },
    lastGood(url) {
      const p = read(url);
      return p ? { page: p, ageS: Math.max(0, Math.round(ageMs(p) / 1000)) } : null;
    },
    put(page) {
      const data: CachedPage = { ...page, fetched_at: page.fetched_at ?? opts.now().toISOString() };
      try {
        fs.mkdirSync(dir, { recursive: true });
        const target = file(page.url);
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, target);
      } catch {
        // A full disk must not fail a scan; the page was still fetched.
      }
    },
  };
}
