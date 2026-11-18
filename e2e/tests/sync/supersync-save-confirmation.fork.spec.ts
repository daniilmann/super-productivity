import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Locator, Page, Response } from '@playwright/test';
import type { PluginAPI, SaveState } from '../../../packages/plugin-api/src/types';
import { SuperSyncUploadOpsResponseSchema } from '../../../packages/shared-schema/src/supersync-http-contract';
import { MAX_PLUGIN_DATA_SIZE } from '../../../src/app/plugins/plugin-persistence.model';
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
  getSuperSyncConfig,
  type SimulatedE2EClient,
} from '../../utils/supersync-helpers';

const TEST_PLUGIN_ID = 'api-test-plugin';
const OTHER_PLUGIN_ID = 'doc-mode';
const KEY = 'save-confirmation:current';
const FOREIGN_KEY = 'save-confirmation:foreign';

type IframeApi = Pick<
  PluginAPI,
  'persistDataSynced' | 'loadSyncedData' | 'getSyncedDataSaveState'
>;

type StoredPluginWrite = {
  source: string;
  op: {
    id: string;
    a: string;
    o: string;
    e: string;
    d?: string;
    p?: { actionPayload?: { pluginUserData?: { id: string; data: string } } };
  };
};

const openPlugin = async (
  client: SimulatedE2EClient,
  pluginId: string,
): Promise<Locator> => {
  // Start with the old iframe detached. Plugin-to-plugin navigation can reuse it.
  await expect(client.page.locator('plugin-index iframe')).toHaveCount(0);
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

const readSaveStates = (body: Locator, keys: string[]): Promise<SaveState['keys']> =>
  body.evaluate(async (_body, requestedKeys) => {
    const api = (window as unknown as { PluginAPI: IframeApi }).PluginAPI;
    return (await api.getSyncedDataSaveState(requestedKeys)).keys;
  }, keys);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const readLocalPluginWrites = (
  page: Page,
  entityId: string,
): Promise<{ opId: string; encoded: string }[]> =>
  page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('SUP_OPS');
      open.onupgradeneeded = () => {
        open.transaction?.abort();
      };
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('Could not open SUP_OPS'));
      };
    });
    try {
      const rows = await new Promise<StoredPluginWrite[]>((resolve, reject) => {
        const tx = db.transaction('ops', 'readonly');
        const read = tx.objectStore('ops').getAll();
        tx.oncomplete = () => {
          resolve(read.result as StoredPluginWrite[]);
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error('Could not read SUP_OPS/ops'));
        };
      });
      // The compact codec leaves the captured action payload unchanged.
      // UU is the compact action code for [Plugin] Upsert User Data.
      return rows.flatMap(({ source, op }) => {
        const data = op.p?.actionPayload?.pluginUserData;
        if (
          source === 'local' &&
          op.a === 'UU' &&
          op.o === 'UPD' &&
          op.e === 'PLUGIN_USER_DATA' &&
          op.d === id &&
          data?.id === id &&
          typeof data.data === 'string'
        ) {
          return [{ opId: op.id, encoded: data.data }];
        }
        return [];
      });
    } finally {
      db.close();
    }
  }, entityId);

const persistAndWaitForLocalOp = async (
  page: Page,
  body: Locator,
  pluginId: string,
  key: string,
  value: string,
): Promise<string> => {
  const entityId = `${pluginId}:${key}`;
  const previousIds = new Set(
    (await readLocalPluginWrites(page, entityId)).map(({ opId }) => opId),
  );
  const expected = Buffer.from(value, 'utf8');
  let opId: string | undefined;
  await persist(body, key, value);
  await expect(async () => {
    const matches = (await readLocalPluginWrites(page, entityId)).filter((entry) => {
      if (previousIds.has(entry.opId)) return false;
      const bytes = entry.encoded.startsWith('GZ1:')
        ? gunzipSync(Buffer.from(entry.encoded.slice(4), 'base64'), {
            maxOutputLength: 2 * MAX_PLUGIN_DATA_SIZE,
          })
        : Buffer.from(entry.encoded, 'utf8');
      return bytes.equals(expected);
    });
    expect(
      matches,
      `New local operation for ${entityId} with the exact bytes`,
    ).toHaveLength(1);
    opId = matches[0].opId;
  }).toPass({ timeout: 15_000 });
  if (!opId) throw new Error(`Missing local operation ID for ${entityId}`);
  return opId;
};

const acceptedServerSeq = async (
  response: Response,
  opId: string,
): Promise<number | undefined> => {
  const upload = SuperSyncUploadOpsResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!upload.success) return undefined;
  return upload.data.results.find(
    (result) =>
      result.opId === opId && result.accepted && typeof result.serverSeq === 'number',
  )?.serverSeq;
};

