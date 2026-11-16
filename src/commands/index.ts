import { z } from 'zod';
import { defineCommand, inputJsonSchema, toolName, type Command } from '../registry.ts';
import { boardsCommands } from './boards.ts';
import { cvCommands } from './cv.ts';
import { doctor } from './doctor.ts';
import { jobsAdd, jobsGet, jobsList } from './jobs.ts';
import { matchCommands } from './match.ts';
import { resumeCommands } from './resume.ts';
import { sourcesCommands } from './sources.ts';

const listCommands = defineCommand({
  name: 'commands',
  summary: 'List every slj command with its CLI form, MCP tool name, side effect and JSON input schema.',
  sideEffect: null,
  input: z.object({}),
  run: () => ({
    commands: commands.map((c) => ({
      name: c.name,
      cli: `slj ${c.name.split('.').join(' ')}`,
      tool: toolName(c),
      summary: c.summary,
      side_effect: c.sideEffect,
      input_schema: inputJsonSchema(c),
    })),
  }),
  format: (d) => d.commands.map((c: any) => `${c.cli.padEnd(22)} ${c.summary}`).join('\n'),
});

/** The single command registry. The CLI and the MCP server are both generated from this list. */
export const commands: Command[] = [
  doctor,
  jobsAdd,
  jobsList,
  jobsGet,
  ...resumeCommands,
  ...sourcesCommands,
  ...boardsCommands,
  ...matchCommands,
  ...cvCommands,
  listCommands,
] as Command[];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name || toolName(c) === name);
}
