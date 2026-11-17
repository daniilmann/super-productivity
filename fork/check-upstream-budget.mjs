import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNameStatus, readGateInputs } from './gate-policy.mjs';

/**
 * @typedef {import('./gate-policy.mjs').Change} Change
 * @typedef {import('./gate-policy.mjs').Policy} Policy
 * @typedef {{path: string, oldPath?: string, added: number|null, deleted: number|null}} Stat
 */

/** @param {string} message @returns {Error & {code: string}} */
const invalidDiff = (message) =>
  Object.assign(new Error(message), { code: 'ERR_GIT_DIFF' });

/** @param {string} value @returns {number|null} */
const countLines = (value) => {
  if (value === '-') return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalidDiff(`Invalid numstat line count: ${value}`);
  }
  return Number(value);
};

/** @param {string} output @returns {Stat[]} */
export const parseNumstat = (output) => {
  if (output === '') return [];
  const fields = output.split('\0');
  if (fields.pop() !== '') throw invalidDiff('Unterminated numstat output');
  /** @type {Stat[]} */
  const stats = [];
  for (let index = 0; index < fields.length; ) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(fields[index++]);
    if (!match) throw invalidDiff('Invalid numstat record');
    const added = countLines(match[1]);
    const deleted = countLines(match[2]);
    if ((added === null) !== (deleted === null)) {
      throw invalidDiff('Mismatched binary numstat markers');
    }
    const oldPath = match[3] === '' ? fields[index++] : undefined;
    const path = oldPath === undefined ? match[3] : fields[index++];
    if (!path || oldPath === '') throw invalidDiff('Missing numstat path');
    stats.push(
      oldPath === undefined
        ? { path, added, deleted }
        : { path, oldPath, added, deleted },
    );
  }
  return stats;
};

/**
 * @param {Change[]} changes
 * @param {Stat[]} stats
 * @param {Policy} policy
 * @returns {string[]}
 */
export const checkUpstreamBudget = (changes, stats, policy) => {
  const exempt = new Set(policy.reworkedFiles);
  /** @type {Set<string>} */
  const checked = new Set();
  const byPath = new Map(stats.map((stat) => [stat.path, stat]));
  /** @type {string[]} */
  const errors = [];
  for (const change of changes) {
    if (
      !['M', 'R', 'T'].includes(change.status) ||
      exempt.has(change.path) ||
      checked.has(change.path)
    )
      continue;
    checked.add(change.path);
    const stat = byPath.get(change.path);
    if (!stat || stat.oldPath !== change.oldPath) {
      errors.push(`MISSING_NUMSTAT: ${change.path}`);
    } else if (stat.added === null || stat.deleted === null) {
      errors.push(`BUDGET_NOT_APPLICABLE: ${change.path}: бюджет строк неприменим`);
    } else if (stat.added > policy.maxAddedLinesPerFile) {
      errors.push(
        `BUDGET_EXCEEDED: ${change.path}: added ${stat.added} > limit ${policy.maxAddedLinesPerFile}`,
      );
    }
  }
  return errors;
};

/** @param {string} repoRoot @param {string} commit @param {string} format @returns {string} */
const diff = (repoRoot, commit, format) => {
  try {
    return execFileSync(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--find-renames',
        format,
        '-z',
        `${commit}...HEAD`,
        '--',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw Object.assign(new Error(`Cannot read upstream diff: ${String(error)}`), {
      code: 'ERR_GIT',
    });
  }
};

/** @param {string} repoRoot @returns {string[]} */
export const checkRepositoryBudget = (repoRoot) => {
  const { base, policy } = readGateInputs(repoRoot);
  return checkUpstreamBudget(
    parseNameStatus(diff(repoRoot, base.commit, '--name-status')),
    parseNumstat(diff(repoRoot, base.commit, '--numstat')),
    policy,
  );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = checkRepositoryBudget(process.cwd());
    if (errors.length > 0) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('Upstream change budget passed.');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
