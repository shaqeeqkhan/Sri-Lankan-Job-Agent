import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/cli.ts';
import { ROOT, tempDir } from './helpers.ts';

const home = tempDir();

function slj(args: string[], input?: string) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/slj.mjs'), ...args], {
    env: { PATH: process.env.PATH, SLJ_HOME: home },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(input ?? '');
  return new Promise<{ code: number | null; stdout: string; stderr: string; json: () => any }>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) })),
  );
}

test('slj jobs add --json returns the envelope and exit 0', async () => {
  for (const [title, company, email] of [['Assistant Accountant', 'Lanka Biscuit Works', 'careers@lankabiscuit.example'], ['Driver', 'Ceylon Transport', 'hr@ceylontransport.example']]) {
    const r = await slj(['jobs', 'add', '--title', title, '--company', company, '--apply-email', email, '--json']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const env = r.json();
    assert.equal(env.ok, true);
    assert.equal(env.command, 'jobs.add');
    assert.equal(env.data.outcome, 'inserted');
  }
});

test('kebab-case flags, booleans and positionals', async () => {
  const list = (await slj(['jobs', 'list', '--q', 'driver', '--apply-method', 'email', '--include-closed', '--limit', '5', '--json'])).json();
  assert.equal(list.data.total, 1);
  const id = list.data.jobs[0].id;
  const got = (await slj(['jobs', 'get', id, '--json'])).json();
  assert.equal(got.data.id, id);
  const neg = (await slj(['jobs', 'list', '--no-include-closed', '--json'])).json();
  assert.equal(neg.ok, true);
});

test('--input takes a JSON object, from an argument or stdin', async () => {
  const r = await slj(['jobs', 'add', '--input', '-', '--json'], JSON.stringify({ title: 'Cashier', company: 'Arpico', required_docs: ['CV'] }));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().data.job.required_docs, ['CV']);
  const flags = (await slj(['jobs', 'add', '--title', 'Teller', '--company', 'HNB', '--required-docs', 'CV,Photo', '--json'])).json();
  assert.deepEqual(flags.data.job.required_docs, ['CV', 'Photo']);
});

test('exit codes: 2 for bad input, 1 for a failed command, 0 for help', async () => {
  assert.equal((await slj(['jobs', 'list', '--limit', 'ten'])).code, 2);
  assert.equal((await slj(['jobs', 'list', '--colour', 'red'])).code, 2);
  assert.equal((await slj(['jobs', 'list', '--limit', '9999', '--json'])).code, 2);
  assert.equal((await slj(['nonsense'])).code, 2);
  const missing = await slj(['jobs', 'get', 'jnope', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
  const human = await slj(['jobs', 'get', 'jnope']);
  assert.match(human.stderr, /Error \[NOT_FOUND\]/);
  assert.equal((await slj(['help'])).code, 0);
  assert.match((await slj(['jobs', 'add', '--help'])).stdout, /--apply-email/);
});

test('usage errors are JSON too when --json is passed', async () => {
  const r = await slj(['jobs', 'list', '--colour', 'red', '--json']);
  assert.equal(r.json().ok, false);
  assert.equal(r.json().error.code, 'INVALID_INPUT');
});

test('human output without --json', async () => {
  const r = await slj(['jobs', 'list']);
  assert.match(r.stdout, /job\(s\)/);
  const doc = await slj(['doctor', '--offline']);
  assert.equal(doc.code, 0, doc.stdout);
  assert.match(doc.stdout, /Ready\./);
});

test('parseArgs maps words to the longest matching command', () => {
  assert.equal(parseArgs(['jobs', 'get', 'j1']).command?.name, 'jobs.get');
  assert.equal(parseArgs(['jobs', 'get', 'j1']).input.id, 'j1');
  assert.equal(parseArgs(['jobs', 'list', '--include-closed', 'false']).input.include_closed, false);
  assert.equal(parseArgs(['jobs', 'list', '--include_closed']).input.include_closed, true);
  assert.equal(parseArgs(['mcp']).mcp, true);
});
