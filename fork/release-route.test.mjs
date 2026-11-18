import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  checkWebSpecs,
  fastNotes,
  inspectTag,
  superSyncStatus,
  verifyTag,
} from './release-route.mjs';

const TAG = 'v21.0.0-fork.11';
const REF = `refs/tags/${TAG}`;
const FIRST_API_TAG = 'v20.0.0-fork.5';
const FAST = 'Release-Mode: fast\n';
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

/** @param {string} root @param {string[]} args @param {string} [input] */
function git(root, args, input) {
  const config = [
    'user.name=Release Test',
    'user.email=release-test@example.invalid',
    'commit.gpgsign=false',
  ];
  return execFileSync('git', [...config.flatMap((value) => ['-c', value]), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** @param {string} root @param {string} path @param {string} content */
function put(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** @param {string} root @param {string} ref @param {string} content */
function commit(root, ref, content) {
  put(root, ref, content);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Release fixture']);
  return git(root, ['rev-parse', 'HEAD']);
}

/** @param {import('node:test').TestContext} t */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'fork-release-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const remote = join(root, 'origin');
  const checkout = join(root, 'checkout');
  git(root, ['init', '-b', 'main', remote]);
  const base = commit(remote, 'fork/upstream-base', 'Pinned upstream');
  const sha = commit(remote, 'unrelated.txt', 'Release');
  git(root, ['clone', remote, checkout]);
  return { remote, checkout, base, sha };
}

/**
 * @param {string} remote @param {string} target @param {string} body
 * @param {{type?: string, name?: string, ref?: string}} [options]
 */
function annotate(remote, target, body, { type = 'commit', name = TAG, ref = REF } = {}) {
  const tagger = 'tagger Release Test <release-test@example.invalid> 1700000000 +0000';
  const oid = git(
    remote,
    ['hash-object', '-w', '-t', 'tag', '--stdin'],
    `object ${target}\ntype ${type}\ntag ${name}\n${tagger}\n\n${body}`,
  );
  git(remote, ['update-ref', ref, oid]);
  return oid;
}

/** @param {string} sha @param {string} after @param {string} [ref] */
const push = (sha, after, ref = REF) => ({
  event: 'push',
  ref,
  sha,
  after,
  before: '0'.repeat(40),
  created: 'true',
  deleted: 'false',
  forced: 'false',
});

void test('the documented Git command creates the exact fast annotation', (t) => {
  const { remote, checkout, sha } = repository(t);
  const args = ['tag', '--annotate', '--no-sign', '--cleanup=verbatim', '--file', '-'];
  git(remote, ['-c', 'tag.gpgsign=true', ...args, TAG, sha], FAST);
  const oid = git(remote, ['rev-parse', REF]);
  assert.equal(inspectTag(checkout, push(sha, oid)).mode, 'fast');
});

for (const [label, annotation, mode, tag = TAG] of [
  ['exact line', FAST, 'fast'],
  ['empty annotation', '', 'full'],
  ['different case', 'release-mode: fast\n', 'full'],
  ['misspelling', 'Release-Mode: fst\n', 'full'],
  ['extra line', FAST + 'other text\n', 'full'],
  ['extra newline', FAST + '\n', 'full'],
  ['trailing space', 'Release-Mode: fast \n', 'full'],
  ['CRLF', 'Release-Mode: fast\r\n', 'full'],
  ['no final LF', FAST.trimEnd(), 'full'],
  ['fast marker on the first save API tag', FAST, 'full', FIRST_API_TAG],
]) {
  void test(`annotated tag with ${label} takes the ${mode} route`, (t) => {
    const { remote, checkout, sha } = repository(t);
    const ref = `refs/tags/${tag}`;
    const oid = annotate(remote, sha, annotation, { name: tag, ref });
    const firstFast = tag === FIRST_API_TAG && annotation === FAST;
    let route;
    try {
      route = inspectTag(checkout, push(sha, oid, ref));
    } catch (error) {
      // A deliberate refusal of the first fast marker also protects the full gate.
      if (firstFast && error instanceof Error && !('status' in error)) return;
      throw error;
    }
    assert.deepEqual(route, { tag, sha, oid, mode });
  });
}

void test('the first save API tag takes the full route on a lightweight push', (t) => {
  const { remote, checkout, sha } = repository(t);
  const ref = `refs/tags/${FIRST_API_TAG}`;
  git(remote, ['update-ref', ref, sha]);
  const route = inspectTag(checkout, push(sha, sha, ref));
  assert.deepEqual(route, { tag: FIRST_API_TAG, sha, oid: sha, mode: 'full' });
});

void test('dispatch of a fast tag takes the full route and cannot request a build', (t) => {
  const { remote, checkout, sha } = repository(t);
  annotate(remote, sha, FAST);
  const run = { ref: REF, sha, event: 'workflow_dispatch' };
  assert.equal(inspectTag(checkout, run).mode, 'full');
  assert.throws(() => inspectTag(checkout, { ...run, build: true }), /require a branch/);
});

void test('validates event, full SHA, ref namespace and exact tag format', (t) => {
  const { checkout, sha } = repository(t);
  const run = push(sha, sha);
  assert.throws(() => inspectTag(checkout, { ...run, event: 'schedule' }), /unsupported/);
  for (const invalid of [{ sha: sha.slice(0, 8) }, { ref: 'refs/heads/main' }])
    assert.throws(() => inspectTag(checkout, { ...run, ...invalid }), /full event SHA/);
  for (const tag of ['v21.0.0-fork.011', TAG + '\n', 'v21.0.0-fork.1000']) {
    assert.throws(
      () => inspectTag(checkout, { ...run, ref: 'refs/tags/' + tag }),
      /tag|outside/,
    );
  }
});

void test('rejects checkout and event mismatches', (t) => {
  const { remote, checkout, sha, base } = repository(t);
  const oid = annotate(remote, sha, FAST);
  const mismatch = /differs from the event commit/;
  assert.throws(() => inspectTag(checkout, push(base, oid)), mismatch);
  git(checkout, ['checkout', '--detach', base]);
  assert.throws(() => inspectTag(checkout, push(sha, oid)), mismatch);
});

void test('rejects a tag beyond remote main', (t) => {
  const { remote, checkout } = repository(t);
  git(remote, ['checkout', '-b', 'unmerged']);
  const sha = commit(remote, 'unmerged.txt', 'Unmerged change');
  const oid = annotate(remote, sha, FAST);
  git(checkout, ['fetch', 'origin', 'unmerged']);
  git(checkout, ['checkout', '--detach', sha]);
  assert.throws(
    () => inspectTag(checkout, push(sha, oid)),
    /not reachable from origin\/main/,
  );
});

void test('rejects annotated tags with a different name or an indirect target', (t) => {
  const { remote, checkout, sha } = repository(t);
  const wrongName = annotate(remote, sha, FAST, { name: 'v21.0.0-fork.12' });
  assert.throws(() => inspectTag(checkout, push(sha, wrongName)), /name the ref/);
  const inner = annotate(remote, sha, FAST);
  const outer = annotate(remote, inner, FAST, { type: 'tag' });
  assert.throws(() => inspectTag(checkout, push(sha, outer)), /point directly/);
});

void test('refuses replaced tag and existing release', (t) => {
  const { remote, checkout, sha } = repository(t);
  const original = annotate(remote, sha, FAST);
  const route = inspectTag(checkout, push(sha, original));
  assert.equal(route.oid, original);
  verifyTag(checkout, TAG, route.oid);
  annotate(remote, sha, 'replacement\n');
  assert.throws(
    () => inspectTag(checkout, push(sha, original)),
    /differs from the push payload/,
  );
  const verify = () => {
    verifyTag(checkout, TAG, route.oid);
  };
  assert.throws(verify, /differs from the checked object/);
  git(remote, ['update-ref', '-d', REF]);
  assert.throws(verify, /ls-remote/);
  assert.throws(() => inspectTag(checkout, push(sha, original)), /fetch/);
  const release = probePublisher(checkout, 'echo "$TAG"');
  assert.equal(release.status, 1, release.stderr);
  assert.match(release.stdout, /a Release .* already exists/);
});

void test('rejects a different annotated object before the first fetch', (t) => {
  const { remote, checkout, sha } = repository(t);
  const original = annotate(remote, sha, 'original\n');
  const replacement = annotate(remote, sha, FAST);
  assert.notEqual(replacement, original);
  for (const after of [original, sha])
    assert.throws(
      () => inspectTag(checkout, push(sha, after)),
      /differs from the push payload/,
    );
});

void test('requires all creation fields even when the new tag object matches', (t) => {
  const { remote, checkout, sha } = repository(t);
  const original = annotate(remote, sha, 'original\n');
  const replacement = annotate(remote, sha, FAST);
  const run = push(sha, replacement);
  for (const fields of [
    { before: original, created: 'false', forced: 'true' },
    { before: original },
    { created: undefined },
    { created: 'false' },
    { deleted: 'true' },
    { forced: 'true' },
  ])
    assert.throws(
      () => inspectTag(checkout, { ...run, ...fields }),
      /must create a new tag/,
    );
});

void test('selects the preceding published release by numeric version, not Git tag or API order', (t) => {
  const { remote, checkout, sha, base } = repository(t);
  const previous = 'v21.0.0-fork.10';
  git(remote, ['update-ref', `refs/tags/${previous}`, base]);
  git(remote, ['update-ref', 'refs/tags/v21.0.0-fork.9', 'HEAD']);
  const published = ['v21.0.0-fork.9', TAG, 'v21.0.0-fork.12', previous, 'other-release'];
  const status = superSyncStatus(checkout, TAG, sha, () => published);
  assert.deepEqual(status, {
    required: false,
    reason: `${previous} (${base}) vs ${sha}: pin and sync client unchanged`,
  });
});

for (const path of [
  'fork/upstream-base',
  'src/app/op-log/client.ts',
  'packages/sync-providers/client.ts',
]) {
  void test(`SuperSync is required after changing ${path}`, (t) => {
    const { remote, checkout, sha } = repository(t);
    const previous = 'v20.0.0-fork.80';
    const changed = commit(checkout, path, 'Changed');
    git(remote, ['update-ref', `refs/tags/${previous}`, sha]);
    const status = superSyncStatus(checkout, TAG, changed, () => [previous]);
    assert.equal(status.required, true);
  });
}

void test('includes SuperSync when the preceding release or comparison is uncertain', (t) => {
  const { remote, checkout, sha, base } = repository(t);
  const previous = 'v21.0.0-fork.10';
  assert.match(superSyncStatus(checkout, TAG, sha, () => []).reason, /no unambiguous/);
  const missing = superSyncStatus(checkout, TAG, sha, () => [previous]);
  assert.match(missing.reason, /could not fetch/);
  git(remote, ['update-ref', `refs/tags/${previous}`, sha]);
  const ambiguous = superSyncStatus(checkout, TAG, sha, () => [previous, previous]);
  assert.equal(ambiguous.required, true);
  assert.equal(superSyncStatus(checkout, TAG, base, () => [previous]).required, true);
  assert.equal(
    superSyncStatus(checkout, TAG, sha, () => {
      throw new Error('API down');
    }).required,
    true,
  );
});

void test('release notes contain exactly the closed list of skipped checks', () => {
  const prefix =
    'Быстрый выпуск. Не прогонялись: unit upstream, e2e Chromium upstream, e2e подтверждения сохранения, ';
  assert.equal(fastNotes(false), prefix + 'инструментальные тесты Android');
  assert.equal(
    fastNotes(true),
    prefix + 'e2e SuperSync upstream, инструментальные тесты Android',
  );
});

void test('detects any discovered fork Angular suite in the shipped JS', (t) => {
  const { checkout } = repository(t);
  put(checkout, 'src/app/first.fork.spec.ts', "describe('First fork suite', () => {});");
  const secondSpec = 'src/app/second.fork.spec.ts';
  put(checkout, secondSpec, "describe('Second fork suite', () => {});");
  git(checkout, ['add', 'src']);
  const out = join(checkout, 'build');
  put(out, 'chunk.js', 'const fixture = "Application";');
  checkWebSpecs(checkout, out);
  put(out, 'nested/from-spec.js', 'describe("Second fork suite",()=>{});');
  const check = () => {
    checkWebSpecs(checkout, out);
  };
  assert.throws(check, /Second fork suite/);
});

const workflow = readFileSync(
  new URL('../.github/workflows/fork-gate.yml', import.meta.url),
  'utf8',
);

/** @param {string} name */
function job(name) {
  const section = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`,
    'm',
  ).exec(workflow)?.[1];
  assert.ok(section, `missing workflow job ${name}`);
  return section;
}

/** @param {string} name */
function needs(name) {
  const list = /^    needs: \[([^\n]+)\]$/m.exec(job(name))?.[1];
  assert.ok(list, `missing needs list for ${name}`);
  return list.split(/,\s*/);
}

const fastJobs = ['base', 'fork-files', 'lint', 'unit', 'android'];

/** @param {string} name */
function checkRequiredResults(name) {
  const gate = job(name);
  const run = gate.split('        run: |\n')[1];
  assert.ok(run);
  const dependencies = needs(name);
  const success = dependencies.map(() => 'success');
  for (const status of ['skipped', 'failure', 'cancelled', '', 'success']) {
    for (const [index, dependency] of dependencies.entries()) {
      const results = [...success];
      results.splice(index, 1, ...[status].filter(Boolean));
      const probe = spawnSync('bash', ['-e', '-c', run], {
        env: { ...process.env, RESULTS: results.join(' ') },
      });
      assert.ifError(probe.error);
      const label = `${name} ${dependency} ${status || 'absent'}`;
      assert.equal(probe.status, Number(status !== 'success'), label);
    }
  }
  assert.match(gate, /RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}/);
}

void test('ordinary tag requires every applicable full job', () => {
  const dependencies = needs('full-gate');
  assert.match(job('save-confirmation'), /ref: \$\{\{ github\.sha \}\}/);
  const jobs = dependencies.map(job);
  for (const command of [
    /run: npm run e2e:supersync:file\b[^\n]*\bsupersync-save-confirmation\.fork\.spec\.ts\b/,
    /run: npm run e2e(?:\s|:file\b|$)/m,
    /android\/run-android-checks\.sh/,
    /android\/run-android-ime-check\.sh/,
  ]) {
    const runsCommand = jobs.some((body) => command.test(body));
    assert.ok(runsCommand, String(command));
  }
  for (const name of ['gate', 'tag-route', 'save-confirmation'])
    assert.ok(dependencies.includes(name), name);
  const upstreamUnit =
    /run: npm run test:ci\n\s+if: needs\.tag-route\.outputs\.mode != 'fast'/;
  assert.match(job('unit'), upstreamUnit);
  assert.ok(needs('version').includes('full-gate'));
  assert.match(
    job('version'),
    /mode == 'full'\s*&&\s*needs\.full-gate\.result == 'success'/,
  );
});

void test('required skipped failed or cancelled checks block release', () => {
  checkRequiredResults('full-gate');
  assert.match(job('full-gate'), /^    if: (?:>-\n\s+)?(?:always\(\)|!cancelled\(\))/m);
});

void test('fast tag keeps the approved minimum', () => {
  assert.deepEqual(needs('gate'), fastJobs);
  checkRequiredResults('gate');
  const version = job('version');
  assert.match(version, /!cancelled\(\) && needs\.gate\.result == 'success'/);
  assert.match(
    version,
    /github\.event_name == 'push' && github\.ref_type == 'tag' &&\s+needs\.tag-route\.result == 'success' &&\s*\(?needs\.tag-route\.outputs\.mode == 'fast'/,
  );
  assert.deepEqual(needs('publish'), ['version', 'build-mac', 'build-apk', 'assets']);
});

void test('manual checks can never sign or publish', () => {
  assert.match(
    job('version'),
    /github\.event_name == 'workflow_dispatch' && github\.ref_type == 'branch' &&\s+inputs\.build && needs\.tag-route\.result == 'skipped'/,
  );

  const releaseOnly =
    /github\.event_name == 'push' && github\.ref_type == 'tag' &&\s+needs\.version\.outputs\.release == 'true'/;
  const apk = job('build-apk').split('      - name: ');
  assert.match(apk[0], releaseOnly);
  for (const name of ['Decode release keystore', 'Build fdroid release APK']) {
    const step = apk.find((section) => section.startsWith(name));
    assert.ok(step);
    assert.match(step, releaseOnly);
  }
  const publish = job('publish');
  assert.match(publish, releaseOnly);
  const verify = 'verify-tag "$TAG" "$TAG_OID"';
  assert.equal(publish.split(verify).length - 1, 2);
  assert.match(publish, /verify-tag .*\n\s+draft="\$\(gh api --method POST/);
  assert.match(publish, /verify-tag .*\n\s+gh api --method PATCH "\$releases\/\$id"/);
  for (const name of ['build-mac', 'build-apk', 'assets', 'publish'])
    assert.match(job(name), /ref: \$\{\{ needs\.version\.outputs\.sha \}\}/);
});

/** @param {string} checkout @param {string} response */
function probePublisher(checkout, response) {
  const run = job('publish').split('        run: |\n').at(-1);
  assert.ok(run);
  const gh = 'gh() { [ "$2" = --paginate ] || exit 24; ' + response + '; }';
  return spawnSync('bash', ['-c', gh + '\n' + run], {
    cwd: checkout,
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'example/fork', TAG },
    encoding: 'utf8',
  });
}

void test('a failed Release list stops the publisher before any write', (t) => {
  const result = probePublisher(repository(t).checkout, 'return 23');
  assert.equal(result.status, 23, result.stderr);
});
