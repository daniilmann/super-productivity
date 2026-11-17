import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The explicit API type keeps RED lintable while the implementation is absent.
/** @type {unknown} */
const pinnedModule = await import('./check-pinned-packages.mjs');
const { checkPinnedPackages } =
  /** @type {{checkPinnedPackages: (repoRoot: string) => string[]}} */ (pinnedModule);

const CLI = fileURLToPath(new URL('./check-pinned-packages.mjs', import.meta.url));
const PACKAGES = [
  'packages/shared-schema',
  'packages/sync-core',
  'packages/super-sync-server',
];
const FILE = 'nested/source file.txt';
const OUTSIDE = 'docs/outside file.txt';

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

/** @param {string} root @param {string} path @param {string} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** @param {string} root */
function commitAll(root) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Package fixture');
}

/** @param {string} root @param {string} commit */
function pin(root, commit) {
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${commit}\n`);
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-pinned-packages-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-b', 'fixture-main');
  for (const directory of PACKAGES) {
    put(root, `${directory}/${FILE}`, `Original ${directory}\n`);
  }
  put(root, OUTSIDE, 'Outside package content\n');
  put(
    root,
    'FORK.md',
    [
      '## Upstream change budget',
      '```json',
      '{"maxAddedLinesPerFile":0}',
      '```',
      '## Reworked upstream files',
      '```json',
      '[]',
      '```',
      '',
    ].join('\n'),
  );
  commitAll(root);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'tag', 'v1.0.0');
  pin(root, base);
  commitAll(root);
  return { root, base };
}

/** @param {string} root @param {string[]} paths */
function expectChanges(root, paths) {
  assert.deepEqual(
    checkPinnedPackages(root),
    paths.map((path) => `PINNED_PACKAGE_CHANGED: ${path}`).sort(),
  );
}

