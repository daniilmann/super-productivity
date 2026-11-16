#!/usr/bin/env node
// Release-time substitution for the fork (see FORK.md, "Releases" and "App identity").
//
//   node fork/apply-identity.mjs --tag vM.m.p-fork.N [--root DIR]
//       Validates the tag against fork/upstream-base and every other fork tag,
//       then rewrites the version and the Android identity in the build working copy.
//       The result is never committed.
//   node fork/apply-identity.mjs --check [--root DIR]
//       Only checks that the current tree has exactly the literals the substitution expects.
//
// Any failure exits non-zero.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ID = 'io.github.daniilmann.sptelos';
export const UPSTREAM_APP_ID = 'com.superproductivity.superproductivity';
export const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-fork\.([1-9]\d*)$/;
const INT32_MAX = 2147483647;

export const FILES = {
  base: 'fork/upstream-base',
  packageJson: 'package.json',
  pluginApiPackageJson: 'packages/plugin-api/package.json',
  gradle: 'android/app/build.gradle',
  shortcuts: 'android/app/src/main/res/xml/shortcuts.xml',
};

const APP_ID_RE = /^(\s*applicationId\s+)"[^"]*"/gm;
const VERSION_CODE_RE = /^(\s*versionCode\s+)[\d_]+\s*$/gm;
const VERSION_NAME_RE = /^(\s*versionName\s+)"[^"]*"/gm;
const TARGET_PACKAGE = `android:targetPackage="${UPSTREAM_APP_ID}"`;

export class IdentityError extends Error {}

function fail(msg) {
  throw new IdentityError(msg);
}

/** Parses a fork release tag; throws on any other format. */
export function parseTag(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) fail(`tag ${JSON.stringify(tag)} is not vM.m.p-fork.N without leading zeros`);
  const [M, mi, p, N] = m.slice(1).map(Number);
  return { M, m: mi, p, N, upstreamTag: `v${M}.${mi}.${p}`, version: tag.slice(1) };
}

/** versionCode = M*10^7 + m*10^5 + p*10^3 + N within the documented limits. */
export function versionCode({ M, m, p, N }) {
  if (m > 99) fail(`minor ${m} > 99`);
  if (p > 99) fail(`patch ${p} > 99`);
  if (N < 1 || N > 999) fail(`fork number ${N} outside 1..999`);
  const code = M * 1e7 + m * 1e5 + p * 1e3 + N;
  if (!Number.isSafeInteger(code) || code > INT32_MAX) fail(`versionCode ${code} > ${INT32_MAX}`);
  return code;
}

/** Reads fork/upstream-base: exactly `tag=...` and `commit=<40 hex>`. */
export function parseBase(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  const kv = {};
  for (const line of lines) {
    const m = /^(tag|commit)=(.+)$/.exec(line);
    if (!m || m[1] in kv) fail(`${FILES.base}: unexpected line ${JSON.stringify(line)}`);
    kv[m[1]] = m[2];
  }
  if (!/^v\d+\.\d+\.\d+$/.test(kv.tag ?? '')) fail(`${FILES.base}: bad or missing tag=`);
  if (!/^[0-9a-f]{40}$/.test(kv.commit ?? '')) fail(`${FILES.base}: bad or missing commit=`);
  return kv;
}

/** The new code must be greater than the code of every other fork tag of this format. */
export function checkMonotonic(tag, code, otherTags) {
  for (const other of otherTags) {
    if (other === tag || !TAG_RE.test(other)) continue;
    const otherCode = versionCode(parseTag(other));
    if (code <= otherCode) fail(`versionCode ${code} of ${tag} is not greater than ${otherCode} of ${other}`);
  }
}

function replaceExactlyOnce(text, re, replacement, what) {
  const hits = text.match(re) ?? [];
  if (hits.length !== 1) fail(`${what}: expected exactly 1 match, found ${hits.length}`);
  return text.replace(re, replacement);
}

/** applicationId, versionCode and versionName in build.gradle — exactly once each. */
export function substituteGradle(text, { appId, code, name }) {
  let out = replaceExactlyOnce(text, APP_ID_RE, `$1"${appId}"`, 'build.gradle applicationId');
  out = replaceExactlyOnce(out, VERSION_CODE_RE, `$1${code}`, 'build.gradle versionCode');
  out = replaceExactlyOnce(out, VERSION_NAME_RE, `$1"${name}"`, 'build.gradle versionName');
  return out;
}

/** targetPackage of the three upstream shortcuts. */
export function substituteShortcuts(text, appId) {
  const count = text.split(TARGET_PACKAGE).length - 1;
  if (count !== 3) fail(`shortcuts.xml: expected 3 upstream targetPackage attributes, found ${count}`);
  return text.split(TARGET_PACKAGE).join(`android:targetPackage="${appId}"`);
}

/** Literal checks on the current tree, without changing it. */
export function checkTree(root) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  parseBase(read(FILES.base));
  const gradle = read(FILES.gradle);
  substituteGradle(gradle, { appId: APP_ID, code: 1, name: '0.0.0-fork.1' });
  if (!(gradle.match(APP_ID_RE) ?? [])[0]?.includes(`"${UPSTREAM_APP_ID}"`)) {
    fail('build.gradle applicationId is not the upstream literal (substitution must not be committed)');
  }
  substituteShortcuts(read(FILES.shortcuts), APP_ID);
}

function setJsonVersion(path, version) {
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof obj.version !== 'string') fail(`${path}: no version`);
  obj.version = version;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function gitTags(root) {
  const out = execFileSync('git', ['-C', root, 'tag', '--list', 'v*-fork.*'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

export function apply(root, tag, otherTags = gitTags(root)) {
  const t = parseTag(tag);
  const code = versionCode(t);
  const base = parseBase(readFileSync(join(root, FILES.base), 'utf8'));
  if (t.upstreamTag !== base.tag) fail(`tag ${tag} is for ${t.upstreamTag}, base is ${base.tag}`);
  checkMonotonic(tag, code, otherTags);

  const gradlePath = join(root, FILES.gradle);
  const shortcutsPath = join(root, FILES.shortcuts);
  // Compute everything first, then write: a failure leaves the tree untouched.
  const gradle = substituteGradle(readFileSync(gradlePath, 'utf8'), { appId: APP_ID, code, name: t.version });
  const shortcuts = substituteShortcuts(readFileSync(shortcutsPath, 'utf8'), APP_ID);
  writeFileSync(gradlePath, gradle);
  writeFileSync(shortcutsPath, shortcuts);
  setJsonVersion(join(root, FILES.packageJson), t.version);
  setJsonVersion(join(root, FILES.pluginApiPackageJson), t.version);
  return { version: t.version, versionCode: code, applicationId: APP_ID };
}

function main(argv) {
  const args = { root: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else fail(`unknown argument ${a}`);
  }
  if (args.check === Boolean(args.tag)) fail('use exactly one of --check or --tag');
  if (args.check) {
    checkTree(args.root);
    console.log('fork identity: tree literals ok');
  } else {
    const r = apply(args.root, args.tag);
    console.log(`fork identity: version ${r.version}, versionCode ${r.versionCode}, applicationId ${r.applicationId}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`fork identity: ${e.message}`);
    process.exit(1);
  }
}
