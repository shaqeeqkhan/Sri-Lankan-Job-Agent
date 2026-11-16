/// <reference lib="dom" />
/**
 * browser.ts — tiers T2 and T3 of the fetch ladder (docs/PRD-v2-resume-to-jobs.md §7.3).
 *
 * Use this for a job site that blocks plain HTTP: it renders the page in a
 * real Chrome, and when the site shows a human check (Cloudflare, reCAPTCHA,
 * hCaptcha, Turnstile, DataDome, PerimeterX) it opens a visible window and
 * hands the check to the person. It never solves a check itself.
 *
 * robots.txt is deliberately NOT consulted here (owner's decision, 15 Nov 2026).
 * Pacing still is: one page at a time, 2–5 s apart per host by default.
 *
 * How it works
 *   1. Pages load headless in a persistent profile (user/browser-profile), so
 *      cookies — including a solved check's clearance cookie — survive between
 *      scans.
 *   2. A page that looks like a human check closes the headless browser and
 *      reopens the SAME profile in a visible window. Often the check passes on
 *      its own there. If not, the person gets a clear message, a beep, and up
 *      to `humanTimeoutMs` to complete it. The script notices by itself when
 *      the check is gone; nobody has to press Enter (an AI agent's terminal
 *      usually has no keyboard).
 *   3. After a solved check, the rest of that host's pages in this run stay in
 *      the visible window: a clearance cookie is tied to the browser that
 *      earned it, and a headless browser presents differently.
 *   4. More than `maxChallengesPerHost` checks on one host in one run stops
 *      that host, with the reason. Pushing on is what turns a check into a ban.
 *
 * Output (CLI): one JSON object per URL on stdout (NDJSON). Human-facing
 * messages go to stderr, and the current state is mirrored to
 * user/browser-status.json so an agent can read it and tell the person.
 *
 *   node src/sources/browser.ts --url https://www.topjobs.lk/... [--url ...]
 *       [--urls-file list.txt] [--wait-for "css selector"] [--scroll 3]
 *       [--headed] [--out dir] [--profile dir] [--human-timeout 240]
 *
 * Exit codes: 0 at least one page fetched, 3 every page blocked, 2 bad input,
 * 4 no browser could be started (Playwright or Chrome missing).
 *
 * Needs: `npm i playwright` (or playwright-core). Uses the installed Chrome or
 * Edge first; only if neither exists, run `npx playwright install chromium`.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { SljError } from '../errors.ts';

// ── Types ────────────────────────────────────────────────────────────────────

// Kept structural so the file type-checks whether `playwright` or
// `playwright-core` is the installed package.
interface PwPage {
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate<T>(fn: (() => T) | string): Promise<T>;
  waitForSelector(sel: string, opts: { timeout: number; state: 'attached' }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  unrouteAll(): Promise<void>;
}
interface PwRoute {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
  close(): Promise<void>;
}
interface PwChromium {
  launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext>;
}

export type BlockReason = 'challenge' | 'http' | 'login' | 'timeout' | 'gave_up' | 'error';

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number | null;
  ok: boolean;
  blocked: BlockReason | null;
  /** Which kind of human check was seen, if any. */
  challenge: string | null;
  /** True when the person completed a check for this page or an earlier one on the host. */
  humanSolved: boolean;
  mode: 'headless' | 'headed';
  title: string;
  html: string;
  /** Every parsed JSON-LD object on the page, @graph flattened. Filter for JobPosting yourself. */
  jsonLd: unknown[];
  error: string | null;
  fetchedAt: string;
}

export interface BrowserFetchOptions {
  /** Persistent browser profile. Default: $SLJ_HOME/browser-profile or ./user/browser-profile. */
  profileDir?: string;
  /** Start in a visible window. Default false. */
  headed?: boolean;
  /** Per-host gap between page loads, randomised in [min, max]. Default 2000–5000 ms. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** CSS selector that means the real content has loaded (e.g. a job-card class). */
  waitFor?: string;
  /** Scroll passes for lists that load more on scroll. Default 0. */
  scroll?: number;
  /** Navigation timeout per page. Default 45 s. */
  navTimeoutMs?: number;
  /** How long to wait for the person to finish a check. Default 240 s. */
  humanTimeoutMs?: number;
  /** Checks allowed per host per run before that host is stopped. Default 2. */
  maxChallengesPerHost?: number;
  /** Skip images, fonts and media while headless and unchallenged. Default true. */
  lightweight?: boolean;
  /** Where the live state is mirrored for the agent. Default: <user>/browser-status.json. */
  statusFile?: string;
  /** Human-facing messages. Default: stderr. */
  log?: (msg: string) => void;
}

