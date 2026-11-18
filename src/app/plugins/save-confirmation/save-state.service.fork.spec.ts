import { TestBed } from '@angular/core/testing';
import { openDB } from 'idb';
import { ClientIdService } from '../../core/util/client-id.service';
import { OperationCaptureService } from '../../op-log/capture/operation-capture.service';
import { LOCK_NAMES } from '../../op-log/core/operation-log.const';
import { LockAcquisitionTimeoutError } from '../../op-log/core/errors/sync-errors';
import {
  DB_NAME,
  DB_VERSION,
  SINGLETON_KEY,
  STORE_NAMES,
} from '../../op-log/persistence/db-keys.const';
import { PluginUserPersistenceService } from '../plugin-user-persistence.service';
import { upsertPluginUserData } from '../store/plugin.actions';
import {
  A,
  B,
  CLIENT,
  ENTITY,
  INVALID_STORED_VALUES,
  KEY,
  NEXT_CLIENT,
  SHA_A,
  SHA_B,
  bootSaveState,
  downloadTime,
  encoded,
  gzip,
  readDuringIdenticalWrites,
  replaceStateFromOtherTab,
} from './testing/save-state.fixtures.fork.spec';

const UNKNOWN = { state: 'unknown' } as const;

describe('SaveStateService', () => {
  let fixture: Awaited<ReturnType<typeof bootSaveState>> | undefined;

  beforeEach(async () => {
    fixture = await bootSaveState();
    await fixture.client.persistClientId(CLIENT);
  });

  afterEach(() => {
    fixture?.store.resetSelectors();
    fixture = undefined;
  });

  const current = (): Awaited<ReturnType<typeof bootSaveState>> => {
    if (!fixture) {
      throw new Error('SaveStateService fixture is unavailable');
    }
    return fixture;
  };

  it('reads server time on an empty download', async () => {
    current().setApplied(B);
    const now = spyOn(Date, 'now').and.returnValue(Date.UTC(2026, 0, 5, 10));
    await downloadTime(Date.UTC(2026, 0, 5, 10, 0, 8));
    now.and.returnValue(Date.UTC(2026, 0, 5, 10, 0, 2));
    await current().acknowledge(B);
    const result = (await current().read()).keys[KEY];
    if (result.state !== 'saved') {
      throw new Error(`Expected saved, received ${result.state}`);
    }
    expect(new Date(result.savedAt).toISOString()).toBe('2026-01-05T10:00:10.000Z');
  });

  it('keeps the original savedAt across restart and clock changes', async () => {
    current().setApplied(B);
    const now = spyOn(Date, 'now').and.returnValue(Date.UTC(2026, 0, 5, 10));
    await downloadTime(Date.UTC(2026, 0, 5, 10, 0, 8));
    await current().acknowledge(B);
    const saved = (await current().read()).keys[KEY];
    if (saved.state !== 'saved') {
      throw new Error(`Expected saved, received ${saved.state}`);
    }
    expect(new Date(saved.savedAt).toISOString()).toBe('2026-01-05T10:00:08.000Z');

    now.and.returnValue(Date.UTC(2026, 0, 5, 11));
    current().store.resetSelectors();
    TestBed.resetTestingModule();
    fixture = await bootSaveState();
    current().setApplied(B);
    await downloadTime(Date.UTC(2026, 0, 5, 11, 0, 1));
    expect((await current().read()).keys[KEY]).toEqual(saved);
  });

  it('reports pending during coalescing and until both identical writes finish compressing', async () => {
    current().setApplied(B);
    await current().acknowledge(B);
    const persistence = TestBed.inject(PluginUserPersistenceService);
    const now = spyOn(Date, 'now').and.returnValue(2_000);
    await persistence.persistPluginUserData(ENTITY, B);
    await persistence.persistPluginUserData(ENTITY, A);
    expect(await persistence.loadPluginUserData(ENTITY)).toBe(A);
    const coalesced = await current().read();
    await persistence.clearAllPluginUserData();

    const { duringFirst, duringSecond } = await readDuringIdenticalWrites(current(), now);
    expect(coalesced.keys[KEY]).toEqual({ state: 'pending' });
    expect(duringFirst).toEqual({ state: 'pending' });
    expect(duringSecond).toEqual({ state: 'pending' });
    expect((await current().read()).keys[KEY]).toEqual({
      state: 'saved',
      savedAt: jasmine.any(Number),
      valueSha256: SHA_A,
    });
  });

  it('reports journal failure ahead of a pending write and a matching receipt', async () => {
    current().setApplied(B);
    await current().acknowledge(B);
    const persistence = TestBed.inject(PluginUserPersistenceService);
    spyOn(Date, 'now').and.returnValue(2_000);
    await persistence.persistPluginUserData(ENTITY, B);
    await persistence.persistPluginUserData(ENTITY, A);
    TestBed.inject(OperationCaptureService).markUnrecoveredPersistFailure();
    try {
      expect((await current().read()).keys[KEY]).toEqual({ state: 'failed' });
    } finally {
      await persistence.clearAllPluginUserData();
    }
  });

  it('requires matching client and encoded value', async () => {
    current().setApplied(B);
    await current().acknowledge(B, NEXT_CLIENT);
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);

    const compressed = encoded(await gzip(B));
    await current().acknowledge(compressed);
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);

    current().setApplied(compressed);
    expect((await current().read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
    );
  });

  it('returns sync status using the host sync and connectivity inputs', async () => {
    expect(await current().read()).toEqual({ sync: 'ok', keys: { [KEY]: UNKNOWN } });
    current().sync.next('ERROR');
    expect((await current().read()).sync).toBe('error');
    current().online.next(false);
    expect((await current().read()).sync).toBe('offline');
  });

  it('hashes the same exact UTF-8 bytes from both GZ1 forms and the compression fallback', async () => {
    const bytes = await gzip(A);
    const first = encoded(bytes);
    bytes[4] = bytes[4] === 0 ? 1 : 0; // gzip MTIME, outside the checked payload.
    const second = encoded(bytes);
    expect(first).not.toBe(second);

    const dispatch = spyOn(current().store, 'dispatch').and.callThrough();
    spyOn(window, 'CompressionStream').and.throwError('compression unavailable');
    await TestBed.inject(PluginUserPersistenceService).persistPluginUserData(ENTITY, A);
    expect(dispatch).toHaveBeenCalledWith(
      upsertPluginUserData({ pluginUserData: { id: ENTITY, data: A } }),
    );

    for (const stored of [first, second, A]) {
      current().setApplied(stored);
      await current().acknowledge(stored);
      expect((await current().read()).keys[KEY]).toEqual(
        jasmine.objectContaining({ state: 'saved', valueSha256: SHA_A }),
      );
    }

    const decomposed = A.normalize('NFD');
    current().setApplied(decomposed);
    await current().acknowledge(decomposed);
    expect((await current().read()).keys[KEY]).toEqual(
      jasmine.objectContaining({
        state: 'saved',
        valueSha256: '0fe58255518083710770105268ff79b4ec7c2ba45e2735b6f7ef10570bfb1001',
      }),
    );
  });

  for (const [label, stored] of INVALID_STORED_VALUES) {
    it(`returns unknown for ${label} even with a matching receipt`, async () => {
      const data = await stored();
      current().setApplied(data);
      await current().acknowledge(data);
      expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
    });
  }

  for (const failingDigest of [1, 2]) {
    it(`returns unknown if SHA-256 calculation ${String(failingDigest)} rejects`, async () => {
      const stored = encoded(await gzip(A));
      current().setApplied(stored);
      await current().acknowledge(stored);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
        calls++;
        return calls === failingDigest
          ? Promise.reject(new Error('digest unavailable'))
          : digest(algorithm, data);
      });
      expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
      expect(calls).toBe(failingDigest);
    });
  }

  it('confirms applied A when the store changes to B after the snapshot, then requires a receipt for B', async () => {
    const storedA = encoded(await gzip(A));
    const applied = TestBed.inject(PluginUserPersistenceService);
    current().setApplied(B);
    expect(await applied.loadPluginUserData(ENTITY)).toBe(B);
    await current().acknowledge(storedA);

    const trace: string[] = [];
    const request = current().lock.request.bind(current().lock);
    let held = false;
    spyOn(current().lock, 'request').and.callFake(
      <T>(name: string, run: () => Promise<T>, timeout?: number) =>
        request(
          name,
          async () => {
            expect(name).toBe(LOCK_NAMES.OPERATION_LOG);
            trace.push('lock');
            held = true;
            try {
              return await run();
            } finally {
              held = false;
              trace.push('unlock');
            }
          },
          timeout,
        ),
    );

    const transaction = Reflect.get(IDBDatabase.prototype, 'transaction');
    const transactionSpy = spyOn(IDBDatabase.prototype, 'transaction').and.callFake(
      function (this: IDBDatabase, stores, mode, options) {
        if (this.name !== DB_NAME) {
          expect(held).toBeFalse();
          trace.push('receipt');
        } else {
          expect(held).toBeTrue();
          expect([stores].flat()).toEqual([STORE_NAMES.CLIENT_ID]);
          expect(mode ?? 'readonly').toBe('readonly');
          trace.push('clientId');
        }
        return transaction.call(this, stores, mode, options);
      },
    );

    let snapshotStarted = false;
    let changed = false;
    const snapshotRead = (field: string): void => {
      expect(held).toBeTrue();
      expect(changed).toBeFalse();
      trace.push(field);
      if (!snapshotStarted) {
        snapshotStarted = true;
        queueMicrotask(() => {
          changed = true;
          current().setApplied(B);
        });
      }
    };
    current().apply([
      {
        id: ENTITY,
        get data(): string {
          snapshotRead('value');
          return storedA;
        },
      },
    ]);
    const capture = TestBed.inject(OperationCaptureService);
    const failure = capture.hasUnrecoveredPersistFailure.bind(capture);
    const failureSpy = spyOn(capture, 'hasUnrecoveredPersistFailure').and.callFake(() => {
      snapshotRead('failure flag');
      return failure();
    });

    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      expect(held).toBeFalse();
      trace.push('sha256');
      expect(changed).toBeTrue();
      return digest(algorithm, data);
    });
    const NativeDecompressionStream = window.DecompressionStream;
    const cachedLoad = spyOn(current().client, 'loadClientId').and.callThrough();

    window.DecompressionStream = class extends NativeDecompressionStream {
      constructor(format: CompressionFormat) {
        super(format);
        expect(held).toBeFalse();
        trace.push('gunzip');
      }
    };
    const responseA = await current()
      .read()
      .finally(() => {
        window.DecompressionStream = NativeDecompressionStream;
      });
    expect(responseA.keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_A }),
    );
    expect(cachedLoad).not.toHaveBeenCalled();
    expect(trace.slice(3, 5).sort()).toEqual(['failure flag', 'value']);
    expect([...trace.slice(0, 3), ...trace.slice(5)]).toEqual([
      'receipt',
      'lock',
      'clientId',
      'unlock',
      'sha256',
      'gunzip',
      'sha256',
      'lock',
      'clientId',
      'unlock',
    ]);

    transactionSpy.and.callThrough();
    failureSpy.and.callThrough();
    digestSpy.and.callThrough();
    expect(await applied.loadPluginUserData(ENTITY)).toBe(B);
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
    await current().acknowledge(B);
    expect((await current().read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
    );
  });

  it('does not confirm during client rotation or remote replacement', async () => {
    current().setApplied(A);
    await current().acknowledge(A);
    expect((await current().read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved' }),
    );

    current().setApplied(B); // Remote application without a local acknowledgement.
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
    current().setApplied(A);

    const otherTab = new ClientIdService();
    expect(await otherTab.loadClientId()).toBe(CLIENT);
    await replaceStateFromOtherTab(current().lock, otherTab);
    expect(await current().client.loadClientId()).toBe(CLIENT);
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN); // Before loadAllData.
    current().setApplied(A); // The imported state has the same bytes and ver.
    expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
    expect(await current().client.loadClientId()).toBe(CLIENT);
  });

  it('times out when the log lock cannot be acquired', async () => {
    current().setApplied(B);
    await current().acknowledge(B);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const acquired = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocker = current().lock.request(LOCK_NAMES.OPERATION_LOG, () => {
      enter();
      return held;
    });
    await acquired;
    const request = current().lock.request.bind(current().lock);
    spyOn(current().lock, 'request').and.callFake(
      <T>(name: string, callback: () => Promise<T>) => request(name, callback, 15),
    );
    try {
      await expectAsync(current().read()).toBeRejectedWithError(
        LockAcquisitionTimeoutError,
      );
    } finally {
      release();
      await blocker;
    }
  });

  for (const acquisition of [1, 2]) {
    for (const fault of ['missing', 'read failure'] as const) {
      it(`returns unknown on ${fault} of the committed ID in lock ${String(acquisition)}`, async () => {
        current().setApplied(A);
        await current().acknowledge(A);
        const db = await openDB(DB_NAME, DB_VERSION);
        const request = current().lock.request.bind(current().lock);
        let entries = 0;
        let failRead = false;
        const get = Reflect.get(IDBObjectStore.prototype, 'get');
        spyOn(IDBObjectStore.prototype, 'get').and.callFake(function (
          this: IDBObjectStore,
          key,
        ) {
          if (this.name === STORE_NAMES.CLIENT_ID && failRead) {
            throw new DOMException('synthetic failing ID read', 'UnknownError');
          }
          return get.call(this, key);
        });
        spyOn(current().lock, 'request').and.callFake(
          <T>(name: string, run: () => Promise<T>) =>
            request(name, async () => {
              if (++entries === acquisition) {
                if (fault === 'missing') {
                  await db.delete(STORE_NAMES.CLIENT_ID, SINGLETON_KEY);
                } else {
                  failRead = true;
                }
              }
              return run();
            }),
        );
        try {
          expect((await current().read()).keys[KEY]).toEqual(UNKNOWN);
          expect(entries).toBe(acquisition);
          expect(await current().client.loadClientId()).toBe(CLIENT);
          if (fault === 'missing') {
            expect(await db.get(STORE_NAMES.CLIENT_ID, SINGLETON_KEY)).toBeUndefined();
          }
        } finally {
          db.close();
        }
      });
    }
  }
});
