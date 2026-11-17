import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkRepositoryBudget } from './check-upstream-budget.mjs';
import { buildLintFiles, collectLintFiles, parseNameStatus } from './gate-policy.mjs';

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
  );
}

/** @param {string} root @param {string} path @param {string} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** @param {string} root @param {string[]} [registry] */
function policy(root, registry = []) {
  put(
    root,
    'FORK.md',
    [
      '## Upstream change budget',
      '',
      'Budget paragraph.',
      '',
      '```json',
      '{"maxAddedLinesPerFile":10}',
      '```',
      '',
      '## Reworked upstream files',
      '',
      'Registry paragraph.',
      '',
      '```json',
      JSON.stringify(registry),
      '```',
      '',
    ].join('\n'),
  );
}

/** @param {string} root */
function commit(root) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Filesystem fixture');
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-filesystem-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-b', 'fixture-main');
  for (const path of ['upstream.ts', 'target.ts']) {
    put(
      root,
      path,
      Array.from({ length: 80 }, (_, index) => `// ${path} ${String(index)}\n`).join(''),
    );
  }
  commit(root);
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${base}\n`);
  policy(root);
  return { root, base };
}

void test('real Git typechange to mode 120000 fails budget with the upstream path', (t) => {
  const { root, base } = repository(t);
  rmSync(join(root, 'upstream.ts'));
  symlinkSync('target.ts', join(root, 'upstream.ts'));
  commit(root);
  assert.deepEqual(
    parseNameStatus(git(root, 'diff', '--name-status', '-z', base, 'HEAD')),
    [
      { status: 'A', path: 'FORK.md' },
      { status: 'A', path: 'fork/upstream-base' },
      { status: 'T', path: 'upstream.ts' },
    ],
  );
  assert.match(git(root, 'ls-tree', 'HEAD', '--', 'upstream.ts'), /^120000 blob /);
  const errors = checkRepositoryBudget(root);
  assert.ok(errors.length > 0, 'A symlink must not be charged as one added line');
  assert.ok(
    errors.some((error) => error.includes('upstream.ts')),
    JSON.stringify(errors),
  );
});

for (const kind of ['new', 'renamed', 'registry']) {
  void test(`lint list rejects a ${kind} symlink rather than linting its regular-file target`, (t) => {
    const { root } = repository(t);
    const path = kind === 'registry' ? 'upstream.ts' : 'linked.ts';
    if (kind === 'registry') {
      rmSync(join(root, path));
      policy(root, [path]);
    }
    symlinkSync('target.ts', join(root, path));
    if (kind === 'renamed') {
      commit(root);
      const base = git(root, 'rev-parse', 'HEAD').trim();
      put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${base}\n`);
      git(root, 'mv', path, 'renamed-link.ts');
    }
    commit(root);
    const expectedPath = kind === 'renamed' ? 'renamed-link.ts' : path;
    assert.throws(() => collectLintFiles(root), {
      code: 'ERR_FORK_POLICY',
      message: new RegExp(expectedPath.replaceAll('.', '\\.')),
    });
  });
}

void test('copy records contribute supported destination paths to the lint list', () => {
  const changes = parseNameStatus(
    'C100\0source.ts\0copy.ts\0C091\0tool.js\0new tool.mjs\0C100\0legacy.cjs\0copy.cjs\0',
  );
  assert.deepEqual(buildLintFiles(changes, [], new Set()), ['copy.ts', 'new tool.mjs']);
});

void test('real Git copy destination remains linted when copy detection is enabled', (t) => {
  const { root, base } = repository(t);
  copyFileSync(join(root, 'upstream.ts'), join(root, 'copy.ts'));
  commit(root);
  git(root, 'config', 'diff.renames', 'copies');
  const detected = parseNameStatus(
    git(
      root,
      'diff',
      '--find-copies',
      '--find-copies-harder',
      '--name-status',
      '-z',
      base,
      'HEAD',
    ),
  );
  assert.ok(
    detected.some(
      ({ status, oldPath, path }) =>
        status === 'C' && oldPath === 'upstream.ts' && path === 'copy.ts',
    ),
  );
  assert.deepEqual(collectLintFiles(root), ['copy.ts']);
});

void test('lint and budget detect every edited rename despite repository diff.renameLimit=1', (t) => {
  const { root, base } = repository(t);
  const renames = [
    ['target.ts', 'renamed target.ts'],
    ['upstream.ts', 'renamed upstream.ts'],
  ];
  git(root, 'config', '--local', 'diff.renameLimit', '1');
  assert.equal(git(root, 'config', '--local', '--get', 'diff.renameLimit').trim(), '1');
  for (const [oldPath, path] of renames) {
    git(root, 'mv', oldPath, path);
    put(root, path, readFileSync(join(root, path), 'utf8') + '// addition\n'.repeat(11));
  }
  commit(root);
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--find-renames',
    '--name-status',
    '-z',
    `${base}...HEAD`,
    '--',
  ];
  const limited = parseNameStatus(git(root, ...args));
  assert.deepEqual(
    limited.filter(({ status }) => status === 'R'),
    [],
    'The fixture must exceed the configured inexact rename limit',
  );
  const paths = renames.map(([, path]) => path);
  assert.deepEqual(
    limited.filter(({ status, path }) => status === 'A' && paths.includes(path)),
    paths.map((path) => ({ status: 'A', path })),
  );
  assert.deepEqual(
    parseNameStatus(git(root, ...args.slice(0, 1), '-l0', ...args.slice(1))).filter(
      ({ status }) => status === 'R',
    ),
    renames.map(([oldPath, path]) => ({ status: 'R', oldPath, path })),
  );
  // Spy on the real Git calls; the default mock implementation still executes Git.
  const runGit = t.mock.method(childProcess, 'execFileSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(collectLintFiles(root), paths);
    assert.deepEqual(
      checkRepositoryBudget(root),
      paths.map((path) => `BUDGET_EXCEEDED: ${path}: added 11 > limit 10`),
    );
    const diffs = runGit.mock.calls.filter(
      ({ arguments: [command, argv] }) =>
        command === 'git' && Array.isArray(argv) && argv[0] === 'diff',
    );
    assert.equal(diffs.length, 3, 'Lint name-status, budget name-status and numstat');
    for (const {
      arguments: [, argv],
      result,
    } of diffs) {
      assert.ok(Array.isArray(argv));
      assert.ok(argv.includes('-l0'), JSON.stringify(argv));
      if (argv.includes('--name-status')) {
        assert.deepEqual(
          parseNameStatus(String(result)).filter(({ status }) => status === 'R'),
          renames.map(([oldPath, path]) => ({ status: 'R', oldPath, path })),
        );
      }
    }
  } finally {
    runGit.mock.restore();
    syncBuiltinESMExports();
  }
});