/** Per-page options for `fetchOne`. */
export interface FetchCallOptions {
  waitFor?: string;
  scroll?: number;
  /** false: never open a visible window for a check; return it as blocked. Default true. */
  handoff?: boolean;
  /** true: load in the visible window from the start. */
  headed?: boolean;
}
interface LoadOptions {
  waitFor?: string;
  scroll?: number;
}

// ── Challenge detection ──────────────────────────────────────────────────────

/** What a challenge check needs to see of a page: its title, visible text and a selector test. */
export interface ChallengeProbe {
  title: string;
  text: string;
  has(selector: string): boolean;
}

/**
 * The one list of human-check markers, shared by the in-page detector (T2/T3)
 * and the HTML-string detector the fetch ladder runs on plain-HTTP pages (T1).
 * Rules are tried in order. A rule matches when any selector, the title pattern
 * or the text pattern hits; a `thin` rule also needs a near-empty page.
 *
 * A reCAPTCHA or hCaptcha widget only counts on a near-empty page, because
 * ordinary pages embed them on contact and apply forms, and calling those a
 * "check" would stop a good scan.
 */
export const CHALLENGE_MARKERS = {
  thinChars: 2500,
  rules: [
    {
      kind: 'cloudflare',
      selectors: ['#challenge-form', '#cf-challenge-running', '#challenge-stage', '.cf-browser-verification', 'iframe[src*="challenges.cloudflare.com"]'],
      title: 'just a moment|attention required.*cloudflare',
    },
    { kind: 'turnstile', selectors: ['.cf-turnstile', 'iframe[src*="turnstile"]'], thin: true },
    { kind: 'datadome', selectors: ['iframe[src*="captcha-delivery.com"]', 'iframe[src*="geo.captcha-delivery"]'] },
    { kind: 'perimeterx', selectors: ['#px-captcha', 'iframe[src*="px-cloud.net"]'] },
    {
      kind: 'generic',
      title: 'ddos-guard|checking your browser|verify you are (a )?human|are you a robot|security check',
      text: 'verify you are (a )?human|press (and|&) hold|enable javascript and cookies to continue',
    },
    { kind: 'recaptcha', selectors: ['iframe[src*="recaptcha/api2/anchor"]', 'iframe[src*="recaptcha/enterprise/anchor"]', '.g-recaptcha'], thin: true },
    { kind: 'hcaptcha', selectors: ['iframe[src*="hcaptcha.com"]', '.h-captcha'], thin: true },
  ],
} as const;

type ChallengeMarkers = {
  thinChars: number;
  rules: readonly { kind: string; selectors?: readonly string[]; title?: string; text?: string; thin?: boolean }[];
};

/**
 * Returns the kind of human check a page shows, or null.
 * Self-contained on purpose (no outer references): its source is also sent into
 * the browser page, so the same logic runs on both sides.
 */
export function classifyChallenge(p: ChallengeProbe, m: ChallengeMarkers = CHALLENGE_MARKERS): string | null {
  const title = (p.title || '').toLowerCase();
  const text = (p.text || '').slice(0, 4000).toLowerCase();
  for (const r of m.rules) {
    const hit = (r.selectors || []).some((s) => p.has(s))
      || (r.title ? new RegExp(r.title).test(title) : false)
      || (r.text ? new RegExp(r.text).test(text) : false);
    if (hit && (!r.thin || text.length < m.thinChars)) return r.kind;
  }
  return null;
}

