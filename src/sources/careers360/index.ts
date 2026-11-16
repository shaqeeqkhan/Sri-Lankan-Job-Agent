/**
 * careers360.lk: not a job board (checked 2026-11-15). Every path, including /jobs and /sitemap.xml,
 * serves the same "Hotjobs | Coming Soon" page that redirects to https://www.hotjobs.lk, which has its own
 * adapter (hotjobs).
 *
 * No parsing is written for this source: there was no job board to read on 2026-11-15. If the site comes
 * back, write src/sources/careers360/parse.ts against the live pages and fixtures, then enable it in
 * config/sources.yml.
 */
import { SljError } from '../../errors.ts';
import type { SourceAdapter } from '../types.ts';

const REASON = 'careers360.lk is not a job board: every page redirects to hotjobs.lk (scanned by the hotjobs source). Checked 2026-11-15.';

const adapter: SourceAdapter = {
  id: 'careers360',
  async scan() {
    throw new SljError('FETCH_FAILED', `careers360: ${REASON}`, { source: 'careers360', checked: '2026-11-15' });
  },
  async recheck() {
    return 'unknown';
  },
};

export default adapter;
