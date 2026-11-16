import { z } from 'zod';
import type { Context } from './context.ts';
import { SljError, type ErrorCode } from './errors.ts';

export interface Command<S extends z.ZodObject = z.ZodObject> {
  /** Dotted name: "jobs.fetch" is `slj jobs fetch` on the CLI and `jobs_fetch` over MCP. */
  name: string;
  summary: string;
  /** What this command changes, in the words of the PRD tool contract. null = read-only. */
  sideEffect: string | null;
  input: S;
  /** Field filled by the first bare CLI argument, e.g. `slj jobs get <id>`. */
  positional?: keyof z.infer<S> & string;
  run(input: z.infer<S>, ctx: Context): unknown | Promise<unknown>;
  /** Optional human-readable rendering for the CLI without --json. */
  format?(data: any): string;
  /** A successful run whose result still means "not OK", e.g. doctor finding problems. Sets exit code 1. */
  isFailure?(data: any): boolean;
}

export function defineCommand<S extends z.ZodObject>(c: Command<S>): Command<S> {
  return c;
}

export type Envelope =
  | { ok: true; command: string; data: unknown }
  | { ok: false; command: string; error: { code: ErrorCode; message: string; details?: unknown } };

export function toolName(command: Command): string {
  return command.name.replaceAll('.', '_');
}

export function inputJsonSchema(command: Command): Record<string, unknown> {
  const schema = z.toJSONSchema(command.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/**
 * The one execution path. The CLI and the MCP server both call this, so validation,
 * errors and audit logging cannot drift between them.
 */
export async function execute(command: Command, rawInput: unknown, ctx: Context): Promise<Envelope> {
  const parsed = command.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      command: command.name,
      error: { code: 'INVALID_INPUT', message: z.prettifyError(parsed.error), details: z.flattenError(parsed.error) },
    };
  }
  let envelope: Envelope;
  try {
    const data = await command.run(parsed.data, ctx);
    envelope = { ok: true, command: command.name, data };
  } catch (err) {
    const e =
      err instanceof SljError
        ? { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) }
        : { code: 'INTERNAL' as const, message: (err as Error)?.message ?? String(err) };
    envelope = { ok: false, command: command.name, error: e };
  }
  if (command.sideEffect) audit(ctx, command, envelope);
  return envelope;
}

function audit(ctx: Context, command: Command, envelope: Envelope): void {
  try {
    const summary = envelope.ok ? summarize(envelope.data) : `${envelope.error.code}: ${envelope.error.message}`;
    ctx
      .db()
      .prepare('INSERT INTO audit (at, command, driver, ok, summary) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.now().toISOString(), command.name, ctx.driver, envelope.ok ? 1 : 0, summary.slice(0, 500));
  } catch {
    // Auditing must never turn a successful command into a failure.
  }
}

/** Keep only top-level scalars so personal data in results never lands in the audit log. */
function summarize(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const scalars = Object.entries(data).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean');
  return JSON.stringify(Object.fromEntries(scalars));
}
