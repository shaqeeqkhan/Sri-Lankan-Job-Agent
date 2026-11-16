import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { commands } from '../src/commands/index.ts';
import { createMcpServer } from '../src/mcp.ts';
import { toolName } from '../src/registry.ts';
import { makeCtx, ROOT, tempDir } from './helpers.ts';

async function connect(ctx = makeCtx()) {
  const server = createMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { client, ctx };
}

const envelope = (r: any) => JSON.parse(r.content[0].text);

test('MCP lists exactly the registry commands, each with an object schema', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), commands.map(toolName).sort());
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description && t.description.length > 20, t.name);
  }
  const add = tools.find((t) => t.name === 'jobs_add')!;
  assert.ok('apply_email' in (add.inputSchema.properties ?? {}));
  assert.equal(tools.find((t) => t.name === 'jobs_list')!.annotations?.readOnlyHint, true);
  assert.equal(add.annotations?.readOnlyHint, false);
});

test('MCP tool calls return the same envelope as the CLI', async () => {
  const { client } = await connect();
  const added = await client.callTool({ name: 'jobs_add', arguments: { title: 'Assistant Accountant', company: 'Lanka Biscuit Works', apply_email: 'careers@lankabiscuit.example' } });
  assert.equal(added.isError, false);
  assert.equal(envelope(added).data.outcome, 'inserted');
  assert.deepEqual(added.structuredContent, envelope(added));

  const list = envelope(await client.callTool({ name: 'jobs_list', arguments: { apply_method: 'email' } }));
  assert.equal(list.ok, true);
  assert.equal(list.data.total, 1);

  const bad = await client.callTool({ name: 'jobs_list', arguments: { limit: 'lots' } });
  assert.equal(bad.isError, true);
  assert.equal(envelope(bad).error.code, 'INVALID_INPUT');

  const unknown = await client.callTool({ name: 'apply_send', arguments: {} });
  assert.equal(envelope(unknown).error.code, 'UNKNOWN_COMMAND');
});

test('MCP over real stdio, and the CLI, give identical data for the same input', async () => {
  const home = tempDir();
  const env = { PATH: process.env.PATH!, SLJ_HOME: home };
  const cli = (args: string[]) =>
    JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'bin/slj.mjs'), ...args, '--json'], { env, encoding: 'utf8' }).stdout);
  for (const [title, company] of [['Data Analyst', 'Serendib Analytics'], ['Teller', 'HNB'], ['Driver', 'Ceylon Transport']]) {
    assert.equal(cli(['jobs', 'add', '--title', title, '--company', company]).data.outcome, 'inserted');
  }

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/slj.mjs'), 'mcp'], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    const input = { include_closed: true, sort: 'newest' as const };
    const viaMcp = envelope(await client.callTool({ name: 'jobs_list', arguments: input }));
    const viaCli = cli(['jobs', 'list', '--include-closed', '--sort', 'newest']);
    assert.deepEqual(viaMcp, viaCli);
    assert.equal(viaMcp.data.total, 3);
  } finally {
    await client.close();
  }
});
