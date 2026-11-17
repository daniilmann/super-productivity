import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  checkRepositoryBudget,
  checkUpstreamBudget,
  parseNumstat,
} from './check-upstream-budget.mjs';

/**
 * @typedef {{status: string, path: string, oldPath?: string}} Change
 * @typedef {{path: string, oldPath?: string, added: number|null, deleted: number|null}} Stat
 */
/** @type {{maxAddedLinesPerFile: number, reworkedFiles: string[]}} */
const POLICY = { maxAddedLinesPerFile: 10, reworkedFiles: [] };
const PATH = 'src/edited file.ts';

/** @param {string} path @param {number} added @param {number} [limit] */
function exceeded(path, added, limit = 10) {
  return `BUDGET_EXCEEDED: ${path}: added ${String(added)} > limit ${String(limit)}`;
}

void test('numstat parses NUL records, rename pairs, whitespace, and binary sentinels', () => {
  assert.deepEqual(
    parseNumstat(
      '10\t8\tsrc/a b.ts\0' +
        '11\t2\t\0src/old name.ts\0src/new name.ts\0-\t-\tassets/image.bin\0',
    ),
    [
      { path: 'src/a b.ts', added: 10, deleted: 8 },
      { oldPath: 'src/old name.ts', path: 'src/new name.ts', added: 11, deleted: 2 },
      { path: 'assets/image.bin', added: null, deleted: null },
    ],
  );
  assert.deepEqual(parseNumstat('0\t0\tsrc/tab\tand\nnewline.ts\0'), [
    { path: 'src/tab\tand\nnewline.ts', added: 0, deleted: 0 },
  ]);
  assert.deepEqual(parseNumstat(''), []);
});

for (const output of [
  '1\t2\ta.ts',
  '1\t2\t\0old.ts\0',
  'x\t0\ta.ts\0',
  '-1\t0\ta.ts\0',
  '1.5\t0\ta.ts\0',
  '-\t0\ta.ts\0',
]) {
  void test(`malformed numstat cannot become zero additions: ${JSON.stringify(output)}`, () => {
    assert.throws(() => parseNumstat(output), { code: 'ERR_GIT_DIFF' });
  });
}

for (const added of [0, 10, 11]) {
  void test(`per-file added-line boundary: ${String(added)}`, () => {
    const errors = checkUpstreamBudget(
      [{ status: 'M', path: PATH }],
      [{ path: PATH, added, deleted: 0 }],
      POLICY,
    );
    assert.deepEqual(errors, added <= 10 ? [] : [exceeded(PATH, added)]);
  });
}

void test('zero is an explicit budget; one added line fails', () => {
  const policy = { ...POLICY, maxAddedLinesPerFile: 0 };
  assert.deepEqual(
    checkUpstreamBudget(
      [{ status: 'M', path: PATH }],
      [{ path: PATH, added: 0, deleted: 100 }],
      policy,
    ),
    [],
  );
  assert.deepEqual(
    checkUpstreamBudget(
      [{ status: 'M', path: PATH }],
      [{ path: PATH, added: 1, deleted: 0 }],
      policy,
    ),
    [exceeded(PATH, 1, 0)],
  );
});

void test('budget is per file, not a sum across files', () => {
  const paths = [PATH, 'src/neighbor.ts'];
  assert.deepEqual(
    checkUpstreamBudget(
      paths.map((path) => ({ status: 'M', path })),
      paths.map((path) => ({ path, added: 10, deleted: 0 })),
      POLICY,
    ),
    [],
  );
});

void test('only the exact reworked path is exempt; a neighboring file still fails', () => {
  const neighbor = 'src/edited file.ts.extra.ts';
  const paths = [PATH, neighbor];
  assert.deepEqual(
    checkUpstreamBudget(
      paths.map((path) => ({ status: 'M', path })),
      paths.map((path) => ({ path, added: 11, deleted: 0 })),
      {
        ...POLICY,
        reworkedFiles: [PATH],
      },
    ),
    [exceeded(neighbor, 11)],
  );
});

