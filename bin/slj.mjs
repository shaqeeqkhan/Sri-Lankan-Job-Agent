#!/usr/bin/env node
// Entry point for `slj`. Node runs the TypeScript sources directly (type stripping, Node >= 22.18).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`slj needs Node 22.18 or newer; this is Node ${process.versions.node}.`);
  process.exit(1);
}
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.error(w);
});
const { main } = await import('../src/cli.ts');
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