/** The in-page detector: an expression for `page.evaluate`, built from the same function and list. */
const IN_PAGE_DETECT = `(() => {
  const classify = ${classifyChallenge.toString()};
  return classify({
    title: document.title || '',
    text: (document.body && document.body.innerText) || '',
    has: (s) => { try { return document.querySelector(s) !== null; } catch (e) { return false; } },
  }, ${JSON.stringify(CHALLENGE_MARKERS)});
})()`;

/** The same detector on an HTML string (plain-HTTP pages, fixtures). */
export function detectChallengeInHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const title = $('title').first().text();
  $('script, style, noscript, template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return classifyChallenge({
    title,
    text,
    has: (s) => {
      try {
        return $(s).length > 0;
      } catch {
        return false;
      }
    },
  });
}

/** Runs inside the page. Every JSON-LD block, parsed, with @graph flattened. */
export function readJsonLdInPage(): unknown[] {
  const out: unknown[] = [];
  for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data: unknown = JSON.parse(el.textContent || 'null');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const graph = item && typeof item === 'object' ? (item as Record<string, unknown>)['@graph'] : undefined;
        if (Array.isArray(graph)) out.push(...graph);
        else if (item) out.push(item);
      }
    } catch {
      // A broken block on someone else's site is not our error.
    }
  }
  return out;
}

const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|account\/login|users\/sign_in)(\/|\?|$)/i;

// ── The fetcher ──────────────────────────────────────────────────────────────

const CHALLENGE_CONS = [
  'Before you carry on, the trade-offs:',
  '  • The site has noticed automated traffic from your connection. Every further scan',
  '    makes a harder check, or an outright block, more likely.',
  '  • A block lands on your internet connection (home, office or mobile data), so it can',
  '    also lock out other people who share it, often for hours or days.',
  '  • If you are signed in to this site in this window, your account can be flagged too.',
  '  • Results from this site may be incomplete; the last good scan fills the gaps.',
  'Recommended: let this scan finish, then leave this site alone for a few hours.',
].join('\n');

export class BrowserFetcher {
  private readonly opts: Required<Omit<BrowserFetchOptions, 'waitFor' | 'log'>> & Pick<BrowserFetchOptions, 'waitFor'>;
  private readonly log: (msg: string) => void;
  private chromium: PwChromium | null = null;
  private ctx: PwContext | null = null;
  private mode: 'headless' | 'headed';
  private readonly nextAllowed = new Map<string, number>();
  private readonly challenges = new Map<string, number>();
  private readonly solvedHosts = new Set<string>();
  private readonly stoppedHosts = new Set<string>();

  constructor(options: BrowserFetchOptions = {}) {
    const userDir = path.resolve(process.env.SLJ_HOME ?? path.join(process.cwd(), 'user'));
    this.opts = {
      profileDir: options.profileDir ?? path.join(userDir, 'browser-profile'),
      headed: options.headed ?? false,
      minDelayMs: options.minDelayMs ?? 2000,
      maxDelayMs: options.maxDelayMs ?? 5000,
      waitFor: options.waitFor,
      scroll: options.scroll ?? 0,
      navTimeoutMs: options.navTimeoutMs ?? 45_000,
      humanTimeoutMs: options.humanTimeoutMs ?? 240_000,
      maxChallengesPerHost: options.maxChallengesPerHost ?? 2,
      lightweight: options.lightweight ?? true,
      statusFile: options.statusFile ?? path.join(userDir, 'browser-status.json'),
    };
    this.log = options.log ?? ((m) => process.stderr.write(m + '\n'));
    this.mode = this.opts.headed ? 'headed' : 'headless';
  }

