/**
 * jobber.lk: unreachable (checked 2026-11-15). The domain resolves to Cloudflare, but https and http
 * both answer "error code: 522" (Cloudflare cannot reach the origin server), on three tries.
 *
 * No parsing is written for this source: there was no job board to read on 2026-11-15. If the site comes
 * back, write src/sources/jobber/parse.ts against the live pages and fixtures, then enable it in
 * config/sources.yml.
 */
import { SljError } from '../../errors.ts';
import type { SourceAdapter } from '../types.ts';

const REASON = 'jobber.lk is down: Cloudflare error 522 (origin server not reachable) on every try. Checked 2026-11-15.';

const adapter: SourceAdapter = {
  id: 'jobber',
  async scan() {
    throw new SljError('FETCH_FAILED', `jobber: ${REASON}`, { source: 'jobber', checked: '2026-11-15' });
  },
  async recheck() {
    return 'unknown';
  },
};

export default adapter;
