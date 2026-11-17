import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runForkLint } from './run-fork-lint.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @typedef {{message: string, severity: number, ruleId: string|null}} ProbeMessage
 * @typedef {{filePath: string, messages: ProbeMessage[]}} ProbeResult
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {boolean} condition @param {string} message @returns {void} */
const requireProbe = (condition, message) => {
  if (!condition) throw new Error(`FORK_LINT_PROBE: ${message}`);
};

/** @param {string} name @returns {string} */
const packageVersion = (name) => {
  const metadata = /** @type {unknown} */ (
    JSON.parse(readFileSync(join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'))
  );
  if (!isRecord(metadata) || typeof metadata.version !== 'string') {
    throw new Error(`Cannot read version of ${name}`);
  }
  return metadata.version;
};

/** @param {string} output @returns {ProbeResult[]} */
const lintReport = (output) => {
  const report = /** @type {unknown} */ (JSON.parse(output));
  if (!Array.isArray(report)) throw new Error('Probe received a non-array ESLint report');
  const rows = /** @type {unknown[]} */ (report);
  // Validate only the fields consumed by this probe, before narrowing the report.
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.filePath !== 'string' ||
      !Array.isArray(row.messages)
    ) {
      throw new Error('Probe received an invalid ESLint result');
    }
    for (const message of /** @type {unknown[]} */ (row.messages)) {
      if (
        !isRecord(message) ||
        typeof message.message !== 'string' ||
        typeof message.severity !== 'number' ||
        !(message.ruleId === null || typeof message.ruleId === 'string')
      ) {
        throw new Error('Probe received an invalid ESLint message');
      }
    }
  }
  return /** @type {ProbeResult[]} */ (rows);
};

/**
 * @param {string[]} files
 * @returns {{outcome: ReturnType<typeof runForkLint>, report: ProbeResult[]}}
 */
const inspect = (files) => {
  let stdout = '';
  const outcome = runForkLint(files, {
    repoRoot,
    runProcess: (command, args, options) => {
      requireProbe(
        args.at(-files.length - 1) === '--',
        'Missing ESLint positional separator',
      );
      // Capture the real process report while using the regular runner's coverage checks.
      const result = spawnLint(command, args, options);
      stdout = result.stdout;
      return result;
    },
  });
  console.log(`Probe files: ${JSON.stringify(files)}`);
  if (outcome.errors.length > 0) console.log(JSON.stringify(outcome.errors, null, 2));
  requireProbe(
    !outcome.errors.includes('INVALID_ESLINT_JSON'),
    'ESLint did not produce valid JSON',
  );
  return { outcome, report: lintReport(stdout) };
};

/** @type {import('./run-fork-lint.mjs').RunProcess} */
const spawnLint = (command, args, options) => {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const stdout = /** @type {unknown} */ (result.stdout);
  return {
    status: result.status,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n'),
  };
};

/** @param {import('eslint').ESLint} eslint @param {string[]} files @returns {Promise<void>} */
const checkConfiguration = async (eslint, files) => {
  const requiredRules = [
    '@typescript-eslint/no-floating-promises',
    '@typescript-eslint/no-misused-promises',
    '@typescript-eslint/no-unsafe-assignment',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-member-access',
    '@typescript-eslint/no-unsafe-return',
  ];
  for (const path of files) {
    const config = /** @type {unknown} */ (await eslint.calculateConfigForFile(path));
    if (!isRecord(config) || !isRecord(config.rules)) {
      throw new Error(`No effective configuration: ${JSON.stringify(path)}`);
    }
    for (const id of requiredRules) {
      const rule = config.rules[id];
      const severity = Array.isArray(rule) ? /** @type {unknown} */ (rule[0]) : rule;
      requireProbe(
        severity === 2 || severity === 'error',
        `${id} is not an error for ${JSON.stringify(path)}`,
      );
    }
    const limits = {
      complexity: { max: 30, variant: 'classic' },
      'max-lines': { max: 400, skipBlankLines: true, skipComments: true },
    };
    for (const [id, expected] of Object.entries(limits)) {
      const rule = config.rules[id];
      const actual = Array.isArray(rule) ? /** @type {unknown} */ (rule[1]) : undefined;
      requireProbe(
        Array.isArray(rule) &&
          (rule[0] === 2 || rule[0] === 'error') &&
          rule.length === 2 &&
          isRecord(actual) &&
          Object.keys(actual).length === Object.keys(expected).length &&
          Object.entries(expected).every(([key, value]) => actual[key] === value),
        `${id} options differ from ${JSON.stringify(expected)} for ${JSON.stringify(path)}`,
      );
    }
    const options = config.linterOptions;
    requireProbe(
      isRecord(options) && options.noInlineConfig === true,
      `Inline config is enabled: ${JSON.stringify(path)}`,
    );
  }
};

/**
 * @param {ReturnType<typeof inspect>} result
 * @param {string} path
 * @param {string} rule
 * @returns {void}
 */
