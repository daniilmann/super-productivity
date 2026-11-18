import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { openDB } from 'idb';
import { BehaviorSubject } from 'rxjs';
import { SnackService } from '../../core/snack/snack.service';
import { ClientIdService } from '../../core/util/client-id.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { OperationCaptureService } from '../../op-log/capture/operation-capture.service';
import { LOCK_NAMES } from '../../op-log/core/operation-log.const';
import { ActionType, OpType } from '../../op-log/core/operation.types';
import { LockAcquisitionTimeoutError } from '../../op-log/core/errors/sync-errors';
import {
  DB_NAME,
  DB_VERSION,
  SINGLETON_KEY,
  STORE_NAMES,
} from '../../op-log/persistence/db-keys.const';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { TabSeqFrontierService } from '../../op-log/persistence/tab-seq-frontier.service';
import { LockService } from '../../op-log/sync/lock.service';
import { OperationEncryptionService } from '../../op-log/sync/operation-encryption.service';
import { OperationLogDownloadService } from '../../op-log/sync/operation-log-download.service';
import { SuperSyncStatusService } from '../../op-log/sync/super-sync-status.service';
import { CLIENT_ID_PROVIDER } from '../../op-log/util/client-id.provider';
import {
  SyncProviderManager,
  SyncStatusChangePayload,
} from '../../op-log/sync-providers/provider-manager.service';
import { OperationSyncCapable } from '../../op-log/sync-providers/provider.interface';
import { IS_ONLINE$ } from '../../util/is-online.token';
import { uuidv7 } from '../../util/uuid-v7';
import { MAX_PLUGIN_DATA_SIZE, PluginUserDataState } from '../plugin-persistence.model';
import { PluginUserPersistenceService } from '../plugin-user-persistence.service';
import { upsertPluginUserData } from '../store/plugin.actions';
import { selectPluginUserDataFeatureState } from '../store/plugin-user-data.reducer';
import { composeId } from '../util/plugin-persistence-key.util';
import { SaveStateService } from './save-state.service';

const PLUGIN = 'save-test';
const KEY = 'goal';
const ENTITY = composeId(PLUGIN, KEY);
const CLIENT = 'B_receiptClient';
const NEXT_CLIENT = 'B_importClient';
const A = '\uFEFF {"ver":"a", "value":"é"}\n' + ' '.repeat(1024);
const B = '{"ver":"b", "value":"next"}\n';
const SHA_A = 'ee8a5a30e249b65d6c7cb94de64c5c422289d7145d3deeb4554c43e577792138';
const SHA_B = '5f2fa43e940f038878841477904db0590d82b5f2c7536812ad1a01cfaa8db109';
const UNKNOWN = { state: 'unknown' };
const MAX_DECOMPRESSED_SIZE = MAX_PLUGIN_DATA_SIZE * 2;
const MAX_RAW_LENGTH = MAX_DECOMPRESSED_SIZE * 2;

const gzip = async (bytes: BlobPart): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const encoded = (bytes: Uint8Array): string =>
  'GZ1:' + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));

