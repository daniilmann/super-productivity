import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUpstreamBudget } from './check-upstream-budget.mjs';
import { parseNameStatus } from './gate-policy.mjs';

const POLICY = { maxAddedLinesPerFile: 10, reworkedFiles: [] };
const PATH = 'src/current.ts';
const OLD = 'src/original.ts';

void test('name-status preserves a typechange record and copy endpoints', () => {
  assert.deepEqual(parseNameStatus(`T\0${PATH}\0C100\0${OLD}\0copy.ts\0`), [
    { status: 'T', path: PATH },
    { status: 'C', oldPath: OLD, path: 'copy.ts' },
  ]);
});

for (const oldPath of [undefined, 'src/wrong-original.ts']) {
  void test(`rename with mismatched numstat oldPath fails: ${String(oldPath)}`, () => {
    assert.deepEqual(
      checkUpstreamBudget(
        [{ status: 'R', oldPath: OLD, path: PATH }],
        [{ path: PATH, oldPath, added: 0, deleted: 0 }],
        POLICY,
      ),
      [`MISSING_NUMSTAT: ${PATH}`],
    );
  });
}

void test('a matching rename oldPath passes with zero additions', () => {
  assert.deepEqual(
    checkUpstreamBudget(
      [{ status: 'R', oldPath: OLD, path: PATH }],
      [{ oldPath: OLD, path: PATH, added: 0, deleted: 0 }],
      POLICY,
    ),
    [],
  );
});

for (const added of [0, 1, 11]) {
  void test(`typechange cannot pass as a small textual diff: ${String(added)} additions`, () => {
    const errors = checkUpstreamBudget(
      [{ status: 'T', path: PATH }],
      [{ path: PATH, added, deleted: 80 }],
      POLICY,
    );
    assert.ok(errors.length > 0, 'A typechange must fail even below the line limit');
    assert.ok(
      errors.every((error) => error.includes(PATH)),
      JSON.stringify(errors),
    );
  });
}
