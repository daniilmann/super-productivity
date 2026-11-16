import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SKIPPED_TOOL_TESTS, lintSteps } from './run-upstream-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('upstream lint chain is kept; only the listed tool tests are skipped', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const steps = lintSteps(scripts);
  assert.equal(steps.length, scripts.lint.split('&&').length);
  const tools = steps.find((s) => s.startsWith('node --test'));
  for (const f of SKIPPED_TOOL_TESTS) assert.ok(!tools.includes(f), f);
  const kept = scripts['test:tools'].split(' ').filter((w) => w.endsWith('.test.js')).length;
  assert.equal(tools.split(' ').filter((w) => w.endsWith('.test.js')).length, kept - SKIPPED_TOOL_TESTS.length);
});