  /** Fetch URLs one at a time, in order. Never throws for a single bad page (see fetchOne). */
  async fetchAll(urls: string[]): Promise<FetchResult[]> {
    const results: FetchResult[] = [];
    try {
      for (const url of urls) results.push(await this.fetchOne(url));
    } finally {
      await this.close();
      this.setStatus({ state: 'idle' });
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  /**
   * Fetch one page. Never throws for a bad page; throws SljError('BROWSER_UNAVAILABLE')
   * only when no browser can be started at all (Playwright or Chrome missing).
   * Per-call options override the constructor's `waitFor` / `scroll`.
   * `handoff: false` returns a challenge as blocked instead of opening a visible window (T2 without T3).
   * `headed: true` loads this page in the visible window from the start (T3 only).
   */
  async fetchOne(url: string, call: FetchCallOptions = {}): Promise<FetchResult> {
    const per: LoadOptions = { waitFor: call.waitFor ?? this.opts.waitFor, scroll: call.scroll ?? this.opts.scroll };
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      return this.result(url, { blocked: 'error', error: 'Not a valid URL.' });
    }
    if (this.stoppedHosts.has(host)) {
      return this.result(url, {
        blocked: 'gave_up',
        error: `${host} was stopped earlier in this run after repeated human checks.`,
      });
    }

    // A host whose check was solved stays in the window that solved it.
    const wantHeaded = this.opts.headed || call.headed || this.solvedHosts.has(host);
    if (wantHeaded && this.mode === 'headless') await this.switchMode('headed');
    // A visible window opened for another host's check (solved or not) is not kept for this one.
    else if (!wantHeaded && this.mode === 'headed') await this.switchMode('headless');

    await this.pace(host);

    let page: PwPage | null = null;
    try {
      page = await this.openPage();
      const first = await this.load(page, url, per);
      if (first.blocked !== 'challenge') return first;
      if (call.handoff === false) return first;

      // ── A human check. Try the visible window, then the person. ──
      const count = (this.challenges.get(host) ?? 0) + 1;
      this.challenges.set(host, count);
      if (count > this.opts.maxChallengesPerHost) {
        this.stoppedHosts.add(host);
        this.log(
          `\n⛔ ${host} asked for a human check ${count} times in this scan, so I've stopped scanning it.\n`
          + 'Pushing on from here is what turns checks into a block on your connection.\n'
          + 'Try this site again in a few hours; earlier results stay available meanwhile.\n',
        );
        this.setStatus({ state: 'gave_up', host, url, reason: 'too_many_checks' });
        return { ...first, blocked: 'gave_up', error: 'Too many human checks on this host in one run.' };
      }

      await page.close().catch(() => {});
      page = null;
      if (this.mode === 'headless') await this.switchMode('headed');
      page = await this.openPage();
      const second = await this.load(page, url, per);
      if (second.blocked !== 'challenge') {
        this.solvedHosts.add(host);
        return { ...second, humanSolved: false };
      }

      return await this.waitForHuman(page, url, host, second.challenge ?? 'generic', per);
    } catch (err) {
      if (err instanceof SljError && err.code === 'BROWSER_UNAVAILABLE') throw err;
      return this.result(url, { blocked: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // ── internals ──

  private async waitForHuman(page: PwPage, url: string, host: string, kind: string, per: LoadOptions): Promise<FetchResult> {
    const seconds = Math.round(this.opts.humanTimeoutMs / 1000);
    const deadline = Date.now() + this.opts.humanTimeoutMs;
    this.setStatus({
      state: 'waiting_for_human', host, url, challenge: kind,
      deadline: new Date(deadline).toISOString(),
      message: `Complete the human check for ${host} in the browser window that just opened.`,
    });
    this.log(
      '\x07\n────────────────────────────────────────────────────────────\n'
      + `ACTION NEEDED: ${host} wants you to prove you're a person (${kind}).\n`
      + 'A Chrome window has opened. Complete the check there: tick the box or solve the puzzle.\n'
      + `Leave the window open. The scan carries on by itself once the page loads (waiting up to ${seconds}s).\n\n`
      + CHALLENGE_CONS
      + '\n────────────────────────────────────────────────────────────\n',
    );
    await page.bringToFront().catch(() => {});

    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      let still: string | null;
      try {
        still = await page.evaluate<string | null>(IN_PAGE_DETECT);
      } catch {
        // Mid-navigation after the check passes; look again next tick.
        continue;
      }
      if (still) continue;

      // The check is gone. Let the real page settle, then read it.
      if (per.waitFor) {
        await page.waitForSelector(per.waitFor, { timeout: 15_000, state: 'attached' }).catch(() => {});
      }
      await page.waitForTimeout(1500);
      this.solvedHosts.add(host);
      this.setStatus({ state: 'running', host, note: 'human check completed' });
      this.log(`✅ Thanks, ${host} let us through. Continuing the scan.\n`);
      const read = await this.read(page, url, null);
      return { ...read, humanSolved: true };
    }

    this.setStatus({ state: 'gave_up', host, url, reason: 'human_timeout' });
    this.log(`⌛ No check was completed for ${host} within ${seconds}s. Skipping it for this scan.\n`);
    return this.result(url, { blocked: 'challenge', challenge: kind, error: 'Human check not completed in time.' });
  }

  private async load(page: PwPage, url: string, per: LoadOptions): Promise<FetchResult> {
    let status: number | null = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
      status = resp ? resp.status() : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.result(url, { blocked: /timeout/i.test(msg) ? 'timeout' : 'error', error: msg });
    }

    // Challenge pages often redirect to themselves; give them a moment to show.
    await page.waitForTimeout(1200);
    const challenge = await page.evaluate<string | null>(IN_PAGE_DETECT).catch(() => null);
    if (challenge) return this.result(url, { status, blocked: 'challenge', challenge, finalUrl: page.url() });

    if (per.waitFor) {
      await page.waitForSelector(per.waitFor, { timeout: 15_000, state: 'attached' }).catch(() => {});
    }
    for (let i = 0; i < (per.scroll ?? 0); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1200 + Math.random() * 800);
    }
    return this.read(page, url, status);
  }

  private async read(page: PwPage, url: string, status: number | null): Promise<FetchResult> {
    const finalUrl = page.url();
    const [title, html, jsonLd] = await Promise.all([
      page.title().catch(() => ''),
      page.content().catch(() => ''),
      page.evaluate(readJsonLdInPage).catch(() => [] as unknown[]),
    ]);

    let blocked: BlockReason | null = null;
    let error: string | null = null;
    if (!LOGIN_PATH.test(new URL(url).pathname) && LOGIN_PATH.test(new URL(finalUrl).pathname)) {
      blocked = 'login';
      error = 'The site redirected to a sign-in page. slj never signs in for the person.';
    } else if (status !== null && status >= 400) {
      blocked = 'http';
      error = `HTTP ${status}`;
    }
    return this.result(url, { status, finalUrl, title, html, jsonLd, blocked, error });
  }

  private async openPage(): Promise<PwPage> {
    const ctx = await this.context();
    const page = await ctx.newPage();
    if (this.mode === 'headless' && this.opts.lightweight) {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        return type === 'image' || type === 'font' || type === 'media' ? route.abort() : route.continue();
      });
    }
    return page;
  }

