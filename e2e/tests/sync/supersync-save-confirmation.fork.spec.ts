import { createHash } from 'node:crypto';
import type { Locator, Request } from '@playwright/test';
import type { PluginAPI } from '../../../packages/plugin-api/src/types';
import type {
  OpUploadResponse,
  SyncOperation,
} from '../../../packages/sync-providers/src/provider-types';
import { test, expect } from '../../fixtures/supersync.fixture';
import {
  enablePluginWithVerification,
  waitForPluginAssets,
  waitForPluginManagementInit,
} from '../../helpers/plugin-test.helpers';
import {
  closeClient,
  createSimulatedClient,
  createTestUser,
  deleteTestUser,
  getLocalOpLogSummary,
  getSuperSyncConfig,
  parseSuperSyncRequestBody,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';

const TEST_PLUGIN_ID = 'api-test-plugin';
const OTHER_PLUGIN_ID = 'doc-mode';
const KEY = 'save-confirmation:current';
const FOREIGN_KEY = 'save-confirmation:foreign';

type Saved = { state: 'saved'; savedAt: number; valueSha256: string };
type SaveState = Saved | { state: 'failed' | 'pending' | 'unknown' };

type IframeApi = Pick<PluginAPI, 'persistDataSynced' | 'loadSyncedData'> & {
  getSyncedDataSaveState(keys: string[]): Promise<{
    sync: 'ok' | 'error' | 'offline';
    keys: Record<string, SaveState>;
  }>;
};

const openPlugin = async (
  client: SimulatedE2EClient,
  pluginId: string,
): Promise<Locator> => {
  await client.page.goto(`/#/plugins/${pluginId}/index`);
  const selector = `plugin-index iframe[data-plugin-id="${pluginId}"]`;
  await expect(client.page.locator(selector)).toBeVisible();
  const body = client.page.frameLocator(selector).locator('body');
  await expect
    .poll(() =>
      body.evaluate(
        () =>
          typeof (window as Window & { PluginAPI?: IframeApi }).PluginAPI?.loadSyncedData,
      ),
    )
    .toBe('function');
  return body;
};

const persist = (body: Locator, key: string, value: string): Promise<void> =>
  body.evaluate(
    (_body, data) =>
      (window as unknown as { PluginAPI: IframeApi }).PluginAPI.persistDataSynced(
        data.value,
        data.key,
      ),
    { key, value },
  );

const load = (body: Locator, key: string): Promise<string | null> =>
  body.evaluate(
    (_body, dataKey) =>
      (window as unknown as { PluginAPI: IframeApi }).PluginAPI.loadSyncedData(dataKey),
    key,
  );

const readSaveStates = (
  body: Locator,
  keys: string[],
): Promise<Record<string, SaveState>> =>
  body.evaluate(async (_body, requestedKeys) => {
    const api = (window as unknown as { PluginAPI: IframeApi }).PluginAPI;
    return (await api.getSyncedDataSaveState(requestedKeys)).keys;
  }, keys);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const syncAndVerifyReceipt = async (
  client: SimulatedE2EClient,
  body: Locator,
  pluginId: string,
  key: string,
  value: string,
  serverUrl: string,
): Promise<{ opId: string; savedAt: number }> => {
  const opsUrl = new URL('/api/sync/ops', serverUrl);
  const entityId = `${pluginId}:${key}`;
  const matchingOps = (request: Request): SyncOperation[] =>
    parseSuperSyncRequestBody<{ ops: SyncOperation[] }>(request).ops.filter(
      (op) => op.entityType === 'PLUGIN_USER_DATA' && op.entityId === entityId,
    );

  const [response] = await Promise.all([
    client.page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        res.request().method() === 'POST' &&
        url.origin === opsUrl.origin &&
        url.pathname === opsUrl.pathname &&
        matchingOps(res.request()).length > 0
      );
    }),
    client.sync.syncAndWait(),
  ]);
  expect(response.ok()).toBe(true);
  const matching = matchingOps(response.request());
  expect(matching).toHaveLength(1);
  const opId = matching[0].id;
  const upload: OpUploadResponse = await response.json();
  expect(upload.results).toContainEqual(
    expect.objectContaining({ opId, accepted: true, serverSeq: expect.any(Number) }),
  );

  const fingerprint = sha256(value);
  await expect
    .poll(async () => (await readSaveStates(body, [key]))[key])
    .toEqual({ state: 'saved', savedAt: expect.any(Number), valueSha256: fingerprint });
  const receipt = (await readSaveStates(body, [key]))[key];
  if (receipt.state !== 'saved') {
    throw new Error(`Expected a saved receipt for ${key}, got ${receipt.state}`);
  }
  expect(receipt.valueSha256).toBe(fingerprint);

  // The receipt estimates UTC at markSynced. Allow transport and clock-correction
  // latency relative to the actual server response's second-resolution Date.
  const serverTime = Date.parse((await response.headerValue('date')) ?? '');
  expect(Number.isFinite(serverTime)).toBe(true);
  expect(Number.isInteger(receipt.savedAt)).toBe(true);
  expect(Math.abs(receipt.savedAt - serverTime)).toBeLessThan(30_000);
  return { opId, savedAt: receipt.savedAt };
};

