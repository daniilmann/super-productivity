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
const FAST = 'Release-Mode: fast\n';
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

/** @param {string} root @param {string[]} args @param {string} [input] */
function git(root, args, input) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', env: gitEnv, input, stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
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

/** @param {string} sha @param {string} after */
const push = (sha, after) => ({ event: 'push', ref: REF, sha, after });

void test('the documented Git command creates the exact fast annotation', (t) => {
  const { remote, checkout, sha } = repository(t);
  git(
    remote,
    [
      '-c',
      'tag.gpgsign=true',
      'tag',
      '--annotate',
      '--no-sign',
      '--cleanup=verbatim',
      '--file',
      '-',
      TAG,
      sha,
    ],
    FAST,
  );
  const oid = git(remote, ['rev-parse', REF]);
  assert.equal(inspectTag(checkout, push(sha, oid)).mode, 'fast');
});

for (const [label, annotation, mode] of [
  ['exact line', FAST, 'fast'],
  ['empty annotation', '', 'full'],
  ['different case', 'release-mode: fast\n', 'full'],
  ['misspelling', 'Release-Mode: fst\n', 'full'],
  ['extra line', FAST + 'other text\n', 'full'],
  ['extra newline', FAST + '\n', 'full'],
  ['trailing space', 'Release-Mode: fast \n', 'full'],
  ['CRLF', 'Release-Mode: fast\r\n', 'full'],
  ['no final LF', FAST.trimEnd(), 'full'],
]) {
  void test(`annotated tag with ${label} takes the ${mode} route`, (t) => {
    const { remote, checkout, sha } = repository(t);
    const oid = annotate(remote, sha, annotation);
    assert.deepEqual(inspectTag(checkout, push(sha, oid)), { tag: TAG, sha, oid, mode });
  });
}

