import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { defineCommand, type Command } from '../registry.ts';
import { sourceConfigs } from '../sources/load.ts';
import { latestTopJobIds, parseSinceDays, runRecheck, runScan, type ScanReport } from '../sources/scan.ts';
import { readHistory, readStatus, type ScanStatusFile } from '../sources/status.ts';

// ---------------------------------------------------------------- jobs scan

export const jobsScan = defineCommand({
  name: 'jobs.scan',
  summary:
    'Scan the job sites in config/sources.yml through the fallback ladder, dedupe, and store new jobs. ' +
    'Returns per-source status (ok, degraded:<tier>, blocked, stale-cache, partial) and counts. ' +
    'With no option it runs the normal (fast) sources. --slow runs ONLY the sources marked slow in sources.yml (employer ATS boards, the P2 boards, governmentjobs.lk): ' +
    'the "more jobs" widening step, run after a normal scan. --all runs both. --sources a,b runs exactly the named ones.',
  sideEffect: 'Writes jobs, user/scan_status.json, user/scan_history.jsonl',
  input: z.object({
    sources: z.array(z.string().max(40)).max(50).optional().describe('Only these source ids (comma-separated on the CLI). Named sources run even if slow or disabled.'),
    since: z.string().max(10).optional().describe('Skip jobs posted before this many days ago, e.g. 14d (default settings.scan.since_days).'),
    slow: z.boolean().default(false).describe('Run only the slow sources (employer ATS boards, P2 boards, governmentjobs.lk), after a normal scan. Does not re-run the normal ones.'),
    all: z.boolean().default(false).describe('Run the normal and the slow sources together.'),
  }),
  async run(input, ctx) {
    if (input.sources?.length && (input.slow || input.all)) {
      throw new SljError('INVALID_INPUT', '--sources names the sources to run; do not combine it with --slow or --all.');
    }
    const report = await runScan(ctx, {
      sources: input.sources, sinceDays: parseSinceDays(input.since), slowOnly: input.slow, includeSlow: input.all,
    });
    if (report.all_failed) {
      throw new SljError('SCAN_FAILED', `Every source failed: ${report.failed_sources.join(', ')}. Run \`slj sources doctor\` for details.`, report);
    }
    return report;
  },
  format: (d: ScanReport) =>
    [
      `Scanned ${d.sources.length} source(s) in ${d.duration_s}s: ${d.totals.inserted} new, ${d.totals.merged} merged; ${d.open_jobs} open jobs.`,
      ...d.sources.map(
        (s) =>
          `  ${s.id.padEnd(16)} ${s.status.padEnd(12)} ${String(s.listed).padStart(5)} listed ${String(s.inserted).padStart(4)} new` +
          `${s.deferred ? `  ${s.deferred} deferred` : ''}${s.held_back ? `  ${s.held_back} held back` : ''}` +
          `${s.truncated ? `  stopped early (${s.truncated_reason === 'time' ? 'time budget' : 'max_details'}), ${s.truncated_left} left for next scan` : ''}` +
          `${s.low ? '  LOW' : ''}${s.error ? `  (${s.error})` : ''}`,
      ),
      ...(d.not_run.filter((n) => n.reason === 'slow').length
        ? [`  not run (slow; \`--slow\` runs only these, \`--all\` runs everything): ${d.not_run.filter((n) => n.reason === 'slow').map((n) => n.id).join(', ')}`]
        : []),
    ].join('\n'),
});

// ---------------------------------------------------------------- jobs recheck

export const jobsRecheck = defineCommand({
  name: 'jobs.recheck',
  summary:
    'Check whether a few jobs are still open before showing them: --top for the jobs on the latest page of today\'s top report (the 20 being shown), or --ids. ' +
    'Ambiguous means alive: a job is closed only when its closing date has passed or the site itself says it is closed.',
  sideEffect: 'Marks closed jobs',
  input: z.object({
    top: z.boolean().default(false).describe('Recheck the jobs on the latest page of today\'s top report for the current CV.'),
    ids: z.array(z.string().min(1).max(40)).max(100).optional().describe('Job ids to recheck (comma-separated on the CLI).'),
  }),
  async run(input, ctx) {
    let ids = input.ids ?? [];
    if (input.top) ids = [...new Set([...latestTopJobIds(ctx), ...ids])];
    if (!input.top && !ids.length) throw new SljError('INVALID_INPUT', 'Pass --top or --ids a,b.');
    if (!ids.length) throw new SljError('NOT_FOUND', 'There is no top report today for the current CV. Run `slj top` first, or pass --ids.');
    return runRecheck(ctx, ids);
  },
  format: (d) =>
    [
      `Rechecked ${d.checked}; ${d.closed} closed.`,
      ...d.rows.map((r: any) => `  ${r.id}  ${r.liveness.padEnd(7)} ${r.title}${r.closed ? `  (${r.reason})` : ''}`),
    ].join('\n'),
});

// ---------------------------------------------------------------- sources doctor

function adviceFor(s: ScanStatusFile['sources'][string] | undefined): string {
  if (!s) return 'Not scanned yet.';
  if (s.status === 'blocked') {
    return s.challenge
      ? 'The site showed a human check and the scan could not get past it. Leave it alone for a few hours. For a job you need now, open it yourself and use jobs add --html, or paste the ad.'
      : `The site refused automated reading${s.http_status ? ` (HTTP ${s.http_status})` : ''}. Try again later; for a job you need now, paste the ad.`;
  }
  if (s.status === 'partial') return `The source failed: ${s.error ?? 'unknown error'}. If this repeats, its parser is probably out of date: run \`slj sources doctor --report\` and file an issue.`;
  if (s.status === 'stale-cache') return `The site could not be loaded; results come from the last good copy${s.stale_age_s != null ? `, ${Math.round(s.stale_age_s / 3600)} h old` : ''}.`;
  if (s.status.startsWith('degraded:')) return `Worked, but needed ${s.status.slice(9)} (a browser tier), so it is slower and may ask for a human check.`;
  if (s.low) return 'Listed far fewer jobs than it usually does. Treat it as broken (the site layout probably changed), not as a quiet day.';
  return 'OK.';
}

