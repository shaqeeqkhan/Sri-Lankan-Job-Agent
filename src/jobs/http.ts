import { SljError } from '../errors.ts';

export const USER_AGENT = 'SriLankanJobsAgent/0.2 (+https://srilankanjobs.lk/agent)';

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export async function fetchPage(fetchFn: typeof fetch, url: URL): Promise<{ html: string; finalUrl: string; contentType: string }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
  } catch (err) {
    throw new SljError('FETCH_FAILED', `Could not open ${url.host}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new SljError('FETCH_FAILED', `${url.host} returned HTTP ${res.status}.`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!/text\/|xhtml|xml/.test(contentType)) {
    throw new SljError('FETCH_FAILED', `The link is a ${contentType || 'non-HTML'} file. Download it and use --file instead.`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PAGE_BYTES) throw new SljError('FETCH_FAILED', 'The page is larger than 3 MB.');
  return { html: new TextDecoder().decode(buf), finalUrl: res.url || url.toString(), contentType };
}
