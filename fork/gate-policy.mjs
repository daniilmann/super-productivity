import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
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
      throw failure(
        'ERR_FORK_POLICY',
        `Invalid or duplicate reworked path: ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
  }
};

/** @param {string} json @returns {unknown} */
const uniqueKeyJson = (json) => {
  const value = /** @type {unknown} */ (JSON.parse(json));
  /** @type {Set<string>[]} */
  const objects = [];
  // JSON.parse validates syntax; scan complete string tokens to retain duplicate keys.
  for (const token of json.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/gs)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '}') objects.pop();
    else if (
      json
        .slice(token.index + token[0].length)
        .trimStart()
        .startsWith(':')
    ) {
      const key = /** @type {unknown} */ (JSON.parse(token[0]));
      if (typeof key !== 'string') throw new Error('Invalid JSON key');
      const keys = objects.at(-1);
      if (keys?.has(key)) throw new Error('Duplicate JSON key');
      keys?.add(key);
    }
  }
  return value;
};

/** @param {string} text @returns {boolean} */
const isProse = (text) =>
  text
    .split('\n')
    .every(
      (line) =>
        line.trim() === '' ||
        (!/^(?: {4}|\t|[ \t]*(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}|~{3,}|\||<))/.test(
          line,
        ) &&
          !/^\s*(?:[-*_]\s*){3,}$/.test(line)),
    );

/** @param {string} markdown @param {string} heading @returns {unknown} */
const sectionJson = (markdown, heading) => {
  /** @type {{heading: string, lines: string[]}[]} */
  const sections = [];
  let fence = '';
  let comment = false;
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    if (!fence && !comment && /^#{1,2} /.test(line)) {
      sections.push({
        heading: line.startsWith('## ') ? line.slice(3).trim() : '',
        lines: [],
      });
    } else {
      sections.at(-1)?.lines.push(line);
    }
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = '';
    } else if (!comment && /^ {0,3}(`{3,}|~{3,})/.test(line)) {
      fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    } else {
      for (const token of line.matchAll(/<!--|-->/g)) {
        if (token[0] === '<!--') comment = true;
        else comment = false;
      }
    }
  }
  const matches = sections.filter((section) => section.heading === heading);
  const body = matches[0]?.lines.join('\n') ?? '';
  const block = /^([\s\S]*?)^```json[ \t]*\n([\s\S]*?)^```[ \t]*(?:\n|$)([\s\S]*)$/m.exec(
    body,
  );
  if (
    matches.length !== 1 ||
    body.includes('<!--') ||
    !block ||
    block[1].trim() === '' ||
    !isProse(block[1]) ||
    !isProse(block[3])
  ) {
    throw failure(
      'ERR_FORK_POLICY',
      `Expected one JSON block after prose in section: ${heading}`,
    );
  }
  try {
    return uniqueKeyJson(block[2]);
  } catch {
    throw failure(
      'ERR_FORK_POLICY',
      `Invalid JSON or duplicate key in section: ${heading}`,
    );
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
  const match = /^tag=(v\d+\.\d+\.\d+)\r?\ncommit=([a-f0-9]{40})\r?\n?$/.exec(text);
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
      throw failure('ERR_FORK_POLICY', `Missing reworked file: ${JSON.stringify(path)}`);
    }
  }
  const added = changes
    .filter(({ status, path }) => ['A', 'R', 'C'].includes(status) && supported(path))
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
    throw failure(code, `git ${JSON.stringify(args)}: ${String(error)}`);
  }
};

/** @param {string} path @param {string} code @returns {string} */
const read = (path, code) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw failure(code, `Cannot read ${JSON.stringify(path)}: ${String(error)}`);
  }
};

/** @param {string} path @returns {boolean} */
const isFile = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** @param {string} repoRoot @returns {Base} */
export const readUpstreamBase = (repoRoot) => {
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
  return base;
};

/** @param {string} repoRoot @returns {{base: Base, policy: Policy}} */
export const readGateInputs = (repoRoot) => {
  const base = readUpstreamBase(repoRoot);
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
        '-l0',
        '--name-status',
        '-z',
        '--diff-filter=ARC',
        `${base.commit}...HEAD`,
        '--',
      ],
      'ERR_GIT',
    ),
  );
  const files = buildLintFiles(
    changes,
    policy.reworkedFiles,
    new Set(policy.reworkedFiles),
  );
  for (const path of files) {
    if (!isFile(join(repoRoot, path))) {
      throw failure(
        'ERR_FORK_POLICY',
        `Lint path must be a regular file: ${JSON.stringify(path)}`,
      );
    }
  }
  return files;
};

/** @param {string} repoRoot @param {string} [mainRef] @returns {string[]} */
export const checkPolicyChanges = (repoRoot, mainRef = 'main') => {
  const base = git(repoRoot, ['merge-base', 'HEAD', mainRef], 'ERR_GIT').trim();
  const previousText = git(repoRoot, ['show', `${base}:FORK.md`], 'ERR_FORK_POLICY');
  // The first policy introduction has no prior values; malformed prior policy still fails.
  const previous = /Upstream change budget|Reworked upstream files/.test(previousText)
    ? parseForkPolicy(previousText)
    : null;
  const current = parseForkPolicy(
    git(repoRoot, ['show', 'HEAD:FORK.md'], 'ERR_FORK_POLICY'),
  );
  /** @type {string[]} */
  const warnings = [];
  for (const field of /** @type {const} */ (['maxAddedLinesPerFile', 'reworkedFiles'])) {
    const oldValue = previous?.[field] ?? null;
    const before = JSON.stringify(
      Array.isArray(oldValue) ? [...oldValue].sort() : oldValue,
    );
    const after = JSON.stringify(
      field === 'reworkedFiles' ? [...current[field]].sort() : current[field],
    );
    if (before !== after)
      warnings.push(`::warning::FORK_POLICY_CHANGED ${field}: ${before} -> ${after}`);
  }
  return warnings;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--check-policy-changes') {
      const warnings = checkPolicyChanges(process.cwd(), process.argv[3]);
      if (warnings.length > 0) console.log(warnings.join('\n'));
    } else {
      console.log(JSON.stringify(collectLintFiles(process.cwd()), null, 2));
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
