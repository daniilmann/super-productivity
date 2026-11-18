import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { of } from 'rxjs';
import { ClientIdService } from '../../core/util/client-id.service';
import { SnackService } from '../../core/snack/snack.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { SaveStateService } from '../../plugins/save-confirmation/save-state.service';
import { composeId } from '../../plugins/util/plugin-persistence-key.util';
import { IS_ONLINE$ } from '../../util/is-online.token';
import { uuidv7 } from '../../util/uuid-v7';
import { StateSnapshotService } from '../backup/state-snapshot.service';
import {
  EMERGENCY_COMPACTION_RETENTION_MS,
  LOCK_NAMES,
} from '../core/operation-log.const';
import { ActionType, Operation, OpType } from '../core/operation.types';
import { LockService } from '../sync/lock.service';
import { OperationEncryptionService } from '../sync/operation-encryption.service';
import { OperationLogDownloadService } from '../sync/operation-log-download.service';
import { OperationLogUploadService } from '../sync/operation-log-upload.service';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { RejectedOpsHandlerService } from '../sync/rejected-ops-handler.service';
import { SupersededOperationResolverService } from '../sync/superseded-operation-resolver.service';
import { SyncProviderManager } from '../sync-providers/provider-manager.service';
import { OperationSyncCapable } from '../sync-providers/provider.interface';
import { RepairOperationService } from '../validation/repair-operation.service';
import { DB_NAME, STORE_NAMES } from './db-keys.const';
import { IndexedDbOpLogAdapter } from './indexed-db-op-log-adapter';
import { OP_LOG_DB_ADAPTER_FACTORY } from './op-log-db-adapter.token';
import { DbTxMode, OpLogTx } from './op-log-db-adapter';
import { OperationLogCompactionService } from './operation-log-compaction.service';
import { OperationLogStoreService } from './operation-log-store.service';

