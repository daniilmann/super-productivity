import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildLintFiles,
  collectLintFiles,
  parseForkPolicy,
  parseNameStatus,
  parseUpstreamBase,
  readGateInputs,
} from './gate-policy.mjs';

/** @param {string} [budget] @param {string} [registry] */
function policyText(budget = '{"maxAddedLinesPerFile":10}', registry = '[]') {
  return [
    '# Fork notes',
    'Unrelated prose mentions `not-a-registry.ts`.',
    '## Upstream change budget',
    '```json',
    budget,
    '```',
    '## Reworked upstream files',
    '```json',
    registry,
    '```',
    '## Other notes',
    '```json',
    '["also-not-a-registry.ts"]',
    '```',
    '',
  ].join('\n');
}

void test('policy reads only its two named JSON sections, including an empty registry', () => {
  assert.deepEqual(parseForkPolicy(policyText()), {
    maxAddedLinesPerFile: 10,
    reworkedFiles: [],
  });
  const files = ['src/a.ts', 'src/b.tsx', 'tools/c.js', 'fork/d.mjs'];
  assert.deepEqual(
    parseForkPolicy(policyText('{"maxAddedLinesPerFile":0}', JSON.stringify(files))),
    {
      maxAddedLinesPerFile: 0,
      reworkedFiles: files,
    },
  );
});

for (const budget of [
  '{}',
  'null',
  '[]',
  '{',
  '{"maxAddedLinesPerFile":"10"}',
  '{"maxAddedLinesPerFile":-1}',
  '{"maxAddedLinesPerFile":1.5}',
  '{"maxAddedLinesPerFile":null}',
  '{"maxAddedLinesPerFile":9007199254740992}',
]) {
  void test(`invalid budget fails without a fallback: ${budget}`, () => {
    assert.throws(() => parseForkPolicy(policyText(budget)), { code: 'ERR_FORK_POLICY' });
  });
}

for (const registry of [
  '{}',
  'null',
  '"src/a.ts"',
  '[1]',
  '[null]',
  '[',
  '["src/a.ts","src/a.ts"]',
]) {
  void test(`invalid registry or duplicate entry fails: ${registry}`, () => {
    assert.throws(() => parseForkPolicy(policyText(undefined, registry)), {
      code: 'ERR_FORK_POLICY',
    });
  });
}

for (const path of [
  'src/a.cjs',
  'src/a.kt',
  'src/a.java',
  'src/a.html',
  '',
  '/src/a.ts',
  '../a.ts',
  'src/../a.ts',
  './src/a.ts',
  'src\\a.ts',
  'src//a.ts',
]) {
  void test(`registry requires a supported canonical relative file path: ${JSON.stringify(path)}`, () => {
    assert.throws(() => parseForkPolicy(policyText(undefined, JSON.stringify([path]))), {
      code: 'ERR_FORK_POLICY',
    });
  });
}

for (const heading of ['Upstream change budget', 'Reworked upstream files']) {
  void test(`missing or repeated section fails: ${heading}`, () => {
    const text = policyText();
    assert.throws(
      () => parseForkPolicy(text.replace(`## ${heading}`, `### ${heading}`)),
      {
        code: 'ERR_FORK_POLICY',
      },
    );
    assert.throws(
      () => parseForkPolicy(`${text}\n## ${heading}\n\`\`\`json\n[]\n\`\`\`\n`),
      {
        code: 'ERR_FORK_POLICY',
      },
    );
  });
}

void test('a section must contain exactly one complete JSON fence', () => {
  for (const text of [
    policyText().replace('```json\n[]\n```', '[]'),
    policyText().replace('```json\n[]\n```', '```json\n[]'),
    policyText().replace('```json\n[]\n```', '```json\n[]\n```\n```json\n[]\n```'),
  ]) {
    assert.throws(() => parseForkPolicy(text), { code: 'ERR_FORK_POLICY' });
  }
});

const SHA = '1234567890abcdef1234567890abcdef12345678';

void test('upstream base parses the pinned tag and full commit SHA', () => {
  assert.deepEqual(parseUpstreamBase(`tag=v20.0.0\ncommit=${SHA}\n`), {
    tag: 'v20.0.0',
    commit: SHA,
  });
});

