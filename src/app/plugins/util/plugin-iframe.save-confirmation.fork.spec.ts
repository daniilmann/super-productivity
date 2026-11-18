import { Injector, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ActivatedRoute, Router } from '@angular/router';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { TranslateModule } from '@ngx-translate/core';
import { PluginIframeMessageType } from '@super-productivity/plugin-api';
import { openDB } from 'idb';
import { EMPTY, of } from 'rxjs';
import { LayoutService } from '../../core-ui/layout/layout.service';
import { DataInitService } from '../../core/data-init/data-init.service';
import { DateService } from '../../core/date/date.service';
import { NotifyService } from '../../core/notify/notify.service';
import { SnackService } from '../../core/snack/snack.service';
import { CustomThemeService } from '../../core/theme/custom-theme.service';
import { GlobalThemeService } from '../../core/theme/global-theme.service';
import { ClientIdService } from '../../core/util/client-id.service';
import { TaskArchiveService } from '../../features/archive/task-archive.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { IssueSyncAdapterRegistryService } from '../../features/issue/two-way-sync/issue-sync-adapter-registry.service';
import { ProjectService } from '../../features/project/project.service';
import { TagService } from '../../features/tag/tag.service';
import { TaskService } from '../../features/tasks/task.service';
import { WorkContextService } from '../../features/work-context/work-context.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { LOCK_NAMES } from '../../op-log/core/operation-log.const';
import { ActionType, OpType } from '../../op-log/core/operation.types';
import {
  DB_NAME,
  DB_VERSION,
  SINGLETON_KEY,
  STORE_NAMES,
} from '../../op-log/persistence/db-keys.const';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { TabSeqFrontierService } from '../../op-log/persistence/tab-seq-frontier.service';
import { LockService } from '../../op-log/sync/lock.service';
import { CLIENT_ID_PROVIDER } from '../../op-log/util/client-id.provider';
import { IS_ONLINE$ } from '../../util/is-online.token';
import { uuidv7 } from '../../util/uuid-v7';
import { PluginHttpService } from '../issue-provider/plugin-http.service';
import { PluginIssueProviderRegistryService } from '../issue-provider/plugin-issue-provider-registry.service';
import { PluginOAuthBridgeService } from '../oauth/plugin-oauth-bridge.service';
import { PluginManifest } from '../plugin-api.model';
import { PluginBridgeService } from '../plugin-bridge.service';
import { PluginCleanupService } from '../plugin-cleanup.service';
import { PluginConfigService } from '../plugin-config.service';
import { PluginHooksService } from '../plugin-hooks';
import { PluginService } from '../plugin.service';
import { PluginTaskContextMenuRegistryService } from '../plugin-task-context-menu-registry.service';
import { PluginSecretService } from '../secret/plugin-secret.service';
import { PluginIndexComponent } from '../ui/plugin-index/plugin-index.component';
import {
  composeId,
  MAX_PLUGIN_PERSISTENCE_KEY_LENGTH,
} from './plugin-persistence-key.util';
import {
  createPluginApiScript,
  handlePluginMessage,
  PluginIframeConfig,
} from './plugin-iframe.util';

const CALLER = 'caller-test';
const OTHER = 'foreign-test';
const KEY = 'goal';
const OWN_KEY = 'own';
const METHOD = 'getSyncedDataSaveState';
const CLIENT = 'B_bridgeClient';
const NEXT = 'B_bridgeImport';
const DATA = '{"ver":"test"}';
const INDEX = '<!doctype html><html><body></body></html>';
const UNKNOWN = { state: 'unknown' };

const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  iFrame: true,
  manifestVersion: 1,
  version: '1.0.0',
  minSupVersion: '1.0.0',
  hooks: [],
  permissions: [],
});

