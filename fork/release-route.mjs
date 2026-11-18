import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag, versionCode } from './apply-identity.mjs';

const OID = /^[0-9a-f]{40}$/;
const TAG_PREFIX = 'refs/tags/';
const CHECKED_TAG = 'refs/release-check/tag';
const PREVIOUS_TAG = 'refs/release-check/previous';
const FAST_ANNOTATION = 'Release-Mode: fast\n';
const SYNC_PATHS = [
  'fork/upstream-base',
  'src/app/imex/sync',
  'src/app/op-log',
  'packages/shared-schema',
  'packages/sync-core',
  'packages/sync-providers',
];

/** @param {string} root @param {...string} args */
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** @param {string} tag */
function tagCode(tag) {
  const version = parseTag(tag);
  if (tag !== `${version.upstreamTag}-fork.${String(version.N)}`)
    throw new Error('invalid release tag');
  return versionCode(version);
}

/** @param {string} root @param {string} tag @param {string} destination */
function fetchTag(root, tag, destination) {
  git(root, 'fetch', '--no-tags', 'origin', `+${TAG_PREFIX}${tag}:${destination}`);
}

/**
 * @param {string} root
 * @param {{event: string, ref: string, sha: string, after?: string, build?: boolean}} run
 */
export function inspectTag(root, { event, ref, sha, after, build }) {
  if (event !== 'push' && event !== 'workflow_dispatch')
    throw new Error('unsupported tag event');
  if (event === 'workflow_dispatch' && build)
    throw new Error('manual builds require a branch');
  if (!ref.startsWith(TAG_PREFIX) || !OID.test(sha))
    throw new Error('expected a tag ref and a full event SHA');
  const tag = ref.slice(TAG_PREFIX.length);
  tagCode(tag);
  fetchTag(root, tag, CHECKED_TAG);
  const oid = git(root, 'rev-parse', CHECKED_TAG).trim();
  const commit = git(root, 'rev-parse', `${CHECKED_TAG}^{commit}`).trim();
  if (commit !== sha || commit !== git(root, 'rev-parse', 'HEAD').trim())
    throw new Error('tag target differs from the event commit or checkout');
  // The push payload can identify the ref object or its commit. Check either form.
  if (event === 'push' && after !== oid && after !== commit)
    throw new Error('tag differs from the push payload');

  const type = git(root, 'cat-file', '-t', oid).trim();
  let mode = 'full';
  if (type === 'tag') {
    const object = git(root, 'cat-file', 'tag', oid);
    const header = `object ${commit}\ntype commit\ntag ${tag}\n`;
    if (!object.startsWith(header))
      throw new Error('annotated tag must name the ref and point directly at the commit');
    const bodyStart = object.indexOf('\n\n', header.length - 1);
    if (bodyStart < 0) throw new Error('invalid annotated tag object');
    if (event === 'push' && object.slice(bodyStart + 2) === FAST_ANNOTATION)
      mode = 'fast';
  } else if (type !== 'commit') {
    throw new Error('release ref must point at a commit or annotated tag');
  }

  const main = 'refs/remotes/origin/main';
  git(root, 'fetch', '--no-tags', 'origin', `+refs/heads/main:${main}`);
  try {
    git(root, 'merge-base', '--is-ancestor', commit, main);
  } catch {
    throw new Error('tag target is not reachable from origin/main');
  }
  return { tag, sha: commit, oid, mode };
}

/** @param {string} root @param {string} tag @param {string} oid */
export function verifyTag(root, tag, oid) {
  tagCode(tag);
  const ref = TAG_PREFIX + tag;
  const actual = git(root, 'ls-remote', '--refs', '--exit-code', 'origin', ref);
  if (!OID.test(oid) || actual !== `${oid}\t${ref}\n`)
    throw new Error('remote tag object differs from the checked object');
}

/**
 * @param {string} root
 * @param {string} tag
 * @param {string} sha
 * @param {() => string[]} listPublishedTags
 */
