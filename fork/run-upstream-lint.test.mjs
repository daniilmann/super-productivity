import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SKIPPED_TOOL_TESTS, lintSteps } from './run-upstream-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

void test('upstream lint chain is kept; only the listed tool tests are skipped', () => {
  /** @type {unknown} */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkg === 'object' && pkg !== null && 'scripts' in pkg,
    'package.json must contain scripts',
  );
  const { scripts } = pkg;
  assert.ok(typeof scripts === 'object' && scripts !== null, 'scripts must be an object');
  assert.ok(
    'lint' in scripts && typeof scripts.lint === 'string',
    'the upstream lint command must exist',
  );
  assert.ok(
    'test:tools' in scripts && typeof scripts['test:tools'] === 'string',
    'the upstream tool test command must exist',
  );
  const steps = lintSteps(scripts);
  assert.equal(steps.length, scripts.lint.split('&&').length);
  const tools = steps.find((s) => s.startsWith('node --test'));
  assert.ok(tools, 'the upstream lint chain must include the tool test command');
  for (const f of SKIPPED_TOOL_TESTS) assert.ok(!tools.includes(f), f);
  const kept = scripts['test:tools']
    .split(' ')
    .filter((w) => w.endsWith('.test.js')).length;
  assert.equal(
    tools.split(' ').filter((w) => w.endsWith('.test.js')).length,
    kept - SKIPPED_TOOL_TESTS.length,
  );
});
