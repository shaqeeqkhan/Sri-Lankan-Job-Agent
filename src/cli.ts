import fs from 'node:fs';
import YAML from 'yaml';
import { commands, findCommand } from './commands/index.ts';
import { createContext, type Context } from './context.ts';
import { execute, inputJsonSchema, type Command, type Envelope } from './registry.ts';

const VERSION = '0.1.0';

type FlagKind = 'boolean' | 'number' | 'string' | 'array';
interface Flag {
  field: string;
  kind: FlagKind;
  description?: string;
  choices?: string[];
}

function kindOf(prop: any): { kind: FlagKind; choices?: string[] } {
  const variants: any[] = prop.anyOf ?? prop.oneOf ?? [prop];
  const real = variants.find((v) => v.type && v.type !== 'null') ?? prop;
  if (real.type === 'boolean') return { kind: 'boolean' };
  if (real.type === 'number' || real.type === 'integer') return { kind: 'number' };
  if (real.type === 'array') return { kind: 'array' };
  return { kind: 'string', choices: real.enum };
}

/** CLI flags come from the command's JSON Schema, so they always match the MCP tool's input. */
export function flagsFor(command: Command): Map<string, Flag> {
  const schema = inputJsonSchema(command) as { properties?: Record<string, any> };
  const flags = new Map<string, Flag>();
  for (const [field, prop] of Object.entries(schema.properties ?? {})) {
    const flag = { field, description: prop.description, ...kindOf(prop) };
    flags.set(field.replaceAll('_', '-'), flag);
    flags.set(field, flag);
  }
  return flags;
}

class UsageError extends Error {}

function coerce(flag: Flag, name: string, raw: string): unknown {
  if (flag.kind === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--${name} needs a number, got "${raw}"`);
    return n;
  }
  if (flag.kind === 'boolean') {
    if (/^(true|1|yes)$/i.test(raw)) return true;
    if (/^(false|0|no)$/i.test(raw)) return false;
    throw new UsageError(`--${name} is true or false, got "${raw}"`);
  }
  return raw;
}

export interface ParsedArgs {
  command?: Command;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
  version: boolean;
  mcp: boolean;
  inputJson?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { input: {}, json: false, help: false, version: false, mcp: false };
  const words: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--input') out.inputJson = argv[++i] ?? '';
    else if (a.startsWith('--input=')) out.inputJson = a.slice('--input='.length);
    else if (a.startsWith('-') && a !== '-') {
      rest.push(a);
      // A following non-flag token is this flag's value; booleans decide below.
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) rest.push(argv[++i]);
    } else if (rest.length === 0 && !out.command) words.push(a);
    else rest.push(a);
  }

  if (words[0] === 'mcp') {
    out.mcp = true;
    return out;
  }
  if (words[0] === 'help') {
    out.help = true;
    words.shift();
  }

  // Longest run of words that names a command: `jobs get <id>` -> jobs.get + positional.
  for (let n = words.length; n > 0 && !out.command; n--) {
    const c = findCommand(words.slice(0, n).join('.'));
    if (c) {
      out.command = c;
      rest.unshift(...words.slice(n));
    }
  }
  if (!out.command) {
    if (words.length) throw new UsageError(`Unknown command "${words.join(' ')}". Run \`slj help\` for the list.`);
    return out;
  }

  const flags = flagsFor(out.command);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) {
      const pos = out.command.positional;
      if (!pos || pos in out.input) throw new UsageError(`Unexpected argument "${tok}".`);
      out.input[pos] = tok;
      continue;
    }
    let [name, value] = tok.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    let negated = false;
    if (!flags.has(name) && name.startsWith('no-') && flags.get(name.slice(3))?.kind === 'boolean') {
      name = name.slice(3);
      negated = true;
    }
    const flag = flags.get(name);
    if (!flag) {
      const known = [...new Set([...flags.keys()].filter((k) => k.includes('-') || !k.includes('_')))];
      throw new UsageError(`Unknown option --${name} for \`slj ${out.command.name.replace('.', ' ')}\`. Options: ${known.map((k) => `--${k}`).join(' ') || '(none)'}`);
    }
    if (flag.kind === 'boolean') {
      // `--flag false` takes the literal; any other bare word after a boolean is a positional.
      if (value === undefined && /^(true|false|1|0|yes|no)$/i.test(rest[i + 1] ?? '')) value = rest[++i];
      const v = value === undefined ? true : coerce(flag, name, value);
      out.input[flag.field] = negated ? !v : v;
      continue;
    }
    if (value === undefined) {
      value = rest[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    }
    if (flag.kind === 'array') {
      const list = (out.input[flag.field] as string[] | undefined) ?? [];
      list.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
      out.input[flag.field] = list;
    } else {
      out.input[flag.field] = coerce(flag, name, value);
    }
  }
  return out;
}

