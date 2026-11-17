import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { parseEslintReport, runForkLint } from './run-fork-lint.mjs';

/**
 * @typedef {{ruleId: string|null, severity: number, message: string, fatal?: boolean}} Message
 * @typedef {{filePath: string, messages: Message[], errorCount: number,
 * warningCount: number, fatalErrorCount: number}} Result
 * @typedef {{status: number|null, stdout: string, stderr: string}} ProcessResult
 * @typedef {(command: string, args: string[], options: {cwd: string, shell: false}) => ProcessResult} RunProcess
 */

const ROOT = join(tmpdir(), 'fork lint report root');
const FILES = ['src/reworked file.ts', 'fork/new.mjs'];

/** @param {string} path @param {Partial<Result>} [patch] @returns {Result} */
function result(path, patch = {}) {
  return {
    filePath: join(ROOT, path),
    messages: [],
    errorCount: 0,
    warningCount: 0,
    fatalErrorCount: 0,
    ...patch,
  };
}

/** @param {Result[]} rows */
function report(rows = FILES.map((path) => result(path))) {
  return JSON.stringify(rows);
}

void test('absolute ESLint paths cover expected relative paths, irrespective of result order', () => {
  assert.deepEqual(
    parseEslintReport(
      report(FILES.toReversed().map((path) => result(path))),
      FILES,
      ROOT,
    ),
    [],
  );
  assert.deepEqual(
    parseEslintReport(
      report(FILES.map((filePath) => result(filePath, { filePath }))),
      FILES,
      ROOT,
    ),
    [],
  );
});

void test('every expected file must be covered, including an unchanged registry entry', () => {
  assert.deepEqual(parseEslintReport(report([result(FILES[1])]), FILES, ROOT), [
    `MISSING_ESLINT_RESULT: ${FILES[0]}`,
  ]);
  assert.deepEqual(
    parseEslintReport('[]', FILES, ROOT),
    FILES.map((path) => `MISSING_ESLINT_RESULT: ${path}`),
  );
});

void test('the same basename in another directory does not count as coverage', () => {
  const path = 'src/reworked file.ts';
  assert.ok(
    parseEslintReport(report([result('other/reworked file.ts')]), [path], ROOT).includes(
      `MISSING_ESLINT_RESULT: ${path}`,
    ),
  );
});

for (const message of [
  'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings.',
  'File ignored because no matching configuration was supplied.',
  'No matching configuration found for this file.',
]) {
  void test(`a present result with an ignored/no-configuration warning fails: ${message}`, () => {
    const rows = [
      result(FILES[0], {
        warningCount: 1,
        messages: [{ ruleId: null, severity: 1, message }],
      }),
      result(FILES[1]),
    ];
    assert.ok(
      parseEslintReport(report(rows), FILES, ROOT).includes(
        `ESLINT_IGNORED: ${FILES[0]}`,
      ),
    );
  });
}

void test('fatal and parser errors are errors of coverage, even when the path is present', () => {
  const cases = [
    { fatalErrorCount: 1 },
    {
      errorCount: 1,
      messages: [{ ruleId: null, severity: 2, fatal: true, message: 'Unexpected token' }],
    },
    {
      errorCount: 1,
      messages: [
        { ruleId: null, severity: 2, message: 'Parsing error: Unexpected token' },
      ],
    },
  ];
  for (const patch of cases) {
    assert.ok(
      parseEslintReport(report([result(FILES[0], patch)]), [FILES[0]], ROOT).includes(
        `ESLINT_FATAL: ${FILES[0]}`,
      ),
    );
  }
});

void test('lint errors and warnings fail on counts or actual message severities', () => {
  for (const severity of [1, 2]) {
    const code = severity === 1 ? 'ESLINT_WARNINGS' : 'ESLINT_ERRORS';
    const count = severity === 1 ? { warningCount: 1 } : { errorCount: 1 };
    const messages = [
      { ruleId: 'fixture-rule', severity, message: 'A real lint finding' },
    ];
    for (const patch of [count, { messages }]) {
      assert.ok(
        parseEslintReport(report([result(FILES[0], patch)]), [FILES[0]], ROOT).includes(
          `${code}: ${FILES[0]}`,
        ),
      );
    }
  }
});

