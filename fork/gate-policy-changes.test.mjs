import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** @type {unknown} */
const policyModule = await import('./gate-policy.mjs');
const { checkPolicyChanges } = /** @type {{
 * checkPolicyChanges?: (repoRoot: string, mainRef?: string) => string[]
 * }} */ (policyModule);

// Contract for B2: compare HEAD policy with merge-base(HEAD, mainRef = 'main').
// Return one Actions annotation per changed field, with JSON old/new values.
// Registry comparison is a set comparison; output arrays are sorted.
// CLI: node fork/gate-policy.mjs --check-policy-changes [mainRef], cwd = repoRoot.
// Print annotations to stdout, exit 0 even on policy changes; unchanged is silent.
const CLI = fileURLToPath(new URL('./gate-policy.mjs', import.meta.url));

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

/** @param {string} root @param {number} n @param {string[]} files */
function policy(root, n, files) {
  for (const path of files) put(root, path, '// Upstream file\n');
  put(
    root,
    'FORK.md',
    [
      '## Upstream change budget',
      '',
      'Budget paragraph.',
      '',
      '```json',
      JSON.stringify({ maxAddedLinesPerFile: n }),
      '```',
      '',
      '## Reworked upstream files',
      '',
      'Registry paragraph.',
      '',
      '```json',
      JSON.stringify(files),
      '```',
      '',
    ].join('\n'),
  );
}

/** @param {string} root */
function commit(root) {
  git(root, 'add', '.');
  git(root, 'commit', '--allow-empty', '-m', 'Policy fixture');
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-policy-changes-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-b', 'main');
  put(root, 'upstream.txt', 'Original upstream\n');
  commit(root);
  const upstream = git(root, 'rev-parse', 'HEAD');
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${upstream}\n`);
  policy(root, 10, ['src/a.ts']);
  commit(root);
  git(root, 'checkout', '-b', 'fixture-topic');
  return root;
}

/** @param {string} root @param {string} [mainRef] */
function changes(root, mainRef) {
  assert.equal(
    typeof checkPolicyChanges,
    'function',
    'Missing API: checkPolicyChanges(repoRoot, mainRef?)',
  );
  assert.ok(checkPolicyChanges);
  return checkPolicyChanges(root, mainRef);
}

/** @param {string} field @param {number|string[]} oldValue @param {number|string[]} newValue */
function annotation(field, oldValue, newValue) {
  return `::warning::FORK_POLICY_CHANGED ${field}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`;
}

void test('unchanged policy has no annotations, including after unrelated commits', (t) => {
  const root = repository(t);
  put(root, 'unrelated.txt', 'Unrelated change\n');
  commit(root);
  assert.deepEqual(changes(root), []);
});

for (const n of [0, 20]) {
  void test(`changing N to ${String(n)} annotates both old and new values`, (t) => {
    const root = repository(t);
    policy(root, n, ['src/a.ts']);
    commit(root);
    assert.deepEqual(changes(root), [annotation('maxAddedLinesPerFile', 10, n)]);
  });
}

for (const files of [[], ['src/a.ts', 'src/b.ts'], ['src/b.ts']]) {
  void test(`changing registry annotates exact old and new sets: ${JSON.stringify(files)}`, (t) => {
    const root = repository(t);
    policy(root, 10, files);
    commit(root);
    assert.deepEqual(changes(root), [annotation('reworkedFiles', ['src/a.ts'], files)]);
  });
}

void test('simultaneous N and registry changes emit both annotations', (t) => {
  const root = repository(t);
  policy(root, 20, []);
  commit(root);
  assert.deepEqual(changes(root), [
    annotation('maxAddedLinesPerFile', 10, 20),
    annotation('reworkedFiles', ['src/a.ts'], []),
  ]);
});

void test('registry reordering and JSON whitespace alone are silent', (t) => {
  const root = repository(t);
  git(root, 'checkout', 'main');
  policy(root, 10, ['src/a.ts', 'src/b.ts']);
  commit(root);
  git(root, 'checkout', '-b', 'fixture-reordered');
  policy(root, 10, ['src/b.ts', 'src/a.ts']);
  const path = join(root, 'FORK.md');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(
      '{"maxAddedLinesPerFile":10}',
      '{ "maxAddedLinesPerFile": 10 }',
    ),
  );
  commit(root);
  assert.deepEqual(changes(root), []);
});

void test('comparison uses branch merge-base, not main HEAD, upstream pin, or last commit', (t) => {
  const root = repository(t);
  git(root, 'checkout', 'main');
  policy(root, 30, ['src/a.ts']);
  commit(root);
  git(root, 'checkout', 'fixture-topic');
  policy(root, 25, ['src/a.ts']);
  commit(root);
  put(root, 'unrelated.txt', 'Last commit does not change policy\n');
  commit(root);
  assert.deepEqual(changes(root), [annotation('maxAddedLinesPerFile', 10, 25)]);
  git(root, 'branch', 'fixture-target', 'main');
  assert.deepEqual(changes(root, 'fixture-target'), changes(root));
});

for (const changed of [false, true]) {
  void test(`policy CLI exits 0 and ${changed ? 'prints Actions warnings' : 'stays silent'}`, (t) => {
    const root = repository(t);
    if (changed) {
      policy(root, 20, []);
      commit(root);
    }
    const result = spawnSync(process.execPath, [CLI, '--check-policy-changes', 'main'], {
      cwd: root,
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      changed
        ? [
            annotation('maxAddedLinesPerFile', 10, 20),
            annotation('reworkedFiles', ['src/a.ts'], []),
            '',
          ].join('\n')
        : '',
    );
  });
}
