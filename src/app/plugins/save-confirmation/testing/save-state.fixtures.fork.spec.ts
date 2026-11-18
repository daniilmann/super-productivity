import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { BehaviorSubject } from 'rxjs';
import { SnackService } from '../../../core/snack/snack.service';
import { ClientIdService } from '../../../core/util/client-id.service';
import { SyncWrapperService } from '../../../imex/sync/sync-wrapper.service';
import { LOCK_NAMES } from '../../../op-log/core/operation-log.const';
import {
  ActionType,
  isFullStateOpType,
  OpType,
} from '../../../op-log/core/operation.types';
import { OperationLogStoreService } from '../../../op-log/persistence/operation-log-store.service';
import { TabSeqFrontierService } from '../../../op-log/persistence/tab-seq-frontier.service';
import { LockService } from '../../../op-log/sync/lock.service';
import { OperationEncryptionService } from '../../../op-log/sync/operation-encryption.service';
import { OperationLogDownloadService } from '../../../op-log/sync/operation-log-download.service';
import { SuperSyncStatusService } from '../../../op-log/sync/super-sync-status.service';
import { CLIENT_ID_PROVIDER } from '../../../op-log/util/client-id.provider';
import {
  SyncProviderManager,
  SyncStatusChangePayload,
} from '../../../op-log/sync-providers/provider-manager.service';
import { OperationSyncCapable } from '../../../op-log/sync-providers/provider.interface';
import { IS_ONLINE$ } from '../../../util/is-online.token';
import { uuidv7 } from '../../../util/uuid-v7';
import {
  MAX_PLUGIN_DATA_SIZE,
  PluginUserDataState,
} from '../../plugin-persistence.model';
import { selectPluginUserDataFeatureState } from '../../store/plugin-user-data.reducer';
import { composeId } from '../../util/plugin-persistence-key.util';
import { SaveStateService } from '../save-state.service';

const PLUGIN = 'save-test';
export const KEY = 'goal';
export const ENTITY = composeId(PLUGIN, KEY);
export const CLIENT = 'B_receiptClient';
export const NEXT_CLIENT = 'B_importClient';
export const A = '\uFEFF {"ver":"a", "value":"é"}\n' + ' '.repeat(1024);
export const B = '{"ver":"b", "value":"next"}\n';
export const SHA_A = 'ee8a5a30e249b65d6c7cb94de64c5c422289d7145d3deeb4554c43e577792138';
export const SHA_B = '5f2fa43e940f038878841477904db0590d82b5f2c7536812ad1a01cfaa8db109';
const MAX_DECOMPRESSED_SIZE = MAX_PLUGIN_DATA_SIZE * 2;
const MAX_RAW_LENGTH = MAX_DECOMPRESSED_SIZE * 2;

export const gzip = async (bytes: BlobPart): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const encoded = (bytes: Uint8Array): string =>
  'GZ1:' + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));

const backupImportType = (): OpType => {
  const type = 'BACKUP_IMPORT';
  if (!isFullStateOpType(type)) {
    throw new Error(`Unregistered full-state operation type: ${type}`);
  }
  return type;
};

export const BACKUP_IMPORT = backupImportType();

export const INVALID_STORED_VALUES = [
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
] as const;

interface SaveStateFixture {
  store: MockStore;
  apply: (state: PluginUserDataState) => void;
  client: ClientIdService;
  lock: LockService;
  sync: BehaviorSubject<SyncStatusChangePayload>;
  online: BehaviorSubject<boolean>;
  read: () => ReturnType<SaveStateService['getSyncedDataSaveState']>;
  setApplied: (data: string) => void;
  acknowledge: (data: string, author?: string) => Promise<void>;
}

export const bootSaveState = async (): Promise<SaveStateFixture> => {
  const sync = new BehaviorSubject<SyncStatusChangePayload>('IN_SYNC');
  const online = new BehaviorSubject(true);
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
  const store = TestBed.inject<MockStore>(MockStore);
  const selector = store.overrideSelector(
    selectPluginUserDataFeatureState,
    [] as PluginUserDataState,
  );
  const apply = (state: PluginUserDataState): void => {
    selector.setResult(state);
    store.refreshState();
  };
  const journal = TestBed.inject(OperationLogStoreService);
  await journal.init();
  const client = TestBed.inject(ClientIdService);
  const lock = TestBed.inject(LockService);

  const read = (): ReturnType<SaveStateService['getSyncedDataSaveState']> =>
    TestBed.inject<SaveStateService>(SaveStateService).getSyncedDataSaveState(PLUGIN, [
      KEY,
    ]);
  const setApplied = (data: string): void => {
    apply([{ id: ENTITY, data }]);
  };
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

  return { store, apply, client, lock, sync, online, read, setApplied, acknowledge };
};

export const downloadTime = async (serverTime: number): Promise<void> => {
  const provider = jasmine.createSpyObj<OperationSyncCapable>(
    'SuperSync transport',
    ['downloadOps', 'getLastServerSeq'],
    { supportsOperationSync: true, providerMode: 'superSyncOps' },
  );
  provider.getLastServerSeq.and.resolveTo(0);
  const downloadOps = provider.downloadOps.and.resolveTo({
    ops: [],
    hasMore: false,
    latestSeq: 0,
    serverTime,
  });
  const result = await TestBed.inject(OperationLogDownloadService).downloadRemoteOps(
    provider,
  );
  expect(result.success).toBeTrue();
  expect(downloadOps).toHaveBeenCalled();
};

export const replaceStateFromOtherTab = async (
  lock: LockService,
  otherTab: ClientIdService,
): Promise<void> => {
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
          opType: BACKUP_IMPORT,
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
};

export const holdCompressionWrite = (): {
  writing: Promise<void>;
  release: () => void;
} => {
  const originalWrite = Reflect.get(WritableStreamDefaultWriter.prototype, 'write');
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
  return { writing, release };
};
