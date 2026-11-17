import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{maxAddedLinesPerFile: number, reworkedFiles: string[]}} Policy
 * @typedef {{tag: string, commit: string}} Base
 * @typedef {{status: string, path: string, oldPath?: string}} Change
 */

/** @param {string} code @param {string} message @returns {Error & {code: string}} */
const failure = (code, message) => Object.assign(new Error(message), { code });

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {value is string[]} */
const isStrings = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** @param {string} path @returns {boolean} */
const supported = (path) => /\.(?:ts|tsx|js|mjs)$/.test(path);

/** @param {string[]} files @returns {void} */
const validateRegistry = (files) => {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const path of files) {
    if (
      !supported(path) ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      posix.normalize(path) !== path ||
      seen.has(path)
    ) {
      throw failure('ERR_FORK_POLICY', `Invalid or duplicate reworked path: ${path}`);
    }
    seen.add(path);
  }
};

/** @param {string} markdown @param {string} heading @returns {unknown} */
const sectionJson = (markdown, heading) => {
  // Only level-two sections outside fenced code establish policy boundaries.
  /** @type {{heading: string, lines: string[]}[]} */
  const sections = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (!fenced && line.startsWith('## ')) {
      sections.push({
        heading: line.slice(3).trim(),
        lines: [],
      });
    } else {
      sections.at(-1)?.lines.push(line);
    }
    if (/^```/.test(line)) fenced = !fenced;
  }
  const matches = sections.filter((section) => section.heading === heading);
  const body = matches[0]?.lines.join('\n') ?? '';
  const blocks = [...body.matchAll(/^```json\s*\n([\s\S]*?)^```[ \t]*$/gm)];
  if (
    matches.length !== 1 ||
    blocks.length !== 1 ||
    [...body.matchAll(/^```/gm)].length !== 2
  ) {
    throw failure('ERR_FORK_POLICY', `Expected one JSON block in section: ${heading}`);
  }
  try {
    return /** @type {unknown} */ (JSON.parse(blocks[0][1]));
  } catch {
    throw failure('ERR_FORK_POLICY', `Invalid JSON in section: ${heading}`);
  }
};

/** @param {string} markdown @returns {Policy} */
export const parseForkPolicy = (markdown) => {
  const budget = sectionJson(markdown, 'Upstream change budget');
  const registry = sectionJson(markdown, 'Reworked upstream files');
  if (
    !isRecord(budget) ||
    typeof budget.maxAddedLinesPerFile !== 'number' ||
    !Number.isSafeInteger(budget.maxAddedLinesPerFile) ||
    budget.maxAddedLinesPerFile < 0
  ) {
    throw failure(
      'ERR_FORK_POLICY',
      'maxAddedLinesPerFile must be a nonnegative safe integer',
    );
  }
  if (!isStrings(registry)) {
    throw failure('ERR_FORK_POLICY', 'Reworked upstream files must be a string array');
  }
  validateRegistry(registry);
  return { maxAddedLinesPerFile: budget.maxAddedLinesPerFile, reworkedFiles: registry };
};

/** @param {string} text @returns {Base} */
export const parseUpstreamBase = (text) => {
  const match = /^tag=([^\s=]+)\r?\ncommit=([a-fA-F0-9]{40})\r?\n?$/.exec(text);
  if (!match)
    throw failure('ERR_UPSTREAM_BASE', 'Expected tag and full upstream commit SHA');
  return { tag: match[1], commit: match[2] };
};

/** @param {string} output @returns {Change[]} */
export const parseNameStatus = (output) => {
  if (output === '') return [];
  const fields = output.split('\0');
  if (fields.pop() !== '')
    throw failure('ERR_GIT_DIFF', 'Unterminated name-status output');
  /** @type {Change[]} */
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const token = fields[index++];
    if (!/^(?:[ADMTUXB]|[RC]\d{1,3})$/.test(token)) {
      throw failure('ERR_GIT_DIFF', `Invalid name-status: ${token}`);
    }
    const status = token[0];
    const first = fields[index++];
    const path = status === 'R' || status === 'C' ? fields[index++] : first;
    if (!first || !path) throw failure('ERR_GIT_DIFF', 'Missing name-status path');
    changes.push(
      status === 'R' || status === 'C'
        ? { status, oldPath: first, path }
        : { status, path },
    );
  }
  return changes;
};

/**
 * @param {Change[]} changes
 * @param {string[]} reworkedFiles
 * @param {Set<string>} existingFiles
 * @returns {string[]}
 */
export const buildLintFiles = (changes, reworkedFiles, existingFiles) => {
  validateRegistry(reworkedFiles);
  for (const path of reworkedFiles) {
    if (!existingFiles.has(path)) {
      throw failure('ERR_FORK_POLICY', `Missing reworked file: ${path}`);
    }
  }
  const added = changes
    .filter(({ status, path }) => (status === 'A' || status === 'R') && supported(path))
    .map(({ path }) => path);
  return [...new Set([...added, ...reworkedFiles])].sort();
};

/** @param {string} repoRoot @param {string[]} args @param {string} code @returns {string} */
const git = (repoRoot, args, code) => {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw failure(code, `git ${args.join(' ')}: ${String(error)}`);
  }
};

/** @param {string} path @param {string} code @returns {string} */
const read = (path, code) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw failure(code, `Cannot read ${path}: ${String(error)}`);
  }
};

/** @param {string} path @returns {boolean} */
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** @param {string} repoRoot @returns {{base: Base, policy: Policy}} */
export const readGateInputs = (repoRoot) => {
  git(repoRoot, ['rev-parse', '--git-dir'], 'ERR_GIT');
  const base = parseUpstreamBase(
    read(join(repoRoot, 'fork/upstream-base'), 'ERR_UPSTREAM_BASE'),
  );
  if (
    git(repoRoot, ['cat-file', '-t', base.commit], 'ERR_UPSTREAM_BASE').trim() !==
    'commit'
  ) {
    throw failure('ERR_UPSTREAM_BASE', `Upstream object is not a commit: ${base.commit}`);
  }
  git(
    repoRoot,
    ['merge-base', '--is-ancestor', base.commit, 'HEAD'],
    'ERR_UPSTREAM_BASE',
  );
  const policy = parseForkPolicy(read(join(repoRoot, 'FORK.md'), 'ERR_FORK_POLICY'));
  const existing = new Set(
    policy.reworkedFiles.filter((path) => isFile(join(repoRoot, path))),
  );
  buildLintFiles([], policy.reworkedFiles, existing);
  return { base, policy };
};

/** @param {string} repoRoot @returns {string[]} */
export const collectLintFiles = (repoRoot) => {
  const { base, policy } = readGateInputs(repoRoot);
  const changes = parseNameStatus(
    git(
      repoRoot,
      [
        'diff',
        '--no-ext-diff',
        '--no-renames',
        '--find-renames',
        '--name-status',
        '-z',
        '--diff-filter=AR',
        `${base.commit}...HEAD`,
        '--',
      ],
      'ERR_GIT',
    ),
  );
  return buildLintFiles(changes, policy.reworkedFiles, new Set(policy.reworkedFiles));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(collectLintFiles(process.cwd()), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