function readInputJson(raw: string): Record<string, unknown> {
  const text = raw === '-' ? fs.readFileSync(0, 'utf8') : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--input must be a JSON object, or "-" to read one from stdin.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('--input must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function helpText(command?: Command): string {
  if (!command) {
    const width = Math.max(...commands.map((c) => c.name.length)) + 1;
    return [
      `slj ${VERSION}: SriLankanJobs Agent tools`,
      '',
      'Usage: slj <command> [options] [--json]',
      '',
      ...commands.map((c) => `  ${c.name.split('.').join(' ').padEnd(width)} ${c.summary.split('. ')[0]}`),
      `  ${'mcp'.padEnd(width)} Start the MCP server on stdio`,
      '',
      'Every command accepts --json (machine output) and --input <json> (all options as one JSON object).',
      'Run `slj <command> --help` for its options.',
    ].join('\n');
  }
  const flags = [...flagsFor(command).entries()].filter(([name, f]) => name !== f.field || !f.field.includes('_'));
  return [
    `slj ${command.name.split('.').join(' ')}${command.positional ? ` <${command.positional}>` : ''}`,
    '',
    command.summary,
    command.sideEffect ? `Side effect: ${command.sideEffect}` : 'Read-only.',
    '',
    'Options:',
    ...flags.map(([name, f]) => {
      const type = f.choices ? f.choices.join('|') : f.kind;
      return `  --${name.padEnd(22)} ${type.padEnd(10)} ${f.description ?? ''}`.trimEnd();
    }),
    '  --json                   Print the JSON result envelope',
  ].join('\n');
}

function print(envelope: Envelope, command: Command, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (envelope.ok) {
    process.stdout.write(`${command.format ? command.format(envelope.data) : YAML.stringify(envelope.data).trimEnd()}\n`);
  } else {
    const { code, message, details } = envelope.error;
    process.stderr.write(`Error [${code}]: ${message}\n`);
    if (details !== undefined && code !== 'INVALID_INPUT') process.stderr.write(`${YAML.stringify(details).trimEnd()}\n`);
  }
}

export async function main(argv: string[], ctx?: Context): Promise<number> {
  let args: ParsedArgs;
  const wantsJson = argv.includes('--json');
  try {
    args = parseArgs(argv);
    if (args.inputJson !== undefined) args.input = { ...readInputJson(args.inputJson), ...args.input };
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, command: null, error: { code: 'INVALID_INPUT', message: err.message } }, null, 2)}\n`);
    } else process.stderr.write(`${err.message}\n`);
    return 2;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.mcp) {
    const { serveStdio } = await import('./mcp.ts');
    await serveStdio();
    return -1; // keep running
  }
  if (args.help || !args.command) {
    process.stdout.write(`${helpText(args.command)}\n`);
    return 0;
  }

  const context = ctx ?? createContext();
  try {
    const envelope = await execute(args.command, args.input, context);
    print(envelope, args.command, args.json);
    if (!envelope.ok) return envelope.error.code === 'INVALID_INPUT' ? 2 : 1;
    return args.command.isFailure?.(envelope.data) ? 1 : 0;
  } finally {
    if (!ctx) context.close();
  }
}