void test('lightweight push takes the full route', (t) => {
  const { remote, checkout, sha } = repository(t);
  git(remote, ['update-ref', REF, sha]);
  assert.deepEqual(inspectTag(checkout, push(sha, sha)), {
    tag: TAG,
    sha,
    oid: sha,
    mode: 'full',
  });
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
  assert.throws(
    () => inspectTag(checkout, { ...run, sha: sha.slice(0, 8) }),
    /full event SHA/,
  );
  assert.throws(
    () => inspectTag(checkout, { ...run, ref: 'refs/heads/main' }),
    /tag ref/,
  );
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
  assert.throws(
    () => inspectTag(checkout, push(base, oid)),
    /differs from the event commit/,
  );
  git(checkout, ['checkout', '--detach', base]);
  assert.throws(
    () => inspectTag(checkout, push(sha, oid)),
    /differs from the event commit/,
  );
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

void test('rejects an annotated object with a different embedded name', (t) => {
  const { remote, checkout, sha } = repository(t);
  const oid = annotate(remote, sha, FAST, { name: 'v21.0.0-fork.12' });
  assert.throws(() => inspectTag(checkout, push(sha, oid)), /name the ref/);
});

void test('rejects an annotated tag pointing at a tag, even if the commit matches', (t) => {
  const { remote, checkout, sha } = repository(t);
  const inner = annotate(remote, sha, FAST);
  const oid = annotate(remote, inner, FAST, { type: 'tag' });
  assert.throws(() => inspectTag(checkout, push(sha, oid)), /point directly/);
});

void test('pins the raw OID and rejects replacement at the same commit and deletion', (t) => {
  const { remote, checkout, sha } = repository(t);
  const original = annotate(remote, sha, FAST);
  // A push SHA can identify the peeled commit; the saved OID must still be raw.
  const route = inspectTag(checkout, push(sha, sha));
  assert.equal(route.oid, original);
  verifyTag(checkout, TAG, route.oid);
  annotate(remote, sha, 'replacement\n');
  assert.throws(
    () => inspectTag(checkout, push(sha, original)),
    /differs from the push payload/,
  );
  assert.throws(() => {
    verifyTag(checkout, TAG, route.oid);
  }, /differs from the checked object/);
  git(remote, ['update-ref', '-d', REF]);
  assert.throws(() => {
    verifyTag(checkout, TAG, route.oid);
  }, /ls-remote/);
  assert.throws(() => inspectTag(checkout, push(sha, original)), /fetch/);
});

void test('selects the preceding published release by numeric version, not Git tag or API order', (t) => {
  const { remote, checkout, sha, base } = repository(t);
  const previous = 'v21.0.0-fork.10';
  git(remote, ['update-ref', `refs/tags/${previous}`, base]);
  git(remote, ['update-ref', 'refs/tags/v21.0.0-fork.9', 'HEAD']);
  const published = () => [
    'v21.0.0-fork.9',
    TAG,
    'v21.0.0-fork.12',
    previous,
    'other-release',
  ];
  assert.deepEqual(superSyncStatus(checkout, TAG, sha, published), {
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
    assert.equal(
      superSyncStatus(checkout, TAG, changed, () => [previous]).required,
      true,
    );
  });
}

void test('includes SuperSync when the preceding release or comparison is uncertain', (t) => {
  const { remote, checkout, sha, base } = repository(t);
  const previous = 'v21.0.0-fork.10';
  assert.match(superSyncStatus(checkout, TAG, sha, () => []).reason, /no unambiguous/);
  assert.match(
    superSyncStatus(checkout, TAG, sha, () => [previous]).reason,
    /could not fetch/,
  );
  git(remote, ['update-ref', `refs/tags/${previous}`, sha]);
  assert.equal(
    superSyncStatus(checkout, TAG, sha, () => [previous, previous]).required,
    true,
  );
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
  put(
    checkout,
    'src/app/second.fork.spec.ts',
    "describe('Second fork suite', () => {});",
  );
  git(checkout, ['add', 'src']);
  const out = join(checkout, 'build');
  put(out, 'chunk.js', 'const fixture = "Application";');
  checkWebSpecs(checkout, out);
  put(out, 'nested/from-spec.js', 'describe("Second fork suite",()=>{});');
  assert.throws(() => {
    checkWebSpecs(checkout, out);
  }, /Second fork suite/);
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

void test('the Fast gate requires five successes and rejects each non-success result', () => {
  const gate = job('gate');
  assert.match(gate, /needs: \[base, fork-files, lint, unit, android\]/);
  const run = gate.split('        run: |\n')[1];
  assert.ok(run);
  const success = Array.from({ length: 5 }, () => 'success');
  /** @param {string[]} results */
  const result = (results) =>
    spawnSync('bash', ['-e', '-c', run], {
      env: { ...process.env, RESULTS: results.join(' ') },
    }).status;
  assert.equal(result(success), 0);
  for (const value of ['failure', 'cancelled', 'skipped']) {
    for (const i of success.keys())
      assert.equal(
        result(success.map((status, position) => (position === i ? value : status))),
        1,
      );
  }
  assert.equal(result(success.slice(1)), 1);
});

void test('the workflow admits signing and publication only through a checked push tag', () => {
  const version = job('version');
  assert.match(version, /!cancelled\(\) && needs\.gate\.result == 'success'/);
  assert.match(
    version,
    /github\.event_name == 'push' && github\.ref_type == 'tag' &&\s+needs\.tag-route\.result == 'success' && needs\.tag-route\.outputs\.mode == 'fast'/,
  );
  assert.match(
    version,
    /github\.event_name == 'workflow_dispatch' && github\.ref_type == 'branch' &&\s+inputs\.build && needs\.tag-route\.result == 'skipped'/,
  );
  assert.match(job('full-gate'), /mode == 'full'[\s\S]+exit 1/);

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
  assert.match(publish, /verify-tag .*\n\s+gh release create/);
  assert.match(publish, /verify-tag .*\n\s+gh release edit/);
  for (const name of ['build-mac', 'build-apk', 'assets', 'publish'])
    assert.match(job(name), /ref: \$\{\{ needs\.version\.outputs\.sha \}\}/);
});
