/**
 * jobsnet.lk: no job site (checked 2026-11-15). https fails with a self-signed certificate; http serves
 * a stock "Success! Your new web server is ready to use." page. www.jobsnet.lk does not resolve.
 *
 * No parsing is written for this source: there was no job board to read on 2026-11-15. If the site comes
 * back, write src/sources/jobsnet/parse.ts against the live pages and fixtures, then enable it in
 * config/sources.yml.
 */
import { SljError } from '../../errors.ts';
import type { SourceAdapter } from '../types.ts';

const REASON = 'jobsnet.lk has no job site: it serves a blank "new web server" page. Checked 2026-11-15.';

const adapter: SourceAdapter = {
  id: 'jobsnet',
  async scan() {
    throw new SljError('FETCH_FAILED', `jobsnet: ${REASON}`, { source: 'jobsnet', checked: '2026-11-15' });
  },
  async recheck() {
    return 'unknown';
  },
};

export default adapter;
