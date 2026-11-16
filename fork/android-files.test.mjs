// Fork changes in android/ (see FORK.md, "Changes to upstream files").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('LAUNCH_MODE is 2 (connectivity-free mode)', () => {
  const text = readFileSync(join(ROOT, 'android/app/app_config.properties'), 'utf8');
  const values = text.split('\n').filter((l) => /^\s*LAUNCH_MODE\s*=/.test(l)).map((l) => l.split('=')[1].trim());
  assert.deepEqual(values, ['2']);
});