const expectViolation = (result, path, rule) => {
  const row = result.report.find((entry) => relative(repoRoot, entry.filePath) === path);
  requireProbe(
    row?.messages.some((message) => message.ruleId === rule && message.severity === 2) ===
      true,
    `Expected ${rule} in ${JSON.stringify(path)}; report: ${JSON.stringify(result.report)}`,
  );
  requireProbe(
    result.outcome.errors.includes(`ESLINT_EXIT: 1`),
    `ESLint did not reject ${JSON.stringify(path)}`,
  );
  requireProbe(
    !result.outcome.errors.some((error) =>
      /^(?:ESLINT_FATAL|MISSING_ESLINT_RESULT):/.test(error),
    ),
    `Parsing or coverage failed: ${JSON.stringify(result.outcome.errors)}`,
  );
};

/** @returns {Promise<void>} */
const probe = async () => {
  const started = performance.now();
  /** @type {string[]} */
  const cleanup = [];
  try {
    console.log(
      `HEAD ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()}`,
    );
    for (const name of ['eslint', 'typescript', 'typescript-eslint']) {
      console.log(`${name} ${packageVersion(name)}`);
    }
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: 'eslint.fork.config.js',
    });
    const directory = mkdtempSync(join(repoRoot, 'src/app/fork-lint-probe-'));
    cleanup.push(directory);
    const mjs = join('fork', `${basename(directory)}.mjs`);
    cleanup.push(join(repoRoot, mjs));
    const ts = relative(repoRoot, join(directory, 'typed.ts'));
    const spec = relative(repoRoot, join(directory, 'typed.spec.ts'));
    const complexity = relative(repoRoot, join(directory, 'complexity.ts'));
    const size = relative(repoRoot, join(directory, 'size.ts'));
    const inline = relative(repoRoot, join(directory, 'inline.ts'));
    const ignoredDirectory = mkdtempSync(join(repoRoot, '.tmp/fork-lint-probe-'));
    cleanup.push(ignoredDirectory);
    const ignored = relative(repoRoot, join(ignoredDirectory, 'ignored.ts'));
    const dash = `--${basename(directory)}.ts`;
    cleanup.push(join(repoRoot, dash));
    const floating = 'Promise.resolve(1);\n';
    writeFileSync(join(repoRoot, ts), floating);
    writeFileSync(join(repoRoot, spec), floating);
    writeFileSync(join(repoRoot, mjs), floating);
    writeFileSync(
      join(repoRoot, inline),
      `// eslint-disable-next-line @typescript-eslint/no-floating-promises\n${floating}`,
    );
    writeFileSync(
      join(repoRoot, complexity),
      `export const complexProbe = (value: number): number => {\n${Array.from({ length: 31 }, (_, index) => `if (value === ${String(index)}) { return ${String(index)}; }`).join('\n')}\nreturn -1;\n};\n`,
    );
    writeFileSync(
      join(repoRoot, size),
      Array.from(
        { length: 401 },
        (_, index) => `export const probeLine${String(index)} = ${String(index)};\n`,
      ).join(''),
    );
    writeFileSync(join(repoRoot, ignored), 'export const ignoredProbe = 1;\n');
    writeFileSync(join(repoRoot, dash), 'export {};\n');
    await checkConfiguration(eslint, [ts, spec, mjs, 'eslint.fork.config.js']);
    const negatives = inspect([ts, spec, mjs, complexity, size, inline]);
    for (const path of [ts, spec, mjs, inline]) {
      expectViolation(negatives, path, '@typescript-eslint/no-floating-promises');
    }
    expectViolation(negatives, complexity, 'complexity');
    expectViolation(negatives, size, 'max-lines');
    const dashResult = inspect([dash]);
    requireProbe(
      dashResult.report.some((row) => relative(repoRoot, row.filePath) === dash),
      'Leading-dash path was not treated as a file',
    );
    const ignoredResult = inspect([ignored]);
    requireProbe(
      ignoredResult.outcome.errors.includes(`ESLINT_IGNORED: ${ignored}`),
      `Global upstream ignore was not rejected: ${JSON.stringify(ignoredResult)}`,
    );
    // Positive controls prove actual project membership and self-lint, not just enabled rule names.
    for (const path of [ts, spec, mjs])
      writeFileSync(join(repoRoot, path), 'export {};\n');
    const positive = inspect([ts, spec, mjs, 'eslint.fork.config.js']);
    requireProbe(
      positive.outcome.errors.length === 0,
      `Positive controls failed: ${JSON.stringify(positive.outcome.errors)}`,
    );
    console.log(
      'Fork lint probe passed; the following regular lint step checks the current file list.',
    );
  } finally {
    for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
    console.log(
      `Probe time: ${((performance.now() - started) / 1000).toFixed(2)} s; peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB (probe process)`,
    );
  }
};

try {
  mkdirSync(join(repoRoot, '.tmp'), { recursive: true });
  await probe();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
