import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkWebSpecs } from './release-route.mjs';

const titlelessForkSpecs = [
  'src/app/plugins/save-confirmation/testing/save-state.fixtures.fork.spec.ts',
  'src/app/plugins/util/testing/plugin-iframe-save-confirmation.fixtures.fork.spec.ts',
];
const forkSuiteSpec = 'src/app/plugins/save-confirmation/save-state.service.fork.spec.ts';
const iframeSuiteSpec =
  'src/app/plugins/util/plugin-iframe.save-confirmation.fork.spec.ts';
const appJs = 'const fixture = "Application";';
const appBytes = Buffer.byteLength(appJs);
const cleanBrowserStats = {
  inputs: { 'src/main.ts': { bytes: appBytes, imports: [] } },
  outputs: {
    'main.js': {
      bytes: appBytes,
      entryPoint: 'src/main.ts',
      exports: [],
      imports: [],
      inputs: { 'src/main.ts': { bytesInOutput: appBytes } },
    },
  },
};
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

/** @param {string} checkout @param {...string} args */
function git(checkout, ...args) {
  execFileSync('git', args, { cwd: checkout, env: gitEnv, stdio: 'pipe' });
}

/** @param {string} file @param {string | Buffer} content */
function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** @param {import('node:test').TestContext} t @param {...string} specs */
function webBuild(t, ...specs) {
  const checkout = mkdtempSync(join(tmpdir(), 'fork-release-web-specs-'));
  t.after(() => {
    rmSync(checkout, { recursive: true, force: true });
  });
  const out = join(checkout, 'build');
  const statsFile = join(checkout, 'browser-stats.json');
  put(join(checkout, 'src/main.ts'), appJs);
  put(join(out, 'main.js'), appJs);
  git(checkout, 'init', '--quiet');
  for (const spec of specs) {
    put(join(checkout, spec), readFileSync(new URL(`../${spec}`, import.meta.url)));
  }
  git(checkout, 'add', '--', ...specs);
  return { checkout, out, statsFile };
}

void test('accepts a clean production graph when both tracked fork helpers have no suite title', (t) => {
  const { checkout, out, statsFile } = webBuild(t, forkSuiteSpec, ...titlelessForkSpecs);
  writeFileSync(statsFile, JSON.stringify(cleanBrowserStats));

  assert.doesNotThrow(() => {
    checkWebSpecs(checkout, out, statsFile);
  });
});

for (const [label, spec] of [
  ['titleless fork helper', titlelessForkSpecs[0]],
  ['fork Angular suite source', forkSuiteSpec],
]) {
  void test(`rejects a tracked ${label} in production inputs even when the shipped JS is clean`, (t) => {
    const { checkout, out, statsFile } = webBuild(t, spec);
    const main = `import './${spec.slice('src/'.length)}';\n${appJs}`;
    writeFileSync(join(checkout, 'src/main.ts'), main);
    writeFileSync(
      statsFile,
      JSON.stringify({
        ...cleanBrowserStats,
        inputs: {
          'src/main.ts': {
            bytes: Buffer.byteLength(main),
            imports: [{ path: spec, kind: 'import-statement' }],
          },
          [spec]: { bytes: readFileSync(join(checkout, spec)).length, imports: [] },
        },
      }),
    );

    assert.throws(
      () => {
        checkWebSpecs(checkout, out, statsFile);
      },
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(spec), error.message);
        assert.doesNotMatch(error.message, /no suite title/i);
        return true;
      },
    );
  });
}

const mainOutput = cleanBrowserStats.outputs['main.js'];
for (const { problem, report, spec = forkSuiteSpec } of [
  { problem: 'is missing' },
  { problem: 'contains malformed JSON', report: '{' },
  {
    problem: 'has no outputs map',
    report: JSON.stringify({ inputs: cleanBrowserStats.inputs }),
  },
  {
    problem: 'has an array instead of an inputs map',
    report: JSON.stringify({ ...cleanBrowserStats, inputs: [] }),
  },
  {
    problem: 'omits the recorded entry point from its inputs',
    report: JSON.stringify({ ...cleanBrowserStats, inputs: {} }),
  },
  {
    problem: 'references a tracked titleless fork helper only in an output inputs map',
    spec: titlelessForkSpecs[0],
    report: JSON.stringify({
      ...cleanBrowserStats,
      outputs: {
        'main.js': {
          ...mainOutput,
          inputs: {
            ...mainOutput.inputs,
            [titlelessForkSpecs[0]]: { bytesInOutput: 1 },
          },
        },
      },
    }),
  },
  {
    problem: 'has null instead of an output inputs map',
    report: JSON.stringify({
      ...cleanBrowserStats,
      outputs: { 'main.js': { ...mainOutput, inputs: null } },
    }),
  },
  {
    problem: 'has an unresolved output entry point despite valid output inputs',
    report: JSON.stringify({
      ...cleanBrowserStats,
      outputs: { 'main.js': { ...mainOutput, entryPoint: 'src/missing-entry.ts' } },
    }),
  },
]) {
  void test(`rejects clean shipped JS when the production graph ${problem}`, (t) => {
    const { checkout, out, statsFile } = webBuild(t, spec);
    if (report !== undefined) writeFileSync(statsFile, report);

    assert.throws(() => {
      checkWebSpecs(checkout, out, statsFile);
    });
  });
}

void test('detects any discovered fork Angular suite title in nested shipped JS with a clean production graph', (t) => {
  const { checkout, out, statsFile } = webBuild(t, forkSuiteSpec, iframeSuiteSpec);
  writeFileSync(statsFile, JSON.stringify(cleanBrowserStats));
  checkWebSpecs(checkout, out, statsFile);

  put(join(out, 'nested/from-spec.js'), 'describe("iframe save confirmation",()=>{});');
  assert.throws(() => {
    checkWebSpecs(checkout, out, statsFile);
  }, /iframe save confirmation/);
});