const syncWithAcceptedUpload = async (
  client: SimulatedE2EClient,
  serverUrl: string,
  opId: string,
  reconnect = false,
): Promise<{ serverSeq: number; serverTime: number }> => {
  const opsUrl = new URL('/api/sync/ops', serverUrl);

  const [response] = await Promise.all([
    client.page.waitForResponse(async (res) => {
      const url = new URL(res.url());
      return (
        res.ok() &&
        res.request().method() === 'POST' &&
        url.origin === opsUrl.origin &&
        url.pathname === opsUrl.pathname &&
        (await acceptedServerSeq(res, opId)) !== undefined
      );
    }),
    (async () => {
      if (reconnect) await client.context.setOffline(false);
      await client.sync.syncAndWait();
    })(),
  ]);
  const serverSeq = await acceptedServerSeq(response, opId);
  if (serverSeq === undefined) throw new Error(`Missing accepted upload for ${opId}`);
  const serverTime = Date.parse((await response.headerValue('date')) ?? '');
  expect(Number.isFinite(serverTime)).toBe(true);
  return { serverSeq, serverTime };
};

const verifyReceipt = async (
  body: Locator,
  key: string,
  value: string,
  serverTime: number,
): Promise<void> => {
  const fingerprint = sha256(value);
  await expect(async () => {
    const receipt = (await readSaveStates(body, [key]))[key];
    expect(receipt).toEqual({
      state: 'saved',
      savedAt: expect.any(Number),
      valueSha256: fingerprint,
    });
    if (receipt.state !== 'saved') throw new Error(`Missing saved receipt for ${key}`);
    // Allow transport and clock-correction latency relative to the accepted
    // upload response's second-resolution Date.
    expect(Number.isInteger(receipt.savedAt)).toBe(true);
    expect(Math.abs(receipt.savedAt - serverTime)).toBeLessThan(30_000);
  }).toPass({ timeout: 15_000 });
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
      const opIdA = await persistAndWaitForLocalOp(
        clientA.page,
        frameA,
        TEST_PLUGIN_ID,
        KEY,
        valueA,
      );
      const uploadA = await syncWithAcceptedUpload(clientA, config.baseUrl, opIdA);
      await verifyReceipt(frameA, KEY, valueA, uploadA.serverTime);

      clientB = await createSimulatedClient(browser, appUrl, 'B', testRunId);
      await clientB.sync.setupSuperSync(config);
      await clientB.sync.syncAndWait();
      expect(await waitForPluginManagementInit(clientB.page)).toBe(true);
      expect(
        await enablePluginWithVerification(clientB.page, 'API Test Plugin', 15000),
      ).toBe(true);
      const frameB = await openPlugin(clientB, TEST_PLUGIN_ID);
      expect(await load(frameB, KEY)).toBe(valueA);

      await clientA.context.setOffline(true);
      expect(await clientA.page.evaluate(() => navigator.onLine)).toBe(false);
      const opIdB = await persistAndWaitForLocalOp(
        clientA.page,
        frameA,
        TEST_PLUGIN_ID,
        KEY,
        valueB,
      );
      expect(await load(frameA, KEY)).toBe(valueB);
      expect(await readSaveStates(frameA, [KEY])).toEqual({
        [KEY]: { state: 'unknown' },
      });

      const uploadB = await syncWithAcceptedUpload(clientA, config.baseUrl, opIdB, true);
      expect(opIdB).not.toBe(opIdA);
      expect(uploadB.serverSeq).toBeGreaterThan(uploadA.serverSeq);
      await verifyReceipt(frameA, KEY, valueB, uploadB.serverTime);
      await clientB.sync.syncAndWait();
      await expect.poll(() => load(frameB, KEY), { timeout: 15_000 }).toBe(valueB);

      expect(await waitForPluginManagementInit(clientA.page)).toBe(true);
      expect(await enablePluginWithVerification(clientA.page, 'Doc Mode', 15000)).toBe(
        true,
      );
      const otherFrame = await openPlugin(clientA, OTHER_PLUGIN_ID);
      expect(await load(otherFrame, FOREIGN_KEY)).toBeNull();
      const foreignOpId = await persistAndWaitForLocalOp(
        clientA.page,
        otherFrame,
        OTHER_PLUGIN_ID,
        FOREIGN_KEY,
        foreignValue,
      );
      const foreignUpload = await syncWithAcceptedUpload(
        clientA,
        config.baseUrl,
        foreignOpId,
      );
      await verifyReceipt(
        otherFrame,
        FOREIGN_KEY,
        foreignValue,
        foreignUpload.serverTime,
      );

      await clientA.page.goto('/#/config');
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
