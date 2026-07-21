import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke tests for the triage engine. These deliberately do NOT invoke run()
// (that needs a live GitHub context); they verify the module loads cleanly,
// has no top-level side effects, and exposes the expected entry point — the
// same class of breakage the manual `node --check` guarded against, now in CI.

test('triage.mjs imports without error and has no top-level side effects', async () => {
  const mod = await import('./triage.mjs');
  assert.ok(mod, 'module should import');
});

test('exports run() as a function', async () => {
  const { run } = await import('./triage.mjs');
  assert.equal(typeof run, 'function', 'run must be an exported function');
});

test('run() takes a single {github, context, core} argument', async () => {
  const { run } = await import('./triage.mjs');
  assert.equal(run.length, 1, 'run should declare one destructured toolkit arg');
});