export function superSyncStatus(root, tag, sha, listPublishedTags) {
  let operation = 'list published fork releases by version';
  try {
    const current = tagCode(tag);
    const candidates = listPublishedTags()
      .filter((name) => /^v.*-fork\./.test(name))
      .map((name) => ({ name, code: tagCode(name) }))
      .filter(({ code }) => code < current)
      .sort((a, b) => b.code - a.code);
    const previous = candidates.at(0);
    if (!previous || previous.code === candidates.at(1)?.code)
      return {
        required: true,
        reason: 'no unambiguous preceding published fork release',
      };
    if (!OID.test(sha)) throw new Error('expected a full commit SHA');

    operation = `fetch the tag for ${previous.name}`;
    fetchTag(root, previous.name, PREVIOUS_TAG);
    const commit = git(root, 'rev-parse', `${PREVIOUS_TAG}^{commit}`).trim();
    operation = `compare ${previous.name} (${commit}) with ${sha}`;
    git(root, 'merge-base', '--is-ancestor', commit, sha);
    const required =
      git(
        root,
        'diff',
        '--no-ext-diff',
        '--no-renames',
        '--name-only',
        commit,
        sha,
        '--',
        ...SYNC_PATHS,
      ) !== '';
    return {
      required,
      reason: `${previous.name} (${commit}) vs ${sha}: ${required ? 'pin or sync client changed' : 'pin and sync client unchanged'}`,
    };
  } catch {
    return {
      required: true,
      reason: `could not ${operation}`,
    };
  }
}

/** @param {boolean} superSync */
export function fastNotes(superSync) {
  const skipped = [
    'unit upstream',
    'e2e Chromium upstream',
    'e2e подтверждения сохранения',
    'инструментальные тесты Android',
  ];
  if (superSync) skipped.splice(3, 0, 'e2e SuperSync upstream');
  return `Быстрый выпуск. Не прогонялись: ${skipped.join(', ')}`;
}

/** @param {string} root @param {string} dir */
export function checkWebSpecs(root, dir) {
  const specs = git(root, 'ls-files', '--', ':(glob)src/**/*.fork.spec.ts').trim();
  if (!specs) throw new Error('no fork Angular specs found');
  const titles = specs.split('\n').map((file) => {
    const title = /\bdescribe\('([^']+)'/.exec(
      readFileSync(join(root, file), 'utf8'),
    )?.[1];
    if (!title) throw new Error(`no suite title in ${file}`);
    return title;
  });
  const bundles = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.js'),
  );
  if (!bundles.length) throw new Error(`no JavaScript bundles in ${dir}`);
  for (const file of bundles) {
    const js = readFileSync(join(dir, file), 'utf8');
    const title = titles.find((name) => js.includes(name));
    if (title) throw new Error(`fork Angular suite "${title}" found in ${file}`);
  }
  console.log(`Checked ${String(titles.length)} fork Angular suites against ${dir}`);
}

/** @param {string} repository */
function publishedTags(repository) {
  return execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repository}/releases?per_page=100`,
      '--jq',
      '.[] | select(.draft == false and .published_at != null) | .tag_name',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env */
function main([command, arg, oid], env) {
  if (command === 'validate-tag' && arg) {
    tagCode(arg);
  } else if (command === 'verify-tag' && arg && oid) {
    verifyTag('.', arg, oid);
  } else if (command === 'check-web-specs' && arg) {
    checkWebSpecs('.', arg);
  } else if (command === 'inspect-tag') {
    const route = inspectTag('.', {
      event: env.GITHUB_EVENT_NAME ?? '',
      ref: env.GITHUB_REF ?? '',
      sha: env.GITHUB_SHA ?? '',
      after: env.PUSH_AFTER,
      build: env.BUILD_REQUESTED === 'true',
    });
    let notes = '';
    if (route.mode === 'fast') {
      const status = superSyncStatus('.', route.tag, route.sha, () =>
        publishedTags(env.GITHUB_REPOSITORY ?? ''),
      );
      console.log(
        `SuperSync ${status.required ? 'required' : 'not required'}: ${status.reason}`,
      );
      notes = fastNotes(status.required);
    }
    if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries({ ...route, notes })
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  } else {
    throw new Error('expected validate-tag, verify-tag, check-web-specs or inspect-tag');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(
      `release route: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
