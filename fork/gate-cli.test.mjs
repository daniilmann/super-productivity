import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['shared-schema', 'sync-core', 'super-sync-server'];
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

/** @returns {NodeJS.ProcessEnv} */
function gitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/** @param {string} root @param {...string} args */
function git(root, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Gate Test',
      '-c',
      'user.email=gate-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: root,
      env: gitEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/** @param {string} root @param {string} path @param {string} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** @param {string} root */
function commit(root) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'CLI fixture');
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-cli-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-b', 'main');
  put(root, 'package.json', '{"type":"module"}\n');
  put(
    root,
    'eslint.fork.config.js',
    `export default [{ files: ['**/*.mjs'], rules: { 'no-debugger': 'error' } }];\n`,
  );
  put(root, 'upstream.txt', 'Original line\n');
  for (const name of PACKAGES) put(root, `packages/${name}/source.txt`, 'Protected\n');
  commit(root);
  const base = git(root, 'rev-parse', 'HEAD');
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${base}\n`);
  put(
    root,
    'FORK.md',
    [
      '## Upstream change budget',
      '',
      'Budget paragraph.',
      '',
      '```json',
      '{"maxAddedLinesPerFile":1}',
      '```',
      '',
      '## Reworked upstream files',
      '',
      'Registry paragraph.',
      '',
      '```json',
      '[]',
      '```',
      '',
    ].join('\n'),
  );
  return root;
}

/** @param {string} root @param {string[]} args */
function node(root, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: gitEnvironment(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  return result;
}

/** @param {string} name */
function script(name) {
  return fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
}

for (const added of [1, 2]) {
  void test(`budget CLI exits ${added === 1 ? 'zero at N' : 'nonzero above N'} on committed real Git changes`, (t) => {
    const root = repository(t);
    put(root, 'upstream.txt', 'Original line\n' + 'Added line\n'.repeat(added));
    commit(root);
    const result = node(root, [script('check-upstream-budget')]);
    if (added === 1) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /budget passed/i);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /BUDGET_EXCEEDED: upstream\.txt/);
    }
  });
}

for (const violation of [false, true]) {
  void test(`lint CLI runs a local ESLint stub and exits ${violation ? 'nonzero for a finding' : 'zero for clean code'}`, (t) => {
    const root = repository(t);
    put(root, 'new file.mjs', violation ? 'debugger;\n' : 'export const value = 1;\n');
    commit(root);
    const report = [
      {
        filePath: join(realpathSync(root), 'new file.mjs'),
        messages: violation
          ? [{ ruleId: 'no-debugger', severity: 2, message: "Unexpected 'debugger'." }]
          : [],
        errorCount: violation ? 1 : 0,
        warningCount: 0,
        fatalErrorCount: 0,
      },
    ];
    put(
      root,
      'node_modules/eslint/bin/eslint.js',
      `console.log(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = ${violation ? '1' : '0'};\n`,
    );
    const result = node(root, [script('run-fork-lint')]);
    if (violation) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /new file\.mjs: no-debugger:/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Fork lint passed: 1 files/);
    }
  });
}

void test('lint CLI exits zero with an explicit skip for an empty list and no node_modules', (t) => {
  const root = repository(t);
  commit(root);
  const result = node(root, [script('run-fork-lint')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped.*empty file list/i);
});

void test('Git fixtures and real gate functions use their own repository under foreign GIT_* routing', (t) => {
  const root = repository(t);
  commit(root);
  const foreign = repository(t);
  commit(foreign);
  const saved = gitEnvironment();
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  process.env.GIT_DIR = join(foreign, '.git');
  process.env.GIT_WORK_TREE = foreign;
  process.env.GIT_INDEX_FILE = join(foreign, '.git', 'unrelated-index');
  try {
    assert.equal(git(root, 'rev-parse', '--show-toplevel'), realpathSync(root));
    assert.ok(names.every((name) => !(name in gitEnvironment())));
    const source = `
      import assert from 'node:assert/strict';
      import { checkRepositoryBudget } from ${JSON.stringify(new URL('./check-upstream-budget.mjs', import.meta.url).href)};
      import { checkPinnedPackages } from ${JSON.stringify(new URL('./check-pinned-packages.mjs', import.meta.url).href)};
      import { collectLintFiles, readGateInputs } from ${JSON.stringify(new URL('./gate-policy.mjs', import.meta.url).href)};
      assert.ok(Object.keys(process.env).every((key) => !key.startsWith('GIT_')));
      const root = process.cwd();
      assert.equal(readGateInputs(root).policy.maxAddedLinesPerFile, 1);
      assert.deepEqual(checkRepositoryBudget(root), []);
      assert.deepEqual(checkPinnedPackages(root), []);
      assert.deepEqual(collectLintFiles(root), []);
    `;
    const result = node(root, ['--input-type=module', '--eval', source]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(process.env.GIT_DIR, join(foreign, '.git'));
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = saved[name];
    }
  }
});