const PLUGIN = 'commit-test';
const KEY = 'goal';
const ENTITY = composeId(PLUGIN, KEY);
const CLIENT = 'B_commitClient';
const NEXT_CLIENT = 'B_restoreClient';
const A = '{"ver":"a"}';
const B = '{"ver":"b"}';
const UNKNOWN = { state: 'unknown' };
const SHA_B = '88c0829772c0232be2a93e19af50482da5eb20f2d6c7f0baa89e566ea4a8bb74';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('OperationLogStoreService save confirmation', () => {
  let journal: OperationLogStoreService;
  let client: ClientIdService;
  let adapter: IndexedDbOpLogAdapter;
  let provider: jasmine.SpyObj<OperationSyncCapable>;

  const boot = async (data = B): Promise<void> => {
    adapter = new IndexedDbOpLogAdapter();
    TestBed.configureTestingModule({
      providers: [
        SaveStateService,
        provideMockStore({ initialState: { pluginUserData: [{ id: ENTITY, data }] } }),
        { provide: OP_LOG_DB_ADAPTER_FACTORY, useValue: () => adapter },
        { provide: SyncWrapperService, useValue: { syncState$: of('IN_SYNC') } },
        { provide: IS_ONLINE$, useValue: of(true) },
        {
          provide: SnackService,
          useValue: jasmine.createSpyObj('SnackService', ['open']),
        },
        { provide: OperationEncryptionService, useValue: {} },
        {
          provide: StateSnapshotService,
          useValue: {
            getStateSnapshotForOperationLog: () => ({
              task: {
                ids: ['localTask'],
                entities: { localTask: { id: 'localTask' } },
              },
              pluginUserData: [{ id: ENTITY, data }],
            }),
          },
        },
        { provide: OperationWriteFlushService, useValue: {} },
        { provide: SupersededOperationResolverService, useValue: {} },
        { provide: RepairOperationService, useValue: {} },
        { provide: OperationLogDownloadService, useValue: {} },
        {
          provide: SyncProviderManager,
          useValue: {
            getActiveProvider: () => null,
            assertSyncEpochUnchanged: jasmine.createSpy('assertSyncEpochUnchanged'),
          },
        },
      ],
    });
    client = TestBed.inject(ClientIdService);
    journal = TestBed.inject(OperationLogStoreService);
    await journal.init();
  };

  beforeEach(async () => {
    await boot();
    await client.persistClientId(CLIENT);
    provider = jasmine.createSpyObj<OperationSyncCapable>(
      'SuperSync transport',
      [
        'downloadOps',
        'getLastServerSeq',
        'setLastServerSeq',
        'uploadOps',
        'uploadSnapshot',
      ],
      { supportsOperationSync: true, providerMode: 'superSyncOps' },
    );
    provider.getLastServerSeq.and.resolveTo(0);
    provider.setLastServerSeq.and.resolveTo();
    provider.uploadOps.and.callFake(async (ops) => ({
      results: [...ops].reverse().map(({ id }) => ({ opId: id, accepted: true })),
      latestSeq: ops.length,
    }));
    provider.uploadSnapshot.and.resolveTo({ accepted: true, serverSeq: 1 });
  });

  type SaveState = Awaited<ReturnType<SaveStateService['getSyncedDataSaveState']>>;
  const read = async (): Promise<SaveState['keys'][string]> =>
    (
      await TestBed.inject<SaveStateService>(SaveStateService).getSyncedDataSaveState(
        PLUGIN,
        [KEY],
      )
    ).keys[KEY];

  const op = (data: string, author = CLIENT, counter = 1): Operation => ({
    id: uuidv7(),
    actionType: ActionType.PLUGIN_UPSERT_USER_DATA,
    entityType: 'PLUGIN_USER_DATA',
    entityId: ENTITY,
    opType: OpType.Update,
    payload: {
      actionPayload: { pluginUserData: { id: ENTITY, data } },
      entityChanges: [],
    },
    clientId: author,
    vectorClock: { [author]: counter },
    timestamp: Date.now(),
    schemaVersion: 1,
  });

  const replacement = (clientId = NEXT_CLIENT): Operation => ({
    ...op(B, clientId),
    actionType: ActionType.LOAD_ALL_DATA,
    entityType: 'ALL',
    entityId: undefined,
    opType: OpType.BackupImport,
    payload: {
      task: { ids: [], entities: {} },
      project: { ids: [], entities: {} },
      tag: { ids: [], entities: {} },
      globalConfig: { sync: { isEnabled: false } },
      pluginUserData: [{ id: ENTITY, data: B }],
    },
  });

  const importSameData = (): Promise<void> =>
    TestBed.inject(LockService).request(LOCK_NAMES.OPERATION_LOG, () =>
      journal.runDestructiveStateReplacement({
        syncImportOp: replacement(),
        snapshotEntityKeys: [],
      }),
    );

  for (const path of ['accepted', 'duplicate', 'deferred', 'snapshot'] as const) {
    it(`writes receipts only after commit for each acknowledgement path (${path})`, async () => {
      const older = op(A);
      const latest = op(B, CLIENT, 2);
      const remote = op(A, NEXT_CLIENT);
      await journal.append(older, 'local');
      const latestSeq = await journal.append(latest, 'local');
      await journal.append(remote, 'remote');
      if (path === 'snapshot') {
        await journal.append({ ...replacement(CLIENT), vectorClock: { [CLIENT]: 3 } });
      }

      let acknowledgedCommit = false;
      let awaitingCommit = false;
      const transaction = adapter.transaction.bind(adapter);
      spyOn(adapter, 'transaction').and.callFake(
        async <T>(
          stores: string[],
          mode: DbTxMode,
          run: (tx: OpLogTx) => Promise<T>,
        ): Promise<T> => {
          const commitsOps = stores.includes(STORE_NAMES.OPS) && mode === 'readwrite';
          awaitingCommit = commitsOps;
          try {
            const result = await transaction(stores, mode, run);
            if (commitsOps) {
              acknowledgedCommit = true;
            }
            return result;
          } finally {
            awaitingCommit = false;
          }
        },
      );

      const nativeTx = IDBDatabase.prototype.transaction;
      const receiptWrites = spyOn(IDBDatabase.prototype, 'transaction').and.callFake(
        function (this: IDBDatabase, stores, mode, options) {
          if (this.name !== DB_NAME && mode === 'readwrite') {
            expect(awaitingCommit).toBeFalse();
            expect(acknowledgedCommit).toBeTrue();
          }
          return nativeTx.call(this, stores, mode, options);
        },
      );
      const upload = TestBed.inject(OperationLogUploadService);
      if (path === 'duplicate') {
        provider.uploadOps.and.callFake(async (ops) => ({
          results: ops.map(({ id }) => ({
            opId: id,
            accepted: false,
            errorCode: 'DUPLICATE_OPERATION',
          })),
          latestSeq: ops.length,
        }));
        const result = await upload.uploadPendingOps(provider);
        await TestBed.inject(RejectedOpsHandlerService).handleRejectedOps(
          [...result.rejectedOps].reverse(),
        );
      } else if (path === 'deferred') {
        const result = await upload.uploadPendingOps(provider, {
          deferAcknowledgement: true,
        });
        expect((await journal.getOpById(latest.id))?.syncedAt).toBeUndefined();
        expect(await read()).toEqual(UNKNOWN);
        expect(result.pendingAcknowledgementSeqs).toContain(latestSeq);
        await journal.markSynced(
          result.pendingAcknowledgementSeqs ?? [],
          result.pendingAcknowledgementOriginals,
        );
      } else {
        await upload.uploadPendingOps(provider);
        if (path === 'snapshot') {
          expect(provider.uploadSnapshot).toHaveBeenCalled();
          expect(provider.uploadOps).not.toHaveBeenCalled();
        }
      }

      expect((await journal.getOpById(latest.id))?.syncedAt).toEqual(jasmine.any(Number));
      expect(acknowledgedCommit).toBeTrue();
      expect(
        receiptWrites.calls
          .all()
          .some(
            ({ object, args }) =>
              (object as IDBDatabase).name !== DB_NAME && args[1] === 'readwrite',
          ),
      ).toBeTrue();
      expect(await read()).toEqual(
        jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
      );
    });
  }

  it('does not write a receipt when the acknowledgement transaction rolls back', async () => {
    const entry = op(B);
    const seq = await journal.append(entry);
    const original = adapter.transaction.bind(adapter);
    spyOn(adapter, 'transaction').and.callFake(
      <T>(stores: string[], mode: DbTxMode, work: (tx: OpLogTx) => Promise<T>) =>
        original(stores, mode, async (tx) => {
          await work(tx);
          throw new Error('synthetic rollback before commit');
        }),
    );
    await expectAsync(journal.markSynced([seq])).toBeRejectedWithError(
      'synthetic rollback before commit',
    );
    expect((await journal.getOpById(entry.id))?.syncedAt).toBeUndefined();
    expect(await read()).toEqual(UNKNOWN);
  });

  it('ignores acknowledged rows authored by another client and rows received remotely', async () => {
    const own = await journal.append(op(B));
    const previousClient = await journal.append(op(A, NEXT_CLIENT));
    const remote = await journal.append(op(A, CLIENT, 2), 'remote');
    await journal.markSynced([own, previousClient, remote]);
    expect(await read()).toEqual(
      jasmine.objectContaining({ state: 'saved', valueSha256: SHA_B }),
    );
    await client.persistClientId(NEXT_CLIENT);
    TestBed.resetTestingModule();
    await boot(A);
    expect(await read()).toEqual(UNKNOWN);
  });

  it('keeps rejection and compaction unconfirmed', async () => {
    const now = spyOn(Date, 'now').and.returnValue(Date.UTC(2026, 0, 5));
    const entry = op(B);
    await journal.append(entry);
    await journal.markRejected([entry.id]);
    expect(await read()).toEqual(UNKNOWN);
    now.and.returnValue(Date.UTC(2026, 0, 5) + EMERGENCY_COMPACTION_RETENTION_MS + 1);
    expect(
      await TestBed.inject(OperationLogCompactionService).emergencyCompact(),
    ).toBeTrue();
    expect(await journal.getOpById(entry.id)).toBeUndefined();
    TestBed.resetTestingModule();
    await boot();
    expect(await read()).toEqual(UNKNOWN);
  });

  for (const rejectImport of [false, true]) {
    it(`keeps ${rejectImport ? 'rejected' : 'interrupted'} import unconfirmed across restart`, async () => {
      await journal.markSynced([await journal.append(op(B))]);
      expect(await read()).toEqual(jasmine.objectContaining({ state: 'saved' }));
      await importSameData(); // No loadAllData: the applied bytes are unchanged.
      if (rejectImport) {
        const imported = await journal.getLatestFullStateOp();
        expect(imported?.opType).toBe(OpType.BackupImport);
        await journal.markRejected([imported!.id]);
      }
      expect(await read()).toEqual(UNKNOWN);
      TestBed.resetTestingModule();
      await boot();
      expect(await client.loadClientId()).toBe(NEXT_CLIENT);
      expect(await read()).toEqual(UNKNOWN);
    });
  }

  it('keeps a missed receipt unconfirmed after the operation has committed', async () => {
    const entry = op(B);
    const seq = await journal.append(entry);
    const nativeTx = IDBDatabase.prototype.transaction;
    const transaction = spyOn(IDBDatabase.prototype, 'transaction').and.callFake(
      function (this: IDBDatabase, stores, mode, options) {
        if (this.name !== DB_NAME && mode === 'readwrite') {
          throw new DOMException('synthetic receipt write failure', 'QuotaExceededError');
        }
        return nativeTx.call(this, stores, mode, options);
      },
    );
    await journal.markSynced([seq]);
    expect((await journal.getOpById(entry.id))?.syncedAt).toEqual(jasmine.any(Number));
    expect(
      transaction.calls
        .all()
        .some(
          ({ object, args }) =>
            (object as IDBDatabase).name !== DB_NAME && args[1] === 'readwrite',
        ),
    ).toBeTrue();
    transaction.and.callThrough();
    TestBed.resetTestingModule();
    await boot();
    expect(await read()).toEqual(UNKNOWN);
  });

  it('keeps a late receipt from the former client unconfirmed', async () => {
    const oldSeq = await journal.append(op(B));
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const reached = deferred();
    const release = deferred();
    const sha = spyOn(crypto.subtle, 'digest').and.callFake(async (algorithm, data) => {
      reached.resolve();
      await release.promise;
      return digest(algorithm, data);
    });
    const acknowledgement = journal.markSynced([oldSeq]);
    try {
      await Promise.race([reached.promise, acknowledgement]);
      expect(sha).toHaveBeenCalled();
      expect(await journal.hasSyncedOps()).toBeTrue();
      await importSameData();
    } finally {
      release.resolve();
      await acknowledgement;
      sha.and.callThrough();
    }
    expect(await read()).toEqual(UNKNOWN);
  });
});