  private async context(): Promise<PwContext> {
    if (this.ctx) return this.ctx;
    const chromium = await this.loadChromium();
    mkdirSync(this.opts.profileDir, { recursive: true });
    const headless = this.mode === 'headless';
    const base = {
      headless,
      locale: 'en-US',
      timezoneId: 'Asia/Colombo',
      // A visible window uses its own size; headless gets a laptop-sized one.
      viewport: headless ? { width: 1366, height: 900 } : null,
      args: headless ? [] : ['--start-maximized'],
    };
    const errors: string[] = [];
    // The person's own Chrome or Edge first: no 150 MB download, and a real browser build.
    for (const channel of ['chrome', 'msedge', undefined]) {
      try {
        this.ctx = await chromium.launchPersistentContext(this.opts.profileDir, channel ? { ...base, channel } : base);
        // A persistent context opens with one blank tab; keep it out of the way.
        for (const p of this.ctx.pages()) await p.close().catch(() => {});
        return this.ctx;
      } catch (err) {
        errors.push(`${channel ?? 'bundled chromium'}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    throw new SljError(
      'BROWSER_UNAVAILABLE',
      'Could not start a browser. Install Google Chrome, or run `npx playwright install chromium`.\n'
      + errors.join('\n'),
      { errors },
    );
  }

  private async switchMode(mode: 'headless' | 'headed'): Promise<void> {
    if (this.mode === mode) return;
    await this.close(); // a profile can be open in only one browser at a time
    this.mode = mode;
  }

  private async loadChromium(): Promise<PwChromium> {
    if (this.chromium) return this.chromium;
    for (const name of ['playwright', 'playwright-core']) {
      try {
        const mod = (await import(name)) as { chromium?: PwChromium; default?: { chromium?: PwChromium } };
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (chromium) return (this.chromium = chromium);
      } catch {
        // try the next package name
      }
    }
    throw new SljError('BROWSER_UNAVAILABLE', 'Playwright is not installed. Run `npm i playwright` in the project folder.');
  }

  /** Per-host pacing with jitter. Unrelated hosts never wait on each other. */
  private async pace(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAllowed.get(host) ?? 0);
    const { minDelayMs: lo, maxDelayMs: hi } = this.opts;
    this.nextAllowed.set(host, at + lo + Math.random() * Math.max(0, hi - lo));
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  private result(url: string, part: Partial<FetchResult>): FetchResult {
    const blocked = part.blocked ?? null;
    return {
      url,
      finalUrl: part.finalUrl ?? url,
      status: part.status ?? null,
      ok: blocked === null,
      blocked,
      challenge: part.challenge ?? null,
      humanSolved: part.humanSolved ?? false,
      mode: this.mode,
      title: part.title ?? '',
      html: part.html ?? '',
      jsonLd: part.jsonLd ?? [],
      error: part.error ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  private setStatus(status: Record<string, unknown>): void {
    try {
      mkdirSync(path.dirname(this.opts.statusFile), { recursive: true });
      writeFileSync(this.opts.statusFile, JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2));
    } catch {
      // The status file is a convenience for the agent; never fail a scan over it.
    }
  }
}

/** Convenience wrapper: fetch URLs with one fetcher and close it. */
export async function browserFetch(urls: string[], options?: BrowserFetchOptions): Promise<FetchResult[]> {
  return new BrowserFetcher(options).fetchAll(urls);
}

/** JobPosting objects from a page's JSON-LD (the T0 structured-data path). */
export function jobPostings(jsonLd: unknown[]): Record<string, unknown>[] {
  return jsonLd.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false;
    const t = (item as Record<string, unknown>)['@type'];
    return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { urls: string[]; out: string | null; opts: BrowserFetchOptions } {
  const urls: string[] = [];
  const opts: BrowserFetchOptions = {};
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--url': urls.push(next()); break;
      case '--urls-file':
        urls.push(...readFileSync(next(), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
        break;
      case '--wait-for': opts.waitFor = next(); break;
      case '--scroll': opts.scroll = Number(next()); break;
      case '--headed': opts.headed = true; break;
      case '--profile': opts.profileDir = path.resolve(next()); break;
      case '--human-timeout': opts.humanTimeoutMs = Number(next()) * 1000; break;
      case '--out': out = path.resolve(next()); break;
      case '--help': case '-h':
        process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
        process.exit(0);
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  if (!urls.length) throw new Error('Give at least one --url or --urls-file.');
  return { urls, out, opts };
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\nRun with --help for usage.\n`);
    process.exit(2);
  }
  const { urls, out, opts } = parsed;
  if (out) mkdirSync(out, { recursive: true });

  const fetcher = new BrowserFetcher(opts);
  let okCount = 0;
  try {
    for (const [i, url] of urls.entries()) {
      const r = await fetcher.fetchOne(url);
      if (r.ok) okCount++;
      if (out) {
        const file = path.join(out, `${String(i + 1).padStart(3, '0')}-${new URL(r.finalUrl).host}.html`);
        if (r.html) writeFileSync(file, r.html);
        const { html: _html, ...rest } = r;
        const line = JSON.stringify({ ...rest, htmlFile: r.html ? file : null });
        process.stdout.write(line + '\n');
        appendFileSync(path.join(out, 'results.ndjson'), line + '\n');
      } else {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
    }
  } catch (err) {
    if (!(err instanceof SljError && err.code === 'BROWSER_UNAVAILABLE')) throw err;
    process.stderr.write(`${err.message}\n`);
    await fetcher.close();
    process.exit(4);
  } finally {
    await fetcher.close();
  }
  process.stderr.write(`Fetched ${okCount} of ${urls.length} page(s).\n`);
  process.exit(okCount > 0 ? 0 : 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  void main();
}