for (const text of ['', '{', '{}', 'null', '[null]', '[{"filePath":42}]']) {
  void test(`damaged JSON or invalid report shape fails: ${JSON.stringify(text)}`, () => {
    assert.ok(parseEslintReport(text, FILES, ROOT).includes('INVALID_ESLINT_JSON'));
  });
}

void test('empty lint list succeeds with skip and never launches ESLint', () => {
  let calls = 0;
  /** @type {RunProcess} */
  const runProcess = () => {
    calls += 1;
    throw new Error('ESLint must not run for an empty list');
  };
  assert.deepEqual(runForkLint([], { repoRoot: ROOT, runProcess }), {
    skipped: true,
    errors: [],
  });
  assert.equal(calls, 0);
});

void test('runner invokes local ESLint without a shell, cache, npx or suppressed ignore warnings', () => {
  /** @type {{command: string, args: string[], options: {cwd: string, shell: false}}[]} */
  const calls = [];
  /** @type {RunProcess} */
  const runProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: report(), stderr: '' };
  };
  assert.deepEqual(runForkLint(FILES, { repoRoot: ROOT, runProcess }), {
    skipped: false,
    errors: [],
  });
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: [
        join(ROOT, 'node_modules/eslint/bin/eslint.js'),
        '-c',
        'eslint.fork.config.js',
        '--format',
        'json',
        '--max-warnings=0',
        '--',
        ...FILES,
      ],
      options: { cwd: ROOT, shell: false },
    },
  ]);
});

void test('paths with spaces and a leading dash remain literal positional arguments', () => {
  const files = ['--flag-like.ts', 'src/file with spaces.mjs'];
  /** @type {string[][]} */
  const calls = [];
  /** @type {RunProcess} */
  const runProcess = (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: report(files.map((path) => result(path))), stderr: '' };
  };
  assert.deepEqual(runForkLint(files, { repoRoot: ROOT, runProcess }), {
    skipped: false,
    errors: [],
  });
  assert.deepEqual(
    calls.map((args) => args.slice(-3)),
    [['--', ...files]],
  );
});

void test('lint exit 1 still parses JSON and checks coverage', () => {
  /** @type {RunProcess} */
  const runProcess = () => ({
    status: 1,
    stdout: report([result(FILES[1])]),
    stderr: 'lint failed',
  });
  const outcome = runForkLint(FILES, { repoRoot: ROOT, runProcess });
  assert.equal(outcome.skipped, false);
  assert.ok(outcome.errors.includes('ESLINT_EXIT: 1'));
  assert.ok(outcome.errors.includes(`MISSING_ESLINT_RESULT: ${FILES[0]}`));
});

void test('nonzero and signal exits cannot pass even with a clean JSON report', () => {
  for (const status of [1, 2, null]) {
    /** @type {RunProcess} */
    const runProcess = () => ({ status, stdout: report(), stderr: 'process diagnostic' });
    assert.ok(
      runForkLint(FILES, { repoRoot: ROOT, runProcess }).errors.includes(
        `ESLINT_EXIT: ${String(status)}`,
      ),
    );
  }
});

void test('exit zero cannot hide damaged JSON, a missing result, or lint findings', () => {
  for (const stdout of [
    '{',
    '[]',
    report([result(FILES[0], { warningCount: 1 }), result(FILES[1])]),
  ]) {
    /** @type {RunProcess} */
    const runProcess = () => ({ status: 0, stdout, stderr: '' });
    const outcome = runForkLint(FILES, { repoRoot: ROOT, runProcess });
    assert.equal(outcome.skipped, false);
    assert.notDeepEqual(outcome.errors, []);
  }
});
