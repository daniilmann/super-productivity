import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag, versionCode } from './apply-identity.mjs';

const OID = /^[0-9a-f]{40}$/;
const ZERO_OID = '0'.repeat(40);
const TAG_PREFIX = 'refs/tags/';
const CHECKED_TAG = 'refs/release-check/tag';
const PREVIOUS_TAG = 'refs/release-check/previous';
const FAST_ANNOTATION = 'Release-Mode: fast\n';
const FIRST_SAVE_API_TAG = 'v20.0.0-fork.5';
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
 * @param {{event: string, ref: string, sha: string, after?: string, before?: string,
 *          created?: string, deleted?: string, forced?: string, build?: boolean}} run
 */
export function inspectTag(
  root,
  { event, ref, sha, after, before, created, deleted, forced, build },
) {
  if (event !== 'push' && event !== 'workflow_dispatch')
    throw new Error('unsupported tag event');
  if (event === 'workflow_dispatch' && build)
    throw new Error('manual builds require a branch');
  if (!ref.startsWith(TAG_PREFIX) || !OID.test(sha))
    throw new Error('expected a tag ref and a full event SHA');
  const tag = ref.slice(TAG_PREFIX.length);
  tagCode(tag);
  if (
    event === 'push' &&
    (created !== 'true' ||
      before !== ZERO_OID ||
      deleted !== 'false' ||
      forced !== 'false')
  )
    throw new Error('tag push must create a new tag');
  fetchTag(root, tag, CHECKED_TAG);
  const oid = git(root, 'rev-parse', CHECKED_TAG).trim();
  if (event === 'push' && after !== oid)
    throw new Error('tag object differs from the push payload');
  const commit = git(root, 'rev-parse', `${CHECKED_TAG}^{commit}`).trim();
  if (commit !== sha || commit !== git(root, 'rev-parse', 'HEAD').trim())
    throw new Error('tag target differs from the event commit or checkout');

  const type = git(root, 'cat-file', '-t', oid).trim();
  let mode = 'full';
  if (type === 'tag') {
    const object = git(root, 'cat-file', 'tag', oid);
    const header = `object ${commit}\ntype commit\ntag ${tag}\n`;
    if (!object.startsWith(header))
      throw new Error('annotated tag must name the ref and point directly at the commit');
    const bodyStart = object.indexOf('\n\n', header.length - 1);
    if (bodyStart < 0) throw new Error('invalid annotated tag object');
    if (
      event === 'push' &&
      tag !== FIRST_SAVE_API_TAG &&
      object.slice(bodyStart + 2) === FAST_ANNOTATION
    )
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} root @param {string} statsFile */
function productionInputs(root, statsFile) {
  /** @type {unknown} */
  let graph;
  try {
    graph = JSON.parse(readFileSync(statsFile, 'utf8'));
  } catch (cause) {
    throw new Error(`cannot read Angular build graph ${statsFile}`, { cause });
  }
  if (
    !isRecord(graph) ||
    !isRecord(graph.inputs) ||
    !isRecord(graph.outputs) ||
    !Object.values(graph.inputs).every(isRecord)
  ) {
    throw new Error(`invalid Angular build graph ${statsFile}`);
  }
  for (const [file, output] of Object.entries(graph.outputs)) {
    if (!isRecord(output) || !isRecord(output.inputs)) {
      throw new Error(
        `incomplete Angular build graph ${statsFile}: output ${file} needs an inputs map`,
      );
    }
    for (const input of Object.keys(output.inputs)) {
      if (!Object.hasOwn(graph.inputs, input)) {
        throw new Error(
          `incomplete Angular build graph ${statsFile}: output ${file} references missing input ${input}`,
        );
      }
    }
    if (Object.hasOwn(output, 'entryPoint')) {
      const { entryPoint } = output;
      if (typeof entryPoint !== 'string') {
        throw new Error(
          `invalid Angular build graph ${statsFile}: output ${file} has a non-string entryPoint`,
        );
      }
      if (!Object.hasOwn(graph.inputs, entryPoint)) {
        throw new Error(
          `incomplete Angular build graph ${statsFile}: output ${file} has missing entryPoint input ${entryPoint}`,
        );
      }
    }
  }
  const inputs = new Set(
    Object.keys(graph.inputs).map((file) =>
      relative(root, resolve(root, file.replaceAll('\\', '/')))
        .split(sep)
        .join('/'),
    ),
  );
  if (
    !inputs.has('src/main.ts') ||
    !Object.keys(graph.outputs).some((file) => file.endsWith('.js'))
  ) {
    throw new Error(
      `incomplete Angular build graph ${statsFile}: expected src/main.ts and JavaScript output`,
    );
  }
  return inputs;
}

/** @param {string} root @param {string} dir @param {string} statsFile */
export function checkWebSpecs(root, dir, statsFile) {
  const specs = git(root, 'ls-files', '-z', '--', ':(glob)src/**/*.fork.spec.ts')
    .split('\0')
    .filter(Boolean);
  if (!specs.length) throw new Error('no fork Angular specs found');
  const inputs = productionInputs(root, statsFile);
  const spec = specs.find((file) => inputs.has(file));
  if (spec) throw new Error(`fork Angular spec ${spec} found in ${statsFile} inputs`);
  const titles = specs.flatMap((file) => {
    const source = readFileSync(join(root, file), 'utf8');
    return Array.from(
      source.matchAll(/\bdescribe\(\s*(['"])(.+?)\1/g),
      (match) => match[2],
    );
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
  console.log(
    `Checked ${String(specs.length)} fork Angular spec paths in ${statsFile} and ${String(titles.length)} suite titles in ${dir}`,
  );
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
  } else if (command === 'check-web-specs') {
    if (!arg || !oid)
      throw new Error('expected check-web-specs <built-dir> <browser-stats.json>');
    checkWebSpecs('.', arg, oid);
  } else if (command === 'inspect-tag') {
    const route = inspectTag('.', {
      event: env.GITHUB_EVENT_NAME ?? '',
      ref: env.GITHUB_REF ?? '',
      sha: env.GITHUB_SHA ?? '',
      after: env.PUSH_AFTER,
      before: env.PUSH_BEFORE,
      created: env.PUSH_CREATED,
      deleted: env.PUSH_DELETED,
      forced: env.PUSH_FORCED,
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
