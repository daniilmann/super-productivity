// Checks a built APK: no app data goes to Google cloud backup (see FORK.md).
// Input: text dumps made by aapt2 from the APK:
//   manifest   — aapt2 dump xmltree --file AndroidManifest.xml
//   resources  — aapt2 dump resources
//   backup     — aapt2 dump xmltree --file <file of the fullBackupContent resource>
//   extraction — aapt2 dump xmltree --file <file of the dataExtractionRules resource>
// CLI: node fork/check-apk-backup.mjs <manifest> <resources> <backup> <extraction>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BACKUP_DOMAINS = [
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

// Parses aapt2 xmltree output into elements with their ancestor names and plain attributes.
export function parseXmlTree(text) {
  const elements = [];
  const stack = [];
  for (const line of text.split('\n')) {
    const el = line.match(/^(\s*)E: ([\w:-]+)/);
    if (el) {
      const depth = el[1].length;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      const node = { name: el[2], depth, ancestors: stack.map((s) => s.name), attrs: {} };
      stack.push(node);
      elements.push(node);
      continue;
    }
    const attr = line.match(/^(\s*)A: ([\w:./-]+?)(?:\(0x[0-9a-f]+\))?="([^"]*)"/);
    if (attr && stack.length) stack[stack.length - 1].attrs[attr[2].replace(/^.*:/, '')] = attr[3];
  }
  return elements;
}

// Resource file referenced by a manifest attribute, e.g. fullBackupContent -> "backup_rules".
export function referencedXml(manifest, resources, attribute) {
  const ref = manifest.match(new RegExp(`:${attribute}\\(0x[0-9a-f]+\\)=@(0x[0-9a-f]+)`));
  if (!ref) return null;
  const res = resources.match(new RegExp(`resource ${ref[1]} xml/([\\w.]+)`));
  return res ? res[1] : null;
}

const wholeExclusions = (elements, section) =>
  new Set(
    elements
      .filter((e) => e.name === 'exclude' && e.attrs.path === '.' && (!section || e.ancestors.includes(section)))
      .map((e) => e.attrs.domain),
  );

export function checkBackup({ manifest, resources, backup, extraction }) {
  const errors = [];
  const backupName = referencedXml(manifest, resources, 'fullBackupContent');
  const extractionName = referencedXml(manifest, resources, 'dataExtractionRules');
  if (backupName !== 'backup_rules') errors.push(`fullBackupContent points at ${backupName}`);
  if (extractionName !== 'data_extraction_rules') errors.push(`dataExtractionRules points at ${extractionName}`);

  const b = parseXmlTree(backup);
  if (!b.some((e) => e.name === 'full-backup-content')) errors.push('backup rules: no full-backup-content');
  if (b.some((e) => e.name === 'include')) errors.push('backup rules: include present');
  const bMissing = BACKUP_DOMAINS.filter((d) => !wholeExclusions(b).has(d));
  if (bMissing.length) errors.push(`backup rules: domains not excluded: ${bMissing.join(', ')}`);

  const x = parseXmlTree(extraction);
  if (!x.some((e) => e.name === 'cloud-backup')) errors.push('extraction rules: no cloud-backup section');
  if (x.some((e) => e.name === 'include' && e.ancestors.includes('cloud-backup')))
    errors.push('extraction rules: include in cloud-backup');
  const xMissing = BACKUP_DOMAINS.filter((d) => !wholeExclusions(x, 'cloud-backup').has(d));
  if (xMissing.length) errors.push(`extraction rules: cloud-backup domains not excluded: ${xMissing.join(', ')}`);
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [manifest, resources, backup, extraction] = process.argv.slice(2).map((p) => readFileSync(p, 'utf8'));
  const errors = checkBackup({ manifest, resources, backup, extraction });
  for (const e of errors) console.error(`::error::${e}`);
  if (errors.length) process.exit(1);
  console.log('APK backup rules ok: every domain excluded in both rule files');
}
