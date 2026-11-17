import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLintFiles } from './gate-policy.mjs';

/**
 * @typedef {{ruleId: string|null, severity: number, message: string, fatal?: boolean}} Message
 * @typedef {{filePath: string, messages: Message[], errorCount: number,
 * warningCount: number, fatalErrorCount: number}} Result
 * @typedef {{status: number|null, stdout: string, stderr: string}} ProcessResult
 * @typedef {(command: string, args: string[], options: {cwd: string, shell: false}) => ProcessResult} RunProcess
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {value is Message} */
const isMessage = (value) =>
  isRecord(value) &&
  (value.ruleId === null || typeof value.ruleId === 'string') &&
  typeof value.severity === 'number' &&
  [0, 1, 2].includes(value.severity) &&
  typeof value.message === 'string' &&
  (value.fatal === undefined || typeof value.fatal === 'boolean');

/** @param {unknown} value @returns {value is Result} */
const isResult = (value) =>
  isRecord(value) &&
  typeof value.filePath === 'string' &&
  Array.isArray(value.messages) &&
  value.messages.every(isMessage) &&
  [value.errorCount, value.warningCount, value.fatalErrorCount].every(
    (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
  );

/** @param {unknown} value @returns {value is Result[]} */
const isReport = (value) => Array.isArray(value) && value.every(isResult);

/** @param {string} path @param {Result} row @returns {string[]} */
const findings = (path, row) => {
  /** @type {string[]} */
  const errors = [];
  const ignored = row.messages.some(
    ({ ruleId, message }) =>
      ruleId === null && message.startsWith('File ignored because'),
  );
  const fatal =
    row.fatalErrorCount > 0 ||
    row.messages.some(
      (message) => message.fatal || /parsing error/i.test(message.message),
    );
  if (ignored) errors.push(`ESLINT_IGNORED: ${path}`);
  if (fatal) errors.push(`ESLINT_FATAL: ${path}`);
  if (row.errorCount > 0 || row.messages.some(({ severity }) => severity === 2)) {
    errors.push(`ESLINT_ERRORS: ${path}`);
  }
  if (row.warningCount > 0 || row.messages.some(({ severity }) => severity === 1)) {
    errors.push(`ESLINT_WARNINGS: ${path}`);
  }
  for (const message of row.messages) {
    if (message.severity > 0) {
      errors.push(`${path}: ${message.ruleId ?? 'configuration'}: ${message.message}`);
    }
  }
  return errors;
};

/**
 * @param {string} json
 * @param {string[]} expectedFiles
 * @param {string} repoRoot
 * @returns {string[]}
 */
export const parseEslintReport = (json, expectedFiles, repoRoot) => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return ['INVALID_ESLINT_JSON'];
  }
  if (!isReport(parsed)) return ['INVALID_ESLINT_JSON'];
  /** @type {Map<string, Result[]>} */
  const rows = new Map();
  for (const row of parsed) {
    const path = relative(repoRoot, resolve(repoRoot, row.filePath))
      .split('\\')
      .join('/');
    const entries = rows.get(path) ?? [];
    entries.push(row);
    rows.set(path, entries);
  }
  return expectedFiles.flatMap((path) => {
    const entries = rows.get(
      relative(repoRoot, resolve(repoRoot, path)).split('\\').join('/'),
    );
    return entries
      ? entries.flatMap((row) => findings(path, row))
      : [`MISSING_ESLINT_RESULT: ${path}`];
  });
};

/** @type {RunProcess} */
const runLocalProcess = (command, args, options) => {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  // Node can return null streams after a spawn failure, despite its string overload.
  const stdout = /** @type {unknown} */ (result.stdout);
  return {
    status: result.status,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n'),
  };
};

/**
 * @param {string[]} files
 * @param {{repoRoot: string, runProcess?: RunProcess}} options
 * @returns {{skipped: boolean, errors: string[]}}
 */
export const runForkLint = (files, { repoRoot, runProcess = runLocalProcess }) => {
  if (files.length === 0) return { skipped: true, errors: [] };
  try {
    const result = runProcess(
      process.execPath,
      [
        join(repoRoot, 'node_modules/eslint/bin/eslint.js'),
        '-c',
        'eslint.fork.config.js',
        '--format',
        'json',
        '--max-warnings=0',
        '--',
        ...files,
      ],
      { cwd: repoRoot, shell: false },
    );
    const errors = parseEslintReport(result.stdout, files, repoRoot);
    if (result.status !== 0) errors.push(`ESLINT_EXIT: ${String(result.status)}`);
    if (errors.length > 0 && result.stderr) errors.push(result.stderr);
    return { skipped: false, errors };
  } catch (error) {
    return { skipped: false, errors: [`ESLINT_PROCESS: ${String(error)}`] };
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = collectLintFiles(process.cwd());
    const { skipped, errors } = runForkLint(files, { repoRoot: process.cwd() });
    if (errors.length > 0) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        skipped
          ? 'Fork lint skipped: empty file list.'
          : `Fork lint passed: ${files.length} files.`,
      );
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