void test('deletions neither spend nor compensate the additions budget', () => {
  for (const deleted of [0, 10000]) {
    for (const added of [0, 10, 11]) {
      assert.deepEqual(
        checkUpstreamBudget(
          [{ status: 'M', path: PATH }],
          [{ path: PATH, added, deleted }],
          POLICY,
        ),
        added <= 10 ? [] : [exceeded(PATH, added)],
      );
    }
  }
});

void test('pure rename costs zero; editing a rename cannot evade the budget', () => {
  const oldPath = 'src/old file.ts';
  for (const added of [0, 11]) {
    assert.deepEqual(
      checkUpstreamBudget(
        [{ status: 'R', oldPath, path: PATH }],
        [{ oldPath, path: PATH, added, deleted: 0 }],
        POLICY,
      ),
      added === 0 ? [] : [exceeded(PATH, added)],
    );
  }
});

void test('rename exemption names the current target, not the old path', () => {
  const oldPath = 'src/old file.ts';
  const changes = [{ status: 'R', oldPath, path: PATH }];
  const stats = [{ oldPath, path: PATH, added: 11, deleted: 0 }];
  assert.deepEqual(
    checkUpstreamBudget(changes, stats, {
      ...POLICY,
      reworkedFiles: [PATH],
    }),
    [],
  );
  assert.deepEqual(
    checkUpstreamBudget(changes, stats, {
      ...POLICY,
      reworkedFiles: [oldPath],
    }),
    [exceeded(PATH, 11)],
  );
});

void test('A, D, and copy targets are excluded; a modified copy source is checked independently', () => {
  /** @type {Change[]} */
  const changes = [
    { status: 'A', path: 'new.ts' },
    { status: 'D', path: 'deleted.ts' },
    { status: 'C', oldPath: PATH, path: 'copy.ts' },
    { status: 'M', path: PATH },
  ];
  /** @type {Stat[]} */
  const stats = [
    { path: 'new.ts', added: 100, deleted: 0 },
    { path: 'deleted.ts', added: 0, deleted: 100 },
    { oldPath: PATH, path: 'copy.ts', added: 100, deleted: 0 },
    { path: PATH, added: 11, deleted: 0 },
  ];
  assert.deepEqual(checkUpstreamBudget(changes, stats, POLICY), [exceeded(PATH, 11)]);
});

void test('binary upstream M is not zero: the line budget is inapplicable', () => {
  const path = 'assets/image.bin';
  assert.deepEqual(
    checkUpstreamBudget(
      [{ status: 'M', path }],
      [{ path, added: null, deleted: null }],
      POLICY,
    ),
    [`BUDGET_NOT_APPLICABLE: ${path}: бюджет строк неприменим`],
  );
});

void test('missing numstat for an upstream change fails closed', () => {
  assert.deepEqual(checkUpstreamBudget([{ status: 'M', path: PATH }], [], POLICY), [
    `MISSING_NUMSTAT: ${PATH}`,
  ]);
});

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
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** @param {string} root @param {string} path @param {string|Uint8Array} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** @param {string} label @param {number} count */
function lines(label, count) {
  return Array.from({ length: count }, (_, index) => `${label} ${String(index)}\n`).join(
    '',
  );
}

/** @param {string} root @param {string[]} [reworkedFiles] */
function writePolicy(root, reworkedFiles = []) {
  put(
    root,
    'FORK.md',
    [
      '## Upstream change budget',
      '```json',
      '{"maxAddedLinesPerFile":10}',
      '```',
      '## Reworked upstream files',
      '```json',
      JSON.stringify(reworkedFiles),
      '```',
      '',
    ].join('\n'),
  );
}

/** @param {string} root @param {string} path @param {string} suffix */
function append(root, path, suffix) {
  put(root, path, readFileSync(join(root, path), 'utf8') + suffix);
}