describe('SaveStateService', () => {
  let store: MockStore;
  let apply: (state: PluginUserDataState) => void;
  let journal: OperationLogStoreService;
  let client: ClientIdService;
  let lock: LockService;
  let sync: BehaviorSubject<SyncStatusChangePayload>;
  let online: BehaviorSubject<boolean>;

  const boot = async (): Promise<void> => {
    sync = new BehaviorSubject<SyncStatusChangePayload>('IN_SYNC');
    online = new BehaviorSubject(true);
    TestBed.configureTestingModule({
      providers: [
        SaveStateService,
        provideMockStore(),
        { provide: SyncWrapperService, useValue: { syncState$: sync } },
        { provide: IS_ONLINE$, useValue: online },
        { provide: SnackService, useValue: { open: jasmine.createSpy('open') } },
        { provide: OperationEncryptionService, useValue: {} },
        {
          provide: SuperSyncStatusService,
          useValue: { markRemoteChecked: () => undefined },
        },
        {
          provide: SyncProviderManager,
          useValue: { configEpoch: 0, getActiveProvider: () => null },
        },
      ],
    });
    store = TestBed.inject(MockStore);
    const selector = store.overrideSelector(
      selectPluginUserDataFeatureState,
      [] as PluginUserDataState,
    );
    apply = (state) => {
      selector.setResult(state);
      store.refreshState();
    };
    journal = TestBed.inject(OperationLogStoreService);
    await journal.init();
    client = TestBed.inject(ClientIdService);
    lock = TestBed.inject(LockService);
  };

  beforeEach(async () => {
    await boot();
    await client.persistClientId(CLIENT);
  });

  afterEach(() => store?.resetSelectors());

  const read = (): ReturnType<SaveStateService['getSyncedDataSaveState']> =>
    TestBed.inject<SaveStateService>(SaveStateService).getSyncedDataSaveState(PLUGIN, [
      KEY,
    ]);
  const setApplied = (data: string): void => apply([{ id: ENTITY, data }]);
  const acknowledge = async (data: string, author = CLIENT): Promise<void> => {
    const seq = await journal.append(
      {
        id: uuidv7(),
        actionType: ActionType.PLUGIN_UPSERT_USER_DATA,
        opType: OpType.Update,
        entityType: 'PLUGIN_USER_DATA',
        entityId: ENTITY,
        payload: {
          actionPayload: { pluginUserData: { id: ENTITY, data } },
          entityChanges: [],
        },
        clientId: author,
        vectorClock: { [author]: 1 },
        timestamp: Date.now(),
        schemaVersion: 1,
      },
      'local',
    );
    await journal.markSynced([seq]);
  };

  const downloadTime = async (serverTime: number): Promise<void> => {
    const provider = jasmine.createSpyObj<OperationSyncCapable>(
      'SuperSync transport',
      ['downloadOps', 'getLastServerSeq'],
      { supportsOperationSync: true, providerMode: 'superSyncOps' },
    );
    provider.getLastServerSeq.and.resolveTo(0);
    provider.downloadOps.and.resolveTo({
      ops: [],
      hasMore: false,
      latestSeq: 0,
      serverTime,
    });
    const result = await TestBed.inject(OperationLogDownloadService).downloadRemoteOps(
      provider,
    );
    expect(result.success).toBeTrue();
    expect(provider.downloadOps).toHaveBeenCalled();
  };

  it('reads server time on an empty download', async () => {
    setApplied(B);
    const now = spyOn(Date, 'now').and.returnValue(Date.UTC(2026, 0, 5, 10));
    await downloadTime(Date.UTC(2026, 0, 5, 10, 0, 8));
    now.and.returnValue(Date.UTC(2026, 0, 5, 10, 0, 2));
    await acknowledge(B);
    const result = (await read()).keys[KEY];
    if (result.state !== 'saved') {
      throw new Error(`Expected saved, received ${result.state}`);
    }
    expect(new Date(result.savedAt).toISOString()).toBe('2026-01-05T10:00:10.000Z');
  });

  it('keeps the original savedAt across restart and clock changes', async () => {
    setApplied(B);
    const now = spyOn(Date, 'now').and.returnValue(Date.UTC(2026, 0, 5, 10));
    await downloadTime(Date.UTC(2026, 0, 5, 10, 0, 8));
    await acknowledge(B);
    const saved = (await read()).keys[KEY];
    if (saved.state !== 'saved') {
      throw new Error(`Expected saved, received ${saved.state}`);
    }
    expect(new Date(saved.savedAt).toISOString()).toBe('2026-01-05T10:00:08.000Z');

    now.and.returnValue(Date.UTC(2026, 0, 5, 11));
    store.resetSelectors();
    TestBed.resetTestingModule();
    await boot();
    setApplied(B);
    await downloadTime(Date.UTC(2026, 0, 5, 11, 0, 1));
    expect((await read()).keys[KEY]).toEqual(saved);
  });

  it('reports coalescing and compression as pending', async () => {
    setApplied(B);
    await acknowledge(B);
    const persistence = TestBed.inject(PluginUserPersistenceService);
    const now = spyOn(Date, 'now').and.returnValue(2_000);
    await persistence.persistPluginUserData(ENTITY, B);
    await persistence.persistPluginUserData(ENTITY, A);
    expect(await persistence.loadPluginUserData(ENTITY)).toBe(A);
    const coalesced = await read();
    await persistence.clearAllPluginUserData();

    setApplied(B);
    now.and.returnValue(4_000);
    const originalWrite = WritableStreamDefaultWriter.prototype.write;
    let start!: () => void;
    const writing = new Promise<void>((resolve) => {
      start = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    spyOn(WritableStreamDefaultWriter.prototype, 'write').and.callFake(function (
      this: WritableStreamDefaultWriter,
      chunk: unknown,
    ) {
      start();
      return held.then(() => originalWrite.call(this, chunk));
    });
    const write = persistence.persistPluginUserData(ENTITY, 'x'.repeat(2048));
    await writing;
    try {
      expect(coalesced.keys[KEY]).toEqual({ state: 'pending' });
      expect((await read()).keys[KEY]).toEqual({ state: 'pending' });
    } finally {
      release();
      await write;
    }
  });

  it('reports journal failure ahead of a pending write and a matching receipt', async () => {
    setApplied(B);
    await acknowledge(B);
    const persistence = TestBed.inject(PluginUserPersistenceService);
    spyOn(Date, 'now').and.returnValue(2_000);
    await persistence.persistPluginUserData(ENTITY, B);
    await persistence.persistPluginUserData(ENTITY, A);
    TestBed.inject(OperationCaptureService).markUnrecoveredPersistFailure();
    try {
      expect((await read()).keys[KEY]).toEqual({ state: 'failed' });
    } finally {
      await persistence.clearAllPluginUserData();
    }
  });

  it('requires matching client and encoded value', async () => {
    setApplied(B);
    await acknowledge(B, NEXT_CLIENT);
    expect((await read()).keys[KEY]).toEqual(UNKNOWN);

    const compressed = encoded(await gzip(B));
    await acknowledge(compressed);
    expect((await read()).keys[KEY]).toEqual(UNKNOWN);

    setApplied(compressed);
    expect((await read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
    );
  });

  it('returns sync status using the host sync and connectivity inputs', async () => {
    expect(await read()).toEqual({ sync: 'ok', keys: { [KEY]: UNKNOWN } });
    sync.next('ERROR');
    expect((await read()).sync).toBe('error');
    online.next(false);
    expect((await read()).sync).toBe('offline');
  });

  it('hashes the same exact UTF-8 bytes from both GZ1 forms and the compression fallback', async () => {
    const bytes = await gzip(A);
    const first = encoded(bytes);
    bytes[4] = bytes[4] === 0 ? 1 : 0; // gzip MTIME, outside the checked payload.
    const second = encoded(bytes);
    expect(first).not.toBe(second);

    const dispatch = spyOn(store, 'dispatch').and.callThrough();
    spyOn(window, 'CompressionStream').and.throwError('compression unavailable');
    await TestBed.inject(PluginUserPersistenceService).persistPluginUserData(ENTITY, A);
    expect(dispatch).toHaveBeenCalledWith(
      upsertPluginUserData({ pluginUserData: { id: ENTITY, data: A } }),
    );

    for (const stored of [first, second, A]) {
      setApplied(stored);
      await acknowledge(stored);
      expect((await read()).keys[KEY]).toEqual(
        jasmine.objectContaining({ state: 'saved', valueSha256: SHA_A }),
      );
    }

    const decomposed = A.normalize('NFD');
    setApplied(decomposed);
    await acknowledge(decomposed);
    expect((await read()).keys[KEY]).toEqual(
      jasmine.objectContaining({
        state: 'saved',
        valueSha256: '0fe58255518083710770105268ff79b4ec7c2ba45e2735b6f7ef10570bfb1001',
      }),
    );
  });

  for (const [label, stored] of [
    ['corrupted GZ1', () => Promise.resolve('GZ1:bm90LWd6aXA=')],
    ['invalid UTF-8', async () => encoded(await gzip(new Uint8Array([0xc3, 0x28])))],
    ['raw limit', () => Promise.resolve('GZ1:' + 'A'.repeat(MAX_RAW_LENGTH + 4))],
    [
      'compressed limit',
      () => Promise.resolve('GZ1:' + 'A'.repeat(3 * MAX_PLUGIN_DATA_SIZE)),
    ],
    [
      'decompressed limit',
      async () => encoded(await gzip('x'.repeat(MAX_DECOMPRESSED_SIZE + 1))),
    ],
  ] as const) {
    it(`returns unknown for ${label} even with a matching receipt`, async () => {
      const data = await stored();
      setApplied(data);
      await acknowledge(data);
      expect((await read()).keys[KEY]).toEqual(UNKNOWN);
    });
  }

  for (const failingDigest of [1, 2]) {
    it(`returns unknown if SHA-256 calculation ${failingDigest} rejects`, async () => {
      const stored = encoded(await gzip(A));
      setApplied(stored);
      await acknowledge(stored);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
        calls++;
        return calls === failingDigest
          ? Promise.reject(new Error('digest unavailable'))
          : digest(algorithm, data);
      });
      expect((await read()).keys[KEY]).toEqual(UNKNOWN);
      expect(calls).toBe(failingDigest);
    });
  }

  it('confirms applied A when the store changes to B after the snapshot, then requires a receipt for B', async () => {
    const storedA = encoded(await gzip(A));
    const applied = TestBed.inject(PluginUserPersistenceService);
    setApplied(B);
    expect(await applied.loadPluginUserData(ENTITY)).toBe(B);
    await acknowledge(storedA);

    const trace: string[] = [];
    const request = lock.request.bind(lock);
    let held = false;
    spyOn(lock, 'request').and.callFake(
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

    const transaction = IDBDatabase.prototype.transaction;
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
          setApplied(B);
        });
      }
    };
    apply([
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
    const NativeDecompressionStream = DecompressionStream;
    const decompress = spyOn(window, 'DecompressionStream').and.callFake((format) => {
      expect(held).toBeFalse();
      trace.push('gunzip');
      return new NativeDecompressionStream(format);
    });
    const cachedLoad = spyOn(client, 'loadClientId').and.callThrough();

    const responseA = await read();
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
    decompress.and.callThrough();
    expect(await applied.loadPluginUserData(ENTITY)).toBe(B);
    expect((await read()).keys[KEY]).toEqual(UNKNOWN);
    await acknowledge(B);
    expect((await read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
    );
  });

  it('does not confirm during client rotation or remote replacement', async () => {
    setApplied(A);
    await acknowledge(A);
    expect((await read()).keys[KEY]).toEqual(
      jasmine.objectContaining({ state: 'saved' }),
    );

    setApplied(B); // Remote application without a local acknowledgement.
    expect((await read()).keys[KEY]).toEqual(UNKNOWN);
    setApplied(A);

    const otherTab = new ClientIdService();
    expect(await otherTab.loadClientId()).toBe(CLIENT);
    const tab = Injector.create({
      parent: TestBed.inject(Injector),
      providers: [
        OperationLogStoreService,
        TabSeqFrontierService,
        { provide: CLIENT_ID_PROVIDER, useValue: otherTab },
      ],
    });
    try {
      await lock.request(LOCK_NAMES.OPERATION_LOG, () =>
        tab.get(OperationLogStoreService).runDestructiveStateReplacement({
          syncImportOp: {
            id: uuidv7(),
            actionType: ActionType.LOAD_ALL_DATA,
            opType: OpType.BackupImport,
            entityType: 'ALL',
            payload: { pluginUserData: [{ id: ENTITY, data: A }] },
            clientId: NEXT_CLIENT,
            vectorClock: { [NEXT_CLIENT]: 1 },
            timestamp: Date.now(),
            schemaVersion: 1,
          },
          snapshotEntityKeys: [ENTITY],
        }),
      );
    } finally {
      tab.destroy();
    }
    expect(await client.loadClientId()).toBe(CLIENT);
    expect((await read()).keys[KEY]).toEqual(UNKNOWN); // Before loadAllData.
    setApplied(A); // The imported state has the same bytes and ver.
    expect((await read()).keys[KEY]).toEqual(UNKNOWN);
    expect(await client.loadClientId()).toBe(CLIENT);
  });

  it('times out when the log lock cannot be acquired', async () => {
    setApplied(B);
    await acknowledge(B);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const acquired = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocker = lock.request(LOCK_NAMES.OPERATION_LOG, () => {
      enter();
      return held;
    });
    await acquired;
    const request = lock.request.bind(lock);
    spyOn(lock, 'request').and.callFake(<T>(name: string, callback: () => Promise<T>) =>
      request(name, callback, 15),
    );
    try {
      await expectAsync(read()).toBeRejectedWithError(LockAcquisitionTimeoutError);
    } finally {
      release();
      await blocker;
    }
  });

  for (const acquisition of [1, 2]) {
    for (const fault of ['missing', 'read failure'] as const) {
      it(`returns unknown on ${fault} of the committed ID in lock ${acquisition}`, async () => {
        setApplied(A);
        await acknowledge(A);
        const db = await openDB(DB_NAME, DB_VERSION);
        const request = lock.request.bind(lock);
        let entries = 0;
        let failRead = false;
        const get = IDBObjectStore.prototype.get;
        spyOn(IDBObjectStore.prototype, 'get').and.callFake(function (
          this: IDBObjectStore,
          key,
        ) {
          if (this.name === STORE_NAMES.CLIENT_ID && failRead) {
            throw new DOMException('synthetic failing ID read', 'UnknownError');
          }
          return get.call(this, key);
        });
        spyOn(lock, 'request').and.callFake(<T>(name: string, run: () => Promise<T>) =>
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
          expect((await read()).keys[KEY]).toEqual(UNKNOWN);
          expect(entries).toBe(acquisition);
          expect(await client.loadClientId()).toBe(CLIENT);
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
