// Fork changes in android/ (see FORK.md, "Changes to upstream files").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

void test('LAUNCH_MODE is 2 (connectivity-free mode)', () => {
  const text = readFileSync(join(ROOT, 'android/app/app_config.properties'), 'utf8');
  const values = text
    .split('\n')
    .filter((l) => /^\s*LAUNCH_MODE\s*=/.test(l))
    .map((l) => l.split('=')[1].trim());
  assert.deepEqual(values, ['2']);
});

// Every storage domain is excluded as a whole ("."), so no app data reaches Google cloud backup.
// Android 7–11 read backup_rules.xml (fullBackupContent); Android 12+ read the cloud-backup
// section of data_extraction_rules.xml.
const BACKUP_DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];

/** @param {string} xml */
const excludedWhole = (xml) =>
  new Set(
    [...xml.matchAll(/<exclude\s+domain="([a-z_]+)"\s+path="\."\s*\/>/g)].map(
      (m) => m[1],
    ),
  );

/** @param {string} name */
const xmlFile = (name) =>
  readFileSync(join(ROOT, 'android/app/src/main/res/xml', name), 'utf8');

void test('backup_rules.xml excludes every domain as a whole', () => {
  const xml = xmlFile('backup_rules.xml');
  assert.doesNotMatch(xml, /<include\b/);
  assert.deepEqual([...excludedWhole(xml)].sort(), [...BACKUP_DOMAINS].sort());
});

void test('data_extraction_rules.xml cloud-backup excludes every domain as a whole', () => {
  const xml = xmlFile('data_extraction_rules.xml');
  const cloud = xml.match(/<cloud-backup\b[^>]*>([\s\S]*?)<\/cloud-backup>/);
  assert.ok(cloud, 'cloud-backup section is present');
  assert.doesNotMatch(cloud[1], /<include\b/);
  assert.deepEqual([...excludedWhole(cloud[1])].sort(), [...BACKUP_DOMAINS].sort());
});

void test('the manifest points at both rule files', () => {
  const manifest = readFileSync(
    join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
});