/** @param {string} root */
function commitAll(root) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Fork fixture');
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-budget-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-b', 'fixture-main');
  for (const path of [PATH, 'src/neighbor.ts', 'src/rename old.ts', 'src/deleted.ts']) {
    put(root, path, lines(path, 80));
  }
  put(root, 'assets/binary.bin', Buffer.from([0, 1, 2]));
  commitAll(root);
  const commit = git(root, 'rev-parse', 'HEAD');
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${commit}\n`);
  writePolicy(root);
  return { root, commit };
}

void test('real Git: unchanged tree and a mode-only modification cost zero', (t) => {
  const { root } = repository(t);
  assert.deepEqual(checkRepositoryBudget(root), []);
  git(root, 'add', '.');
  git(root, 'update-index', '--chmod=+x', PATH);
  git(root, 'commit', '-m', 'Mode fixture');
  assert.deepEqual(checkRepositoryBudget(root), []);
});

void test('real Git: exactly N lines pass; N+1 comments/blank lines fail', (t) => {
  const { root } = repository(t);
  append(root, PATH, '// comment\n\n'.repeat(5));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), []);
  append(root, PATH, '\n');
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded(PATH, 11)]);
});

void test('real Git: budget uses the pinned upstream base, not main or only the last commit', (t) => {
  const { root } = repository(t);
  append(root, PATH, lines('earlier addition', 6));
  commitAll(root);
  git(root, 'branch', 'main');
  append(root, PATH, lines('current addition', 5));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded(PATH, 11)]);
});

void test('real Git: final diff is counted once, rather than summing every commit', (t) => {
  const { root } = repository(t);
  append(root, PATH, lines('temporary addition', 11));
  commitAll(root);
  put(root, PATH, lines(PATH, 80) + lines('final addition', 10));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), []);
});

void test('real Git: exact reworked exemption leaves its neighbor under budget', (t) => {
  const { root } = repository(t);
  writePolicy(root, [PATH]);
  append(root, PATH, lines('exempt addition', 11));
  append(root, 'src/neighbor.ts', lines('neighbor addition', 11));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded('src/neighbor.ts', 11)]);
});

void test('real Git: pure rename passes; retained upstream content plus N+1 additions fails', (t) => {
  const { root } = repository(t);
  const renamed = 'src/renamed file.ts';
  git(root, 'mv', 'src/rename old.ts', renamed);
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), []);
  append(root, renamed, lines('rename addition', 11));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded(renamed, 11)]);
});

void test('real Git: deleting, adding, or copying files does not charge upstream budget', (t) => {
  const { root } = repository(t);
  git(root, 'rm', 'src/deleted.ts');
  put(root, 'src/new.ts', lines('new content', 100));
  put(root, 'src/copy.ts', readFileSync(join(root, PATH), 'utf8'));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), []);
  append(root, PATH, lines('source addition', 11));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded(PATH, 11)]);
});

void test('real Git: large deletion in M does not compensate N+1 additions', (t) => {
  const { root } = repository(t);
  put(root, PATH, lines('replacement', 11));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [exceeded(PATH, 11)]);
});

void test('real Git: binary M fails as inapplicable', (t) => {
  const { root } = repository(t);
  put(root, 'assets/binary.bin', Buffer.from([0, 3, 4]));
  commitAll(root);
  assert.deepEqual(checkRepositoryBudget(root), [
    'BUDGET_NOT_APPLICABLE: assets/binary.bin: бюджет строк неприменим',
  ]);
});

void test('real Git: unavailable base and Git errors cannot turn into budget success', (t) => {
  const { root } = repository(t);
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${'f'.repeat(40)}\n`);
  assert.throws(() => checkRepositoryBudget(root), { code: 'ERR_UPSTREAM_BASE' });
  rmSync(join(root, '.git'), { recursive: true });
  assert.throws(() => checkRepositoryBudget(root), { code: 'ERR_GIT' });
});

void test('real Git: invalid registry and missing budget cannot silently exempt changes', (t) => {
  const { root } = repository(t);
  writePolicy(root, ['missing.ts']);
  assert.throws(() => checkRepositoryBudget(root), { code: 'ERR_FORK_POLICY' });
  writePolicy(root);
  const path = join(root, 'FORK.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('{"maxAddedLinesPerFile":10}', '{}'),
  );
  assert.throws(() => checkRepositoryBudget(root), { code: 'ERR_FORK_POLICY' });
});