function truncText(s: { truncated: boolean; truncated_reason: string | null; truncated_left: number }): string {
  if (!s.truncated) return 'no';
  const why = s.truncated_reason === 'time' ? 'time budget' : s.truncated_reason === 'max_details' ? 'max_details' : 'stopped early';
  return `${why}, ${s.truncated_left} left`;
}

function scrub(text: string, ctx: Context): string {
  let t = text;
  for (const p of [ctx.paths.userDir, os.homedir()]) if (p) t = t.split(p).join('~');
  return t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

function version(ctx: Context): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(ctx.paths.root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
}

export const sourcesDoctor = defineCommand({
  name: 'sources.doctor',
  summary:
    'How each job source did in recent scans: status, tier, counts, low intake, and what to do. ' +
    '--report prints a pasteable issue body (no personal data) for a broken source.',
  sideEffect: null,
  input: z.object({
    report: z.boolean().default(false).describe('Also return a Markdown issue body to paste into a bug report.'),
    source: z.string().max(40).optional().describe('Only this source id.'),
  }),
  run(input, ctx) {
    const status = readStatus(ctx);
    const history = readHistory(ctx);
    let configs = sourceConfigs(ctx.config());
    if (input.source) {
      configs = configs.filter((c) => c.id === input.source);
      if (!configs.length) throw new SljError('NOT_FOUND', `No source "${input.source}" in config/sources.yml.`);
    }
    const sources = configs.map((c) => {
      const last = status?.sources[c.id];
      const runs = history.filter((h) => h.sources?.[c.id]);
      return {
        id: c.id,
        name: c.name,
        enabled: c.enabled,
        slow: c.slow,
        tiers: c.tiers,
        last_status: last?.status ?? null,
        last_run_at: last?.finished_at ?? null,
        tier: last?.tier ?? null,
        listed: last?.listed ?? null,
        jobs: last?.jobs ?? null,
        deferred: last?.deferred ?? null,
        low: last?.low ?? false,
        /** What to show people: the status, or `low` when an ok-looking run listed far fewer jobs than usual. */
        display_status: last ? (last.low && !last.failed ? (last.status === 'ok' ? 'low' : `${last.status}, low`) : last.status) : null,
        truncated: last?.truncated ?? false,
        truncated_reason: last?.truncated ? (last.truncated_reason ?? null) : null,
        truncated_left: last?.truncated ? (last.truncated_left ?? 0) : 0,
        error: last?.error ? scrub(last.error, ctx) : null,
        runs_in_history: runs.length,
        recent_listed: runs.slice(-7).map((h) => h.sources[c.id].listed),
        advice: adviceFor(last),
      };
    });
    const problems = sources.filter((s) => s.last_status && (s.last_status !== 'ok' || s.low)).length;
    const data: Record<string, unknown> = {
      status_file: !!status,
      last_scan_at: status?.updated_at ?? null,
      last_result: status?.last_result ?? null,
      problems,
      sources,
    };
    if (input.report) {
      const shown = input.source ? sources : sources.filter((s) => s.last_status && (s.last_status !== 'ok' || s.low));
      const rows = (shown.length ? shown : sources.filter((s) => s.last_status)).map(
        (s) => `| ${s.id} | ${s.display_status ?? '-'} | ${s.tier ?? '-'} | ${s.listed ?? '-'} | ${s.jobs ?? '-'} | ${s.deferred ?? '-'} | ${s.low ? 'yes' : 'no'} | ${truncText(s)} | ${s.recent_listed.join(', ') || '-'} | ${(s.error ?? '').replace(/\|/g, '/')} |`,
      );
      data.report = [
        `### Source problem: ${shown.map((s) => s.id).join(', ') || 'none found'}`,
        '',
        `- slj ${version(ctx)}, Node ${process.version}, ${process.platform}`,
        `- Last scan: ${status?.updated_at ?? 'never'} (${status?.last_result ?? '-'})`,
        '',
        '| Source | Status | Tier | Listed | Jobs | Deferred | Low | Truncated | Recent listed | Error |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...(rows.length ? rows : ['| - | no scan recorded | | | | | | | | |']),
        '',
        '_Generated by `slj sources doctor --report`. Contains no personal data: no CV, profile, job list or file paths._',
      ].join('\n');
    }
    return data;
  },
  format: (d) =>
    [
      d.status_file ? `Last scan ${d.last_scan_at} (${d.last_result}); ${d.problems} source(s) need attention.` : 'No scan has been recorded yet. Run `slj jobs scan`.',
      ...d.sources.map(
        (s: any) =>
          `  ${s.id.padEnd(16)} ${(s.display_status ?? '-').padEnd(12)} ${s.enabled ? '' : '(disabled) '}${s.slow ? '(slow) ' : ''}${s.advice}` +
          (s.truncated ? ` Stopped early last scan (${truncText(s)}).` : ''),
      ),
      ...(d.report ? ['', d.report] : []),
    ].join('\n'),
});

/** Registered in src/commands/index.ts. `jobs scan` and `jobs recheck` live here so index.ts stays frozen. */
export const sourcesCommands: Command[] = [jobsScan, jobsRecheck, sourcesDoctor] as Command[];
