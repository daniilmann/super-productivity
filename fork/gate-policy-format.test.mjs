import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForkPolicy } from './gate-policy.mjs';

const BUDGET = 'Upstream change budget';
const REGISTRY = 'Reworked upstream files';

/** @param {string} heading @param {string} json */
function section(heading, json) {
  return `## ${heading}\n\nPolicy paragraph.\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** @param {string} [budget] */
function policy(budget = '{"maxAddedLinesPerFile":10}') {
  return section(BUDGET, budget) + '\n' + section(REGISTRY, '[]');
}

void test('strict policy accepts one json fence immediately after each policy paragraph', () => {
  assert.deepEqual(parseForkPolicy(policy()), {
    maxAddedLinesPerFile: 10,
    reworkedFiles: [],
  });
});

for (const json of [
  '{"maxAddedLinesPerFile":10,"maxAddedLinesPerFile":999}',
  '{"maxAddedLinesPerFile":999,"maxAddedLinesPerFile":10}',
  '{"maxAddedLinesPerFile":10,"maxAddedLinesPerFil\\u0065":999}',
  '{"maxAddedLinesPerFile":10,"note":1,"note":2}',
]) {
  void test(`duplicate JSON object keys fail before last-value-wins parsing: ${json}`, () => {
    assert.throws(() => parseForkPolicy(policy(json)), { code: 'ERR_FORK_POLICY' });
  });
}

for (const heading of [BUDGET, REGISTRY]) {
  for (const placement of [
    'whole block',
    'whole section',
    'paragraph',
    'after block',
    'JSON string',
  ]) {
    void test(`HTML comment opener anywhere in ${heading} fails: ${placement}`, () => {
      const json = heading === BUDGET ? '{"maxAddedLinesPerFile":10}' : '[]';
      const original = section(heading, json);
      let replacement;
      switch (placement) {
        case 'whole block':
          replacement = original.replace('```json', '<!--\n```json') + '-->\n';
          break;
        case 'whole section':
          replacement = `<!--\n${original}-->\n`;
          break;
        case 'paragraph':
          replacement = original.replace(
            'Policy paragraph.',
            'Policy <!-- hidden --> paragraph.',
          );
          break;
        case 'after block':
          replacement = original + '<!-- trailing comment -->\n';
          break;
        case 'JSON string':
          replacement = original.replace(
            json,
            heading === BUDGET
              ? '{"maxAddedLinesPerFile":10,"note":"<!--"}'
              : '["src/<!--.ts"]',
          );
          break;
        default:
          assert.fail(`Unknown placement: ${placement}`);
      }
      assert.throws(() => parseForkPolicy(policy().replace(original, replacement)), {
        code: 'ERR_FORK_POLICY',
      });
    });
  }

  for (const prefix of [' ', '    ', '\t', '> ', '- ', 'text ']) {
    void test(`policy heading must start at column zero: ${JSON.stringify(prefix)}${heading}`, () => {
      const text = policy().replace(`## ${heading}`, `${prefix}## ${heading}`);
      assert.throws(() => parseForkPolicy(text), {
        code: 'ERR_FORK_POLICY',
        message: /section|секци/i,
      });
    });
  }

  void test(`a heading inside another fenced block is not a policy section: ${heading}`, () => {
    const json = heading === BUDGET ? '{"maxAddedLinesPerFile":10}' : '[]';
    const original = section(heading, json);
    assert.throws(
      () =>
        parseForkPolicy(policy().replace(original, `\`\`\`text\n${original}\`\`\`\n`)),
      { code: 'ERR_FORK_POLICY', message: /section|секци/i },
    );
  });

  for (const replacement of [
    '```json\nVALUE\n```\n\nPolicy paragraph.\n',
    'Policy paragraph.\n\n- Intervening list\n\n```json\nVALUE\n```\n',
    'Policy paragraph.\n\n```text\nintervening block\n```\n\n```json\nVALUE\n```\n',
    'Policy paragraph.\n\n```json extra\nVALUE\n```\n',
    'Policy paragraph.\n\n```JSON\nVALUE\n```\n',
    'Policy paragraph.\n\n```json\nVALUE\n```\n\n```json\nVALUE\n```\n',
  ]) {
    void test(`policy fence has a strict position and format in ${heading}: ${JSON.stringify(replacement)}`, () => {
      const json = heading === BUDGET ? '{"maxAddedLinesPerFile":10}' : '[]';
      const text = policy().replace(
        section(heading, json),
        `## ${heading}\n\n${replacement.replaceAll('VALUE', json)}`,
      );
      assert.throws(() => parseForkPolicy(text), { code: 'ERR_FORK_POLICY' });
    });
  }
}

void test('comments outside policy sections do not invalidate valid policy sections', () => {
  assert.deepEqual(
    parseForkPolicy(`<!-- unrelated -->\n${policy()}\n## Notes\n<!-- notes -->\n`),
    {
      maxAddedLinesPerFile: 10,
      reworkedFiles: [],
    },
  );
});
