#!/usr/bin/env node
// Runs the upstream `npm run lint` chain from package.json, unchanged, except that the
// `test:tools` step skips the upstream tests that read upstream workflows the fork removed
// (see FORK.md, "Changes to upstream files", row 1).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const SKIPPED_TOOL_TESTS = [
  // reads .github/workflows/build-create-windows-store-on-release.yml
  'tools/verify-appx-config.test.js',
  // reads .github/workflows/build.yml
  'tools/verify-windows-artifact-contract.test.js',
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} scripts @returns {string[]} */
export function lintSteps(scripts) {
  if (
    !isRecord(scripts) ||
    typeof scripts.lint !== 'string' ||
    typeof scripts['test:tools'] !== 'string'
  ) {
    throw new Error('upstream scripts must contain lint and test:tools strings');
  }
  const toolScript = scripts['test:tools'];
  const steps = scripts.lint.split('&&').map((s) => s.trim());
  if (!steps.includes('npm run test:tools'))
    throw new Error('upstream lint no longer runs test:tools');
  return steps.map((step) => {
    if (step !== 'npm run test:tools') return step;
    let tools = toolScript;
    for (const f of SKIPPED_TOOL_TESTS) {
      if (!tools.includes(` ${f}`)) throw new Error(`test:tools no longer lists ${f}`);
      tools = tools.replace(` ${f}`, '');
    }
    return tools;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of SKIPPED_TOOL_TESTS) {
    if (!existsSync(f))
      throw new Error(`${f} is gone upstream; drop it from the skip list`);
  }
  /** @type {unknown} */
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!isRecord(metadata)) throw new Error('package.json must contain an object');
  for (const step of lintSteps(metadata.scripts)) {
    console.log(`$ ${step}`);
    execSync(step, { stdio: 'inherit' });
  }
}
