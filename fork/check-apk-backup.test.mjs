import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKUP_DOMAINS,
  checkBackup,
  parseXmlTree,
  referencedXml,
} from './check-apk-backup.mjs';

const NS = 'http://schemas.android.com/apk/res/android';
const manifest = [
  `N: android=${NS} (line=2)`,
  '  E: manifest (line=2)',
  '    E: application (line=10)',
  `      A: ${NS}:allowBackup(0x01010280)=true`,
  `      A: ${NS}:dataExtractionRules(0x0101063e)=@0x7f150001`,
  `      A: ${NS}:fullBackupContent(0x01010473)=@0x7f150000`,
].join('\n');
const resources = [
  'Package name=io.github.daniilmann.sptelos id=7f',
  '  type xml id=15 entryCount=2',
  '    resource 0x7f150000 xml/backup_rules',
  '      () (file) res/xml/backup_rules.xml type=XML',
  '    resource 0x7f150001 xml/data_extraction_rules',
  '      () (file) res/xml/data_extraction_rules.xml type=XML',
].join('\n');

/** @param {string} indent @param {string[]} domains */
const excludes = (indent, domains) =>
  domains.flatMap((d) => [
    `${indent}E: exclude (line=3)`,
    `${indent}  A: domain="${d}" (Raw: "${d}")`,
    `${indent}  A: path="." (Raw: ".")`,
  ]);
/** @param {string[]} domains */
const backupDump = (domains) =>
  ['E: full-backup-content (line=2)', ...excludes('  ', domains)].join('\n');
/** @param {string[]} cloud @param {string[]} [transfer] */
const extractionDump = (cloud, transfer = []) =>
  [
    'E: data-extraction-rules (line=2)',
    '  E: cloud-backup (line=3)',
    ...excludes('    ', cloud),
    '  E: device-transfer (line=20)',
    ...excludes('    ', transfer),
  ].join('\n');

const good = {
  manifest,
  resources,
  backup: backupDump(BACKUP_DOMAINS),
  extraction: extractionDump(BACKUP_DOMAINS),
};

void test('parseXmlTree keeps ancestors and attributes', () => {
  const els = parseXmlTree(extractionDump(['root'], ['file']));
  const ex = els.filter((e) => e.name === 'exclude');
  assert.deepEqual(ex[0].ancestors, ['data-extraction-rules', 'cloud-backup']);
  assert.deepEqual(ex[0].attrs, { domain: 'root', path: '.' });
  assert.deepEqual(ex[1].ancestors, ['data-extraction-rules', 'device-transfer']);
});

void test('referencedXml resolves a manifest reference to the resource name', () => {
  assert.equal(referencedXml(manifest, resources, 'fullBackupContent'), 'backup_rules');
  assert.equal(
    referencedXml(manifest, resources, 'dataExtractionRules'),
    'data_extraction_rules',
  );
});

void test('a fully excluded APK passes', () => {
  assert.deepEqual(checkBackup(good), []);
});

void test('a missing manifest reference fails', () => {
  const m = manifest
    .split('\n')
    .filter((l) => !l.includes('fullBackupContent'))
    .join('\n');
  assert.match(
    checkBackup({ ...good, manifest: m }).join(';'),
    /fullBackupContent points at null/,
  );
});

void test('upstream rules (single prefs files only) fail', () => {
  const upstream = [
    'E: full-backup-content (line=2)',
    '  E: exclude (line=3)',
    '    A: domain="sharedpref" (Raw: "sharedpref")',
    '    A: path="SuperProductivitySync.xml" (Raw: "SuperProductivitySync.xml")',
  ].join('\n');
  assert.match(
    checkBackup({ ...good, backup: upstream }).join(';'),
    /backup rules: domains not excluded: root/,
  );
});

void test('exclusions only in device-transfer do not count for cloud backup', () => {
  const errors = checkBackup({ ...good, extraction: extractionDump([], BACKUP_DOMAINS) });
  assert.match(errors.join(';'), /cloud-backup domains not excluded/);
});

void test('an include in cloud-backup fails', () => {
  const x = good.extraction.replace(
    '  E: cloud-backup (line=3)',
    '  E: cloud-backup (line=3)\n    E: include (line=4)',
  );
  assert.match(
    checkBackup({ ...good, extraction: x }).join(';'),
    /include in cloud-backup/,
  );
});

void test('one missing domain fails', () => {
  const errors = checkBackup({
    ...good,
    backup: backupDump(BACKUP_DOMAINS.filter((d) => d !== 'database')),
  });
  assert.match(errors.join(';'), /domains not excluded: database/);
});