test.describe('@supersync Save Confirmation', () => {
  test('confirms the version accepted by SuperSync and rejects stale confirmation', async ({
    browser,
    baseURL,
    testRunId,
  }) => {
    test.setTimeout(240_000);
    const user = await createTestUser(testRunId);
    const config = getSuperSyncConfig(user);
    const appUrl = baseURL || 'http://localhost:4242';
    const valueA = `\uFEFF{ "ver": "A-${testRunId}", "text": "e\u0301" }\n`;
    // Cross the persistence codec's compression threshold to check the original bytes.
    const valueB = `{ "ver": "B-${testRunId}", "text": "${'é'.repeat(1200)}" }\n`;
    const foreignValue = `{ "ver": "foreign-${testRunId}" }\n`;
    let clientA: SimulatedE2EClient | undefined;
    let clientB: SimulatedE2EClient | undefined;

    try {
      clientA = await createSimulatedClient(browser, appUrl, 'A', testRunId);
      await clientA.sync.setupSuperSync(config);
      expect(await waitForPluginAssets(clientA.page)).toBe(true);
      expect(await waitForPluginManagementInit(clientA.page)).toBe(true);
      expect(
        await enablePluginWithVerification(clientA.page, 'API Test Plugin', 15000),
      ).toBe(true);
      let frameA = await openPlugin(clientA, TEST_PLUGIN_ID);

      expect(await load(frameA, KEY)).toBeNull();
      expect(await readSaveStates(frameA, [KEY])).toEqual({
        [KEY]: { state: 'unknown' },
      });
      await persist(frameA, KEY, valueA);
      const receiptA = await syncAndVerifyReceipt(
        clientA,
        frameA,
        TEST_PLUGIN_ID,
        KEY,
        valueA,
        config.baseUrl,
      );

      clientB = await createSimulatedClient(browser, appUrl, 'B', testRunId);
      await clientB.sync.setupSuperSync(config);
      await clientB.sync.syncAndWait();
      expect(await waitForPluginManagementInit(clientB.page)).toBe(true);
      expect(
        await enablePluginWithVerification(clientB.page, 'API Test Plugin', 15000),
      ).toBe(true);
      const frameB = await openPlugin(clientB, TEST_PLUGIN_ID);
      expect(await load(frameB, KEY)).toBe(valueA);

      const pageA = clientA.page;
      await clientA.context.setOffline(true);
      try {
        expect(await pageA.evaluate(() => navigator.onLine)).toBe(false);
        await persist(frameA, KEY, valueB);
        // loadSyncedData can see B before it is applied. Wait for the unsynced
        // plugin operation, which is captured only after dispatching B.
        await expect
          .poll(
            async () =>
              (await getLocalOpLogSummary(pageA)).filter(
                (op) => op.entityType === 'PLUGIN_USER_DATA' && !op.isSynced,
              ).length,
          )
          .toBe(1);
        expect(await load(frameA, KEY)).toBe(valueB);
        expect(await readSaveStates(frameA, [KEY])).toEqual({
          [KEY]: { state: 'unknown' },
        });
      } finally {
        await clientA.context.setOffline(false);
      }

      const receiptB = await syncAndVerifyReceipt(
        clientA,
        frameA,
        TEST_PLUGIN_ID,
        KEY,
        valueB,
        config.baseUrl,
      );
      expect(receiptB.opId).not.toBe(receiptA.opId);
      expect(receiptB.savedAt).toBeGreaterThan(receiptA.savedAt);
      await clientB.sync.syncAndWait();
      expect(await load(frameB, KEY)).toBe(valueB);

      expect(await waitForPluginManagementInit(clientA.page)).toBe(true);
      expect(await enablePluginWithVerification(clientA.page, 'Doc Mode', 15000)).toBe(
        true,
      );
      const otherFrame = await openPlugin(clientA, OTHER_PLUGIN_ID);
      await persist(otherFrame, FOREIGN_KEY, foreignValue);
      await syncAndVerifyReceipt(
        clientA,
        otherFrame,
        OTHER_PLUGIN_ID,
        FOREIGN_KEY,
        foreignValue,
        config.baseUrl,
      );

      frameA = await openPlugin(clientA, TEST_PLUGIN_ID);
      expect(await readSaveStates(frameA, [KEY, FOREIGN_KEY])).toEqual({
        [KEY]: {
          state: 'saved',
          savedAt: expect.any(Number),
          valueSha256: sha256(valueB),
        },
        [FOREIGN_KEY]: { state: 'unknown' },
      });
      expect(await load(frameA, FOREIGN_KEY)).toBeNull();
    } finally {
      try {
        await Promise.all([
          clientA && closeClient(clientA),
          clientB && closeClient(clientB),
        ]);
      } finally {
        await deleteTestUser(user.userId);
      }
    }
  });
});
