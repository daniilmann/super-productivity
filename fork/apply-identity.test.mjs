// node --test fork/*.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APP_ID,
  FILES,
  IdentityError,
  apply,
  checkMonotonic,
  checkTree,
  parseBase,
  parseTag,
  substituteGradle,
  substituteShortcuts,
  versionCode,
} from './apply-identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

void test('tag format: accepted and rejected', () => {
  assert.deepEqual(parseTag('v20.0.0-fork.1'), {
    M: 20,
    m: 0,
    p: 0,
    N: 1,
    upstreamTag: 'v20.0.0',
    version: '20.0.0-fork.1',
  });
  for (const bad of [
    'v020.00.0-fork.1',
    'v20.0.0-fork.0',
    'v20.0.0-fork.01',
    'v20.0.0',
    '20.0.0-fork.1',
    'v20.0-fork.1',
    'v20.0.0-fork.1x',
  ]) {
    assert.throws(() => parseTag(bad), IdentityError, bad);
  }
});

void test('versionCode formula, examples and limits', () => {
  assert.equal(versionCode(parseTag('v20.0.0-fork.1')), 200000001);
  assert.equal(versionCode(parseTag('v20.3.12-fork.45')), 200312045);
  assert.equal(versionCode(parseTag('v213.99.99-fork.999')), 2139999999);
  assert.throws(() => versionCode(parseTag('v20.100.0-fork.1')), IdentityError);
  assert.throws(() => versionCode(parseTag('v20.0.100-fork.1')), IdentityError);
  assert.throws(() => versionCode(parseTag('v20.0.0-fork.1000')), IdentityError);
  assert.throws(() => versionCode(parseTag('v215.0.0-fork.1')), IdentityError);
});

void test('versionCode order matches (M, m, p, N) order', () => {
  const tags = [
    'v20.0.0-fork.1',
    'v20.0.0-fork.2',
    'v20.0.1-fork.1',
    'v20.1.0-fork.1',
    'v20.99.99-fork.999',
    'v21.0.0-fork.1',
  ];
  const codes = tags.map((t) => versionCode(parseTag(t)));
  assert.deepEqual(
    [...codes].sort((a, b) => a - b),
    codes,
  );
});

void test('monotonic: new code must exceed every other fork tag', () => {
  const t = 'v20.0.0-fork.2';
  checkMonotonic(t, versionCode(parseTag(t)), ['v20.0.0-fork.1', t, 'v0.0.0', 'random']);
  assert.throws(() => {
    checkMonotonic(t, versionCode(parseTag(t)), ['v20.0.0-fork.3']);
  }, IdentityError);
});

void test('base file: two lines, valid values', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseBase(`tag=v20.0.0\ncommit=${sha}\n`), {
    tag: 'v20.0.0',
    commit: sha,
  });
  assert.throws(() => parseBase(`tag=v20.0.0\n`), IdentityError);
  assert.throws(() => parseBase(`tag=v20.0.0\ncommit=${sha}\nextra=1\n`), IdentityError);
  assert.throws(() => parseBase(`tag=v20.0.0\ncommit=abc\n`), IdentityError);
});

void test('gradle: exactly one literal each, else failure', () => {
  const g =
    'defaultConfig {\n  applicationId "x.y"\n  versionCode 20_00_00_9000\n  versionName "20.0.0"\n}\n';
  const out = substituteGradle(g, {
    appId: APP_ID,
    code: 200000001,
    name: '20.0.0-fork.1',
  });
  assert.match(out, new RegExp(`applicationId "${APP_ID.replace(/\./g, '\\.')}"`));
  assert.match(out, /versionCode 200000001\n/);
  assert.match(out, /versionName "20\.0\.0-fork\.1"/);
  assert.throws(
    () => substituteGradle(g + g, { appId: APP_ID, code: 1, name: 'x' }),
    IdentityError,
  );
  assert.throws(
    () =>
      substituteGradle(g.replace(/versionName.*\n/, ''), {
        appId: APP_ID,
        code: 1,
        name: 'x',
      }),
    IdentityError,
  );
});

void test('shortcuts: exactly three upstream targetPackage', () => {
  const one =
    '<intent android:targetPackage="com.superproductivity.superproductivity" />\n';
  assert.equal(
    (substituteShortcuts(one.repeat(3), APP_ID).match(new RegExp(APP_ID, 'g')) ?? [])
      .length,
    3,
  );
  assert.throws(() => substituteShortcuts(one.repeat(2), APP_ID), IdentityError);
  assert.throws(() => substituteShortcuts(one.repeat(4), APP_ID), IdentityError);
});

void test('current tree has exactly the literals the substitution expects', () => {
  checkTree(ROOT);
});

void test('apply on a copy of the tree: values written, upstream tag mismatch rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-identity-'));
  for (const f of Object.values(FILES)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  const base = parseBase(readFileSync(join(dir, FILES.base), 'utf8'));
  assert.ok(base.tag, 'the pinned base must contain an upstream tag');
  assert.ok(base.commit, 'the pinned base must contain a commit');
  const tag = `${base.tag}-fork.1`;
  const r = apply(dir, tag, []);
  assert.equal(r.version, tag.slice(1));
  for (const file of [FILES.packageJson, FILES.pluginApiPackageJson]) {
    /** @type {unknown} */
    const pkg = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    assert.ok(
      typeof pkg === 'object' && pkg !== null && 'version' in pkg,
      `${file} must contain a package version`,
    );
    assert.equal(pkg.version, tag.slice(1));
  }
  const gradle = readFileSync(join(dir, FILES.gradle), 'utf8');
  assert.match(gradle, new RegExp(`versionCode ${String(r.versionCode)}\\b`));
  assert.ok(
    !readFileSync(join(dir, FILES.shortcuts), 'utf8').includes(
      'com.superproductivity.superproductivity"',
    ),
  );

  writeFileSync(join(dir, FILES.base), `tag=v1.0.0\ncommit=${base.commit}\n`);
  assert.throws(() => apply(dir, tag, []), IdentityError);
});
