import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpstreamBase } from './gate-policy.mjs';

const PINNED_PACKAGES = [
  'packages/shared-schema',
  'packages/sync-core',
  'packages/super-sync-server',
];

/**
 * Compares committed package trees; index and working files are not inputs.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export const checkPinnedPackages = (repoRoot) => {
  const base = readUpstreamBase(repoRoot);
  let output;
  try {
    // Disabling rename detection reports both endpoints within the path scope.
    output = execFileSync(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--no-renames',
        '--name-only',
        '-z',
        base.commit,
        'HEAD',
        '--',
        ...PINNED_PACKAGES,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw Object.assign(new Error(`Cannot compare pinned packages: ${String(error)}`), {
      code: 'ERR_GIT',
    });
  }
  return [...new Set(output.split('\0').filter((path) => path !== ''))]
    .sort()
    .map((path) => `PINNED_PACKAGE_CHANGED: ${path}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const diagnostics = checkPinnedPackages(process.cwd());
    if (diagnostics.length > 0) {
      console.error(diagnostics.join('\n'));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
