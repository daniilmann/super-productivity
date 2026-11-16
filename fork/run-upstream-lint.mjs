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

export function lintSteps(scripts) {
  const steps = scripts.lint.split('&&').map((s) => s.trim());
  if (!steps.includes('npm run test:tools')) throw new Error('upstream lint no longer runs test:tools');
  return steps.map((step) => {
    if (step !== 'npm run test:tools') return step;
    let tools = scripts['test:tools'];
    for (const f of SKIPPED_TOOL_TESTS) {
      if (!tools.includes(` ${f}`)) throw new Error(`test:tools no longer lists ${f}`);
      tools = tools.replace(` ${f}`, '');
    }
    return tools;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of SKIPPED_TOOL_TESTS) {
    if (!existsSync(f)) throw new Error(`${f} is gone upstream; drop it from the skip list`);
  }
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const step of lintSteps(scripts)) {
    console.log(`$ ${step}`);
    execSync(step, { stdio: 'inherit' });
  }
}