/** @param {string} root */
function cli(root) {
  const result = spawnSync(process.execPath, [CLI], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  return result;
}

void test('identical pinned package trees pass at the base and after unrelated commits', (t) => {
  const { root, base } = repository(t);
  expectChanges(root, []);
  git(root, 'checkout', '--detach', base);
  // The pin file is control input; restore it after checking out the base tree.
  pin(root, base);
  expectChanges(root, []);
});

for (const directory of PACKAGES) {
  for (const kind of ['modified', 'added', 'deleted', 'renamed', 'mode-only']) {
    void test(`${directory}: ${kind} committed entry fails with its path`, (t) => {
      const { root } = repository(t);
      const path = `${directory}/${FILE}`;
      const target = `${directory}/nested/new file.txt`;
      let paths = [path];
      switch (kind) {
        case 'modified':
          put(root, path, 'Changed package content\n');
          break;
        case 'added':
          put(root, target, 'Added package content\n');
          paths = [target];
          break;
        case 'deleted':
          git(root, 'rm', path);
          break;
        case 'renamed':
          git(root, 'mv', path, target);
          paths = [path, target];
          break;
        case 'mode-only':
          git(root, 'update-index', '--chmod=+x', path);
          git(root, 'commit', '-m', 'Mode fixture');
          expectChanges(root, paths);
          return;
        default:
          assert.fail(`Unknown mutation: ${kind}`);
      }
      commitAll(root);
      expectChanges(root, paths);
    });
  }

  for (const direction of ['out', 'in']) {
    void test(`${directory}: rename ${direction} across the boundary fails`, (t) => {
      const { root } = repository(t);
      const path = `${directory}/${direction === 'out' ? FILE : 'incoming.txt'}`;
      const source = direction === 'out' ? path : OUTSIDE;
      const target = direction === 'out' ? 'docs/moved-out.txt' : path;
      git(root, 'mv', source, target);
      commitAll(root);
      expectChanges(root, [path]);
    });
  }
}

void test('outside changes and similarly named directories are not pinned packages', (t) => {
  const { root } = repository(t);
  put(root, OUTSIDE, 'Changed outside\n');
  put(root, 'src/app/file.ts', 'export const value = 1;\n');
  for (const directory of PACKAGES) {
    put(root, `${directory}-extra/${FILE}`, 'Outside exact package boundary\n');
  }
  commitAll(root);
  expectChanges(root, []);
});

void test('all differing protected paths are reported, including tabs, newlines, and Unicode', (t) => {
  const { root } = repository(t);
  const paths = PACKAGES.map((directory) => `${directory}/a\tb\nΩ.txt`);
  for (const path of paths) put(root, path, 'New file\n');
  commitAll(root);
  expectChanges(root, paths);
});

void test('the commit field wins over a moved tag, main branch, and the last commit', (t) => {
  const { root } = repository(t);
  const path = `${PACKAGES[0]}/${FILE}`;
  put(root, path, 'Earlier protected change\n');
  commitAll(root);
  git(root, 'tag', '-f', 'v1.0.0');
  git(root, 'branch', 'main');
  put(root, OUTSIDE, 'Later unrelated change\n');
  commitAll(root);
  expectChanges(root, [path]);
});

void test('a committed package change reverted by the next commit passes', (t) => {
  const { root } = repository(t);
  put(root, `${PACKAGES[1]}/${FILE}`, 'Temporary change\n');
  commitAll(root);
  git(root, 'revert', '--no-edit', 'HEAD');
  expectChanges(root, []);
});

void test('unstaged, staged, deleted, and untracked working files do not change HEAD', (t) => {
  const { root } = repository(t);
  put(root, `${PACKAGES[0]}/${FILE}`, 'Unstaged change\n');
  put(root, `${PACKAGES[1]}/${FILE}`, 'Staged change\n');
  git(root, 'add', `${PACKAGES[1]}/${FILE}`);
  rmSync(join(root, `${PACKAGES[2]}/${FILE}`));
  put(root, `${PACKAGES[2]}/untracked.txt`, 'Untracked change\n');
  expectChanges(root, []);
});

void test('restoring a changed HEAD file only in the index cannot hide the committed diff', (t) => {
  const { root, base } = repository(t);
  const path = `${PACKAGES[0]}/${FILE}`;
  put(root, path, 'Committed change\n');
  commitAll(root);
  git(root, 'checkout', base, '--', path);
  expectChanges(root, [path]);
});

for (const invalid of ['malformed', 'unavailable', 'missing', 'tree-object']) {
  void test(`invalid upstream base (${invalid}) fails closed`, (t) => {
    const { root, base } = repository(t);
    switch (invalid) {
      case 'malformed':
        pin(root, 'not-a-sha');
        break;
      case 'unavailable':
        pin(root, 'f'.repeat(40));
        break;
      case 'missing':
        rmSync(join(root, 'fork/upstream-base'));
        break;
      case 'tree-object':
        pin(root, git(root, 'rev-parse', `${base}^{tree}`));
        break;
      default:
        assert.fail(`Unknown invalid base: ${invalid}`);
    }
    assert.throws(() => checkPinnedPackages(root), { code: 'ERR_UPSTREAM_BASE' });
  });
}

void test('an available commit on a divergent branch is not a valid ancestor base', (t) => {
  const { root, base } = repository(t);
  git(root, 'checkout', '-b', 'divergent', base);
  put(root, OUTSIDE, 'Divergent branch\n');
  commitAll(root);
  const divergent = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'fixture-main');
  pin(root, divergent);
  assert.throws(() => checkPinnedPackages(root), { code: 'ERR_UPSTREAM_BASE' });
});

void test('a missing Git repository fails rather than reporting equal packages', (t) => {
  const { root } = repository(t);
  rmSync(join(root, '.git'), { recursive: true });
  assert.throws(() => checkPinnedPackages(root), { code: 'ERR_GIT' });
});

void test('CLI exits zero when pinned package trees match', (t) => {
  const { root } = repository(t);
  assert.equal(cli(root).status, 0);
});

void test('CLI exits nonzero and diagnoses every differing package path', (t) => {
  const { root } = repository(t);
  const paths = PACKAGES.map((directory) => `${directory}/${FILE}`);
  for (const path of paths) put(root, path, 'Committed CLI change\n');
  commitAll(root);
  const result = cli(root);
  assert.notEqual(result.status, 0);
  for (const path of paths) {
    assert.ok(result.stderr.includes(`PINNED_PACKAGE_CHANGED: ${path}`), result.stderr);
  }
});

void test('CLI exits nonzero and diagnoses an unavailable base', (t) => {
  const { root } = repository(t);
  pin(root, 'f'.repeat(40));
  const result = cli(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_UPSTREAM_BASE/);
});