for (const text of [
  '',
  'tag=v20.0.0\n',
  `commit=${SHA}\n`,
  'tag=v20.0.0\ncommit=HEAD\n',
  'tag=v20.0.0\ncommit=1234567\n',
  `tag=v20.0.0\ncommit=${'z'.repeat(40)}\n`,
  `tag=\ncommit=${SHA}\n`,
  `tag=v20.0.0\ncommit=${SHA}\ncommit=${SHA}\n`,
]) {
  void test(`malformed upstream base fails: ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseUpstreamBase(text), { code: 'ERR_UPSTREAM_BASE' });
  });
}

void test('name-status parses NUL records and both rename paths without splitting whitespace', () => {
  assert.deepEqual(
    parseNameStatus(
      'A\0new file.ts\0R091\0old name.js\0new name.js\0M\0a\tb.ts\0D\0gone.ts\0',
    ),
    [
      { status: 'A', path: 'new file.ts' },
      { status: 'R', oldPath: 'old name.js', path: 'new name.js' },
      { status: 'M', path: 'a\tb.ts' },
      { status: 'D', path: 'gone.ts' },
    ],
  );
  assert.deepEqual(parseNameStatus(''), []);
});

void test('truncated Git name-status output fails instead of dropping a record', () => {
  for (const text of ['M\0', 'R100\0old.ts\0', 'A\0new.ts']) {
    assert.throws(() => parseNameStatus(text), { code: 'ERR_GIT_DIFF' });
  }
});

void test('lint list is the sorted unique union of supported A/R targets and the whole registry', () => {
  const changes = parseNameStatus(
    'A\0z.ts\0A\0a.tsx\0A\0tool.js\0R100\0old.js\0b.mjs\0A\0legacy.cjs\0R100\0old.cjs\0renamed.cjs\0C100\0source.ts\0copy.ts\0M\0minimal.ts\0D\0gone.ts\0A\0z.ts\0',
  );
  const reworked = ['unchanged.ts', 'z.ts'];
  assert.deepEqual(buildLintFiles(changes, reworked, new Set(reworked)), [
    'a.tsx',
    'b.mjs',
    'tool.js',
    'unchanged.ts',
    'z.ts',
  ]);
  assert.deepEqual(buildLintFiles([], [], new Set()), []);
});

void test('missing registry files fail even with no A/R files', () => {
  assert.throws(() => buildLintFiles([], ['missing.ts'], new Set()), {
    code: 'ERR_FORK_POLICY',
    message: /missing\.ts/,
  });
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

/** @param {string} root @param {string} path @param {string} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'fixture-main');
  for (const path of ['unchanged.ts', 'minimal.ts', 'old name.js'])
    put(root, path, `// ${path}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Upstream fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${commit}\n`);
  put(root, 'FORK.md', policyText());
  return { root, commit };
}

void test('readGateInputs reads policy and verifies a real ancestor commit', (t) => {
  const { root, commit } = repository(t);
  assert.deepEqual(readGateInputs(root), {
    base: { tag: 'v1.0.0', commit },
    policy: { maxAddedLinesPerFile: 10, reworkedFiles: [] },
  });
});

void test('collectLintFiles uses the pinned base, includes earlier fork additions and unchanged registry files', (t) => {
  const { root } = repository(t);
  put(root, 'earlier fork.ts', '// earlier fork addition\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Earlier fork fixture');
  git(root, 'branch', 'main');
  put(root, 'new file.tsx', '// new\n');
  put(root, 'tool.mjs', '// new tool\n');
  put(root, 'ignored.cjs', '// unsupported extension\n');
  put(root, 'minimal.ts', '// minimally modified upstream\n');
  git(root, 'mv', 'old name.js', 'renamed file.js');
  put(root, 'FORK.md', policyText(undefined, '["unchanged.ts"]'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Current fork fixture');
  assert.deepEqual(collectLintFiles(root), [
    'earlier fork.ts',
    'new file.tsx',
    'renamed file.js',
    'tool.mjs',
    'unchanged.ts',
  ]);
});

void test('invalid registry cannot hide behind an empty Git diff', (t) => {
  const { root } = repository(t);
  put(root, 'FORK.md', policyText(undefined, '["missing.ts"]'));
  assert.throws(() => readGateInputs(root), {
    code: 'ERR_FORK_POLICY',
    message: /missing\.ts/,
  });
  assert.throws(() => collectLintFiles(root), {
    code: 'ERR_FORK_POLICY',
    message: /missing\.ts/,
  });
  mkdirSync(join(root, 'directory.ts'));
  put(root, 'FORK.md', policyText(undefined, '["directory.ts"]'));
  assert.throws(() => collectLintFiles(root), {
    code: 'ERR_FORK_POLICY',
    message: /directory\.ts/,
  });
});

void test('missing policy file fails without treating the registry as empty', (t) => {
  const { root } = repository(t);
  rmSync(join(root, 'FORK.md'));
  assert.throws(() => readGateInputs(root), { code: 'ERR_FORK_POLICY' });
});

void test('missing base file and unavailable commit are errors, not empty inputs', (t) => {
  const { root } = repository(t);
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${'f'.repeat(40)}\n`);
  assert.throws(() => readGateInputs(root), { code: 'ERR_UPSTREAM_BASE' });
  rmSync(join(root, 'fork/upstream-base'));
  assert.throws(() => readGateInputs(root), { code: 'ERR_UPSTREAM_BASE' });
});

void test('existing non-commit object and non-ancestor commit are invalid bases', (t) => {
  const { root, commit } = repository(t);
  const blob = git(root, 'rev-parse', 'HEAD:unchanged.ts');
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${blob}\n`);
  assert.throws(() => readGateInputs(root), { code: 'ERR_UPSTREAM_BASE' });
  put(root, 'side.ts', '// side branch\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Side branch fixture');
  const side = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--detach', commit);
  put(root, 'fork/upstream-base', `tag=v1.0.0\ncommit=${side}\n`);
  put(root, 'FORK.md', policyText());
  assert.throws(() => readGateInputs(root), { code: 'ERR_UPSTREAM_BASE' });
});

void test('a broken Git repository fails instead of returning an empty lint list', (t) => {
  const { root } = repository(t);
  rmSync(join(root, '.git'), { recursive: true });
  assert.throws(() => collectLintFiles(root), { code: 'ERR_GIT' });
});