const event = (
  source: Window,
  keys: unknown,
  bridgeToken = 'synthetic-bridge',
  bridgeGeneration = 0,
): MessageEvent =>
  new MessageEvent('message', {
    source,
    data: {
      type: PluginIframeMessageType.API_CALL,
      method: METHOD,
      args: [keys],
      callId: 'save-state',
      bridgeToken,
      bridgeGeneration,
    },
  });

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('iframe save confirmation', () => {
  let pluginService: jasmine.SpyObj<PluginService>;
  let client: ClientIdService;
  let otherTab: ClientIdService;
  let lock: LockService;
  let journal: OperationLogStoreService;
  let fixture: ComponentFixture<PluginIndexComponent> | undefined;
  let generation: number;

  beforeEach(async () => {
    fixture = undefined;
    generation = 0;
    pluginService = jasmine.createSpyObj<PluginService>('PluginService', [
      'isInitialized',
      'getPluginIndexHtml',
      'getAllPlugins',
      'getBaseCfg',
      'getPluginIframeGeneration',
    ]);
    pluginService.isInitialized.and.returnValue(true);
    pluginService.getPluginIndexHtml.and.returnValue(INDEX);
    pluginService.getAllPlugins.and.resolveTo([
      { manifest: manifest(CALLER), error: null } as never,
      { manifest: manifest(OTHER), error: null } as never,
    ]);
    pluginService.getBaseCfg.and.resolveTo({} as never);
    pluginService.getPluginIframeGeneration.and.callFake(() => generation);

    TestBed.configureTestingModule({
      imports: [PluginIndexComponent, NoopAnimationsModule, TranslateModule.forRoot()],
      providers: [
        provideMockStore({
          initialState: {
            pluginUserData: [
              { id: composeId(CALLER, OWN_KEY), data: DATA },
              { id: composeId(CALLER, KEY), data: DATA },
              { id: composeId(OTHER, KEY), data: DATA },
            ],
          },
        }),
        { provide: PluginService, useValue: pluginService },
        {
          provide: PluginCleanupService,
          useValue: jasmine.createSpyObj('PluginCleanupService', [
            'registerIframe',
            'cleanupPlugin',
          ]),
        },
        { provide: LayoutService, useValue: { isPanelResizing: signal(false) } },
        { provide: GlobalThemeService, useValue: { isDarkTheme: signal(false) } },
        { provide: CustomThemeService, useValue: { appliedThemeVersion: signal(0) } },
        { provide: ActivatedRoute, useValue: { paramMap: EMPTY } },
        { provide: WorkContextService, useValue: { activeWorkContext$: of(null) } },
        { provide: SyncWrapperService, useValue: { syncState$: of('IN_SYNC') } },
        { provide: IS_ONLINE$, useValue: of(true) },
        ...[
          MatDialog,
          Router,
          SnackService,
          NotifyService,
          PluginHooksService,
          TaskService,
          ProjectService,
          TagService,
          PluginConfigService,
          TaskArchiveService,
          PluginIssueProviderRegistryService,
          IssueSyncAdapterRegistryService,
          PluginHttpService,
          PluginOAuthBridgeService,
          PluginSecretService,
          DataInitService,
          GlobalConfigService,
          DateService,
          PluginTaskContextMenuRegistryService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    });
    journal = TestBed.inject(OperationLogStoreService);
    await journal.init();
    client = TestBed.inject(ClientIdService);
    await client.persistClientId(CLIENT);
    otherTab = new ClientIdService();
    expect(await otherTab.loadClientId()).toBe(CLIENT);
    lock = TestBed.inject(LockService);
  });

  afterEach(() => {
    if (fixture) {
      fixture.destroy();
      fixture.nativeElement.remove();
    }
  });

  const acknowledge = async (pluginId: string, key: string): Promise<void> => {
    const entityId = composeId(pluginId, key);
    const seq = await journal.append({
      id: uuidv7(),
      actionType: ActionType.PLUGIN_UPSERT_USER_DATA,
      opType: OpType.Update,
      entityType: 'PLUGIN_USER_DATA',
      entityId,
      payload: {
        actionPayload: { pluginUserData: { id: entityId, data: DATA } },
        entityChanges: [],
      },
      clientId: CLIENT,
      vectorClock: { [CLIENT]: 1 },
      timestamp: Date.now(),
      schemaVersion: 1,
    });
    await journal.markSynced([seq]);
  };

  const rotate = async (): Promise<void> => {
    const tab = Injector.create({
      parent: TestBed.inject(Injector),
      providers: [
        OperationLogStoreService,
        TabSeqFrontierService,
        { provide: CLIENT_ID_PROVIDER, useValue: otherTab },
      ],
    });
    try {
      await new LockService().request(LOCK_NAMES.OPERATION_LOG, () =>
        tab.get(OperationLogStoreService).runDestructiveStateReplacement({
          syncImportOp: {
            id: uuidv7(),
            actionType: ActionType.LOAD_ALL_DATA,
            opType: OpType.BackupImport,
            entityType: 'ALL',
            payload: { pluginUserData: [{ id: composeId(CALLER, KEY), data: DATA }] },
            clientId: NEXT,
            vectorClock: { [NEXT]: 1 },
            timestamp: Date.now(),
            schemaVersion: 1,
          },
          snapshotEntityKeys: [composeId(CALLER, KEY)],
        }),
      );
    } finally {
      tab.destroy();
    }
  };

  const config = (): PluginIframeConfig => ({
    pluginId: CALLER,
    manifest: manifest(CALLER),
    indexHtml: INDEX,
    baseCfg: {} as PluginIframeConfig['baseCfg'],
    pluginBridge: TestBed.inject(PluginBridgeService),
    bridgeToken: 'synthetic-bridge',
    bridgeGeneration: 0,
  });

  const rpc = (keys: unknown): Promise<void> =>
    handlePluginMessage(event(window, keys), config());

  const expectReply = (post: jasmine.Spy, keys: object): void => {
    expect(post).toHaveBeenCalledOnceWith(
      {
        type: PluginIframeMessageType.API_RESPONSE,
        callId: 'save-state',
        result: { sync: 'ok', keys },
      },
      '*',
    );
  };

  const saved = {
    state: 'saved',
    savedAt: jasmine.anything(),
    valueSha256: '63b0965eef2c6c4171608d53d23d317c3e4b27678dafc6dee804abe614a8843d',
  };

  const mount = async (): Promise<{
    component: PluginIndexComponent;
    source: Window;
    send: () => Promise<void>;
  }> => {
    const listen = spyOn(window, 'addEventListener').and.callThrough();
    const initialize = PluginIndexComponent.prototype.ngOnInit;
    let initialization: Promise<void> | undefined;
    spyOn(PluginIndexComponent.prototype, 'ngOnInit').and.callFake(function (
      this: PluginIndexComponent,
    ) {
      initialization = initialize.call(this);
      return initialization;
    });
    fixture = TestBed.createComponent(PluginIndexComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('directPluginId', CALLER);
    fixture.componentRef.setInput('showFullUI', false);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    expect(initialization).toBeDefined();
    await initialization;
    fixture.detectChanges();

    const frame = fixture.nativeElement.querySelector(
      'iframe[data-plugin-iframe]',
    ) as HTMLIFrameElement | null;
    const source = frame?.contentWindow;
    const [registration] = listen.calls.allArgs().filter(([type]) => type === 'message');
    const token = frame?.srcdoc.match(/const bridgeToken = "([^"]+)"/)?.[1];
    if (!source || !registration || !token) {
      throw new Error(
        component.error() ?? 'PluginIndexComponent did not mount its bridge',
      );
    }
    const handler = registration[1] as (msg: Event) => Promise<void>;
    return {
      component,
      source,
      send: (): Promise<void> => handler(event(source, [KEY], token)),
    };
  };

  it('routes only the caller keys through the read method', async () => {
    await acknowledge(OTHER, KEY);
    await acknowledge(CALLER, OWN_KEY);
    const post: jasmine.Spy = spyOn(window, 'postMessage');
    const dispatch = spyOn(TestBed.inject(MockStore), 'dispatch').and.callThrough();

    expect(createPluginApiScript(config())).toContain(METHOD);
    await rpc([KEY, OWN_KEY]);
    expectReply(post, { [KEY]: UNKNOWN, [OWN_KEY]: saved });
    expect(dispatch).not.toHaveBeenCalled();

    // The foreign receipt really confirms the same key in its own namespace.
    post.calls.reset();
    const foreign = { ...config(), pluginId: OTHER, manifest: manifest(OTHER) };
    await handlePluginMessage(event(window, [KEY]), foreign);
    expectReply(post, { [KEY]: saved });
  });

  for (const [label, keys] of [
    ['a scalar', KEY],
    ['a non-string key', [KEY, 7]],
    ['an undefined key', [KEY, undefined]],
    ['an oversized key', [KEY, 'x'.repeat(MAX_PLUGIN_PERSISTENCE_KEY_LENGTH + 1)]],
  ] as const) {
    it(`rejects ${label} before reading receipts`, async () => {
      await acknowledge(CALLER, KEY);
      const tx = spyOn(IDBDatabase.prototype, 'transaction').and.callThrough();
      const post: jasmine.Spy = spyOn(window, 'postMessage');
      await rpc(keys);
      expect(tx).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({
          type: PluginIframeMessageType.API_ERROR,
          callId: 'save-state',
          error: jasmine.stringMatching(/key|array|string|length/i),
        }),
        '*',
      );
    });
  }

  for (const point of ['while hashing', 'while waiting for the second lock'] as const) {
    it(`sends unknown when client rotation wins ${point}`, async () => {
      await acknowledge(CALLER, KEY);
      const post: jasmine.Spy = spyOn(window, 'postMessage');
      const committed = deferred();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const request = lock.request.bind(lock);
      let requests = 0;
      let rotation: Promise<void> | undefined;

      if (point === 'while hashing') {
        spyOn(crypto.subtle, 'digest').and.callFake(async (algorithm, bytes) => {
          rotation ??= rotate();
          await rotation;
          committed.resolve();
          return digest(algorithm, bytes);
        });
      } else {
        spyOn(lock, 'request').and.callFake(
          async <T>(name: string, run: () => Promise<T>) => {
            if (name === LOCK_NAMES.OPERATION_LOG && ++requests === 2) {
              // Submit rotation first, then the actual second lock request.
              rotation = rotate().then(() => committed.resolve());
            }
            return request(name, run);
          },
        );
      }

      const reply = rpc([KEY]);
      expect(
        await Promise.race([committed.promise.then(() => true), reply.then(() => false)]),
      ).toBeTrue();
      await reply;
      await rotation;
      expect(await client.loadClientId()).toBe(CLIENT);
      expect(await otherTab.loadClientId()).toBe(NEXT);
      expectReply(post, { [KEY]: UNKNOWN });
    });
  }

  it('serializes the live recipient check and postMessage with competing client rotation', async () => {
    await acknowledge(CALLER, KEY);
    const view = await mount();
    const request = lock.request.bind(lock);
    let acquisitions = 0;
    let held = 0;
    let rotation: Promise<void> | undefined;
    const trace: string[] = [];
    spyOn(lock, 'request').and.callFake(<T>(name: string, run: () => Promise<T>) =>
      request(name, async () => {
        expect(name).toBe(LOCK_NAMES.OPERATION_LOG);
        held = ++acquisitions;
        try {
          return await run();
        } finally {
          held = 0;
        }
      }),
    );
    const get = IDBObjectStore.prototype.get;
    spyOn(IDBObjectStore.prototype, 'get').and.callFake(function (
      this: IDBObjectStore,
      key,
    ) {
      const result = get.call(this, key);
      if (this.name === STORE_NAMES.CLIENT_ID && held === 2) {
        result.addEventListener(
          'success',
          () => {
            trace.push('id read');
            rotation = rotate().then(() => {
              trace.push('rotation committed');
            });
          },
          { once: true },
        );
      }
      return result;
    });
    pluginService.getPluginIframeGeneration.and.callFake(() => {
      if (held === 2) {
        trace.push('recipient checked');
      }
      return generation;
    });
    const post = spyOn(view.source, 'postMessage').and.callFake(() => {
      expect(held).toBe(2);
      trace.push('postMessage');
    });
    await view.send();
    await rotation;

    expectReply(post, { [KEY]: saved });
    expect(trace).toEqual([
      'id read',
      'recipient checked',
      'postMessage',
      'rotation committed',
    ]);
    expect(await otherTab.loadClientId()).toBe(NEXT);
    expect(await client.loadClientId()).toBe(CLIENT);
  });

  for (const fault of ['missing ID', 'ID read failure', 'second lock timeout'] as const) {
    it(`sends the appropriate reply after ${fault}`, async () => {
      await acknowledge(CALLER, KEY);
      const post: jasmine.Spy = spyOn(window, 'postMessage');
      const db = await openDB(DB_NAME, DB_VERSION);
      const request = lock.request.bind(lock);
      const gate = deferred();
      let acquisitions = 0;
      let failRead = false;
      let blocking: Promise<void> | undefined;
      const get = IDBObjectStore.prototype.get;
      spyOn(IDBObjectStore.prototype, 'get').and.callFake(function (
        this: IDBObjectStore,
        key,
      ) {
        if (this.name === STORE_NAMES.CLIENT_ID && failRead) {
          throw new DOMException('synthetic read failure', 'UnknownError');
        }
        return get.call(this, key);
      });
      spyOn(lock, 'request').and.callFake(<T>(name: string, run: () => Promise<T>) => {
        if (
          name === LOCK_NAMES.OPERATION_LOG &&
          ++acquisitions === 2 &&
          fault === 'second lock timeout'
        ) {
          blocking = request(name, () => gate.promise);
          return request(name, run, 15);
        }
        return request(name, async () => {
          if (acquisitions === 2 && fault === 'missing ID') {
            await db.delete(STORE_NAMES.CLIENT_ID, SINGLETON_KEY);
          }
          if (acquisitions === 2 && fault === 'ID read failure') {
            failRead = true;
          }
          return run();
        });
      });
      try {
        await rpc([KEY]);
        expect(acquisitions).toBe(2);
        if (fault === 'second lock timeout') {
          expect(post).toHaveBeenCalledOnceWith(
            jasmine.objectContaining({
              type: PluginIframeMessageType.API_ERROR,
              callId: 'save-state',
              error: jasmine.stringMatching(/timed out|timeout/i),
            }),
            '*',
          );
        } else {
          expectReply(post, { [KEY]: UNKNOWN });
        }
      } finally {
        gate.resolve();
        await blocking;
        db.close();
      }
    });
  }

  for (const invalidation of [
    'switch plugin in the same window',
    'close iframe',
    'change generation',
  ] as const) {
    for (const outcome of ['reply', 'error'] as const) {
      it(`drops the old ${outcome} when the view can ${invalidation}`, async () => {
        await acknowledge(CALLER, KEY);
        const view = await mount();
        const post = spyOn(view.source, 'postMessage');
        const beforeSecond = deferred();
        const resume = deferred();
        const request = lock.request.bind(lock);
        let requests = 0;
        let blocking: Promise<void> | undefined;
        const release = deferred();
        spyOn(lock, 'request').and.callFake(
          async <T>(name: string, run: () => Promise<T>) => {
            if (name === LOCK_NAMES.OPERATION_LOG && ++requests === 2) {
              beforeSecond.resolve();
              await resume.promise;
              if (outcome === 'error') {
                blocking = request(name, () => release.promise);
                return request(name, run, 15);
              }
            }
            return request(name, run);
          },
        );

        const pending = view.send();
        try {
          expect(
            await Promise.race([
              beforeSecond.promise.then(() => true),
              pending.then(() => false),
            ]),
          ).toBeTrue();
          if (invalidation === 'switch plugin in the same window') {
            view.component['_cleanupIframeCommunication']();
            view.component.pluginId.set(OTHER);
            await view.component['_loadPluginIndex'](OTHER);
            expect(
              (fixture!.nativeElement.querySelector('iframe') as HTMLIFrameElement)
                .contentWindow,
            ).toBe(view.source);
          } else if (invalidation === 'close iframe') {
            fixture!.destroy();
            fixture!.nativeElement.remove();
            fixture = undefined;
          } else {
            generation++;
          }
        } finally {
          resume.resolve();
          try {
            await pending;
          } finally {
            release.resolve();
            await blocking;
          }
        }
        expect(post).not.toHaveBeenCalled();
      });
    }
  }
});
