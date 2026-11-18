import {
  ɵAnimationRendererFactory as AnimationRendererFactory,
  ɵcreateEngine as createAnimationEngine,
} from '@angular/animations/browser';
import {
  DOCUMENT,
  inject,
  Injector,
  NgZone,
  RendererFactory2,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ɵDomRendererFactory2 as DomRendererFactory } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { provideMockStore } from '@ngrx/store/testing';
import { PluginIframeMessageType } from '@super-productivity/plugin-api';
import { TranslateModule } from '@ngx-translate/core';
import { EMPTY, of } from 'rxjs';
import { LayoutService } from '../../../core-ui/layout/layout.service';
import { DataInitService } from '../../../core/data-init/data-init.service';
import { DateService } from '../../../core/date/date.service';
import { NotifyService } from '../../../core/notify/notify.service';
import { SnackService } from '../../../core/snack/snack.service';
import { CustomThemeService } from '../../../core/theme/custom-theme.service';
import { GlobalThemeService } from '../../../core/theme/global-theme.service';
import { ClientIdService } from '../../../core/util/client-id.service';
import { TaskArchiveService } from '../../../features/archive/task-archive.service';
import { GlobalConfigService } from '../../../features/config/global-config.service';
import { IssueSyncAdapterRegistryService } from '../../../features/issue/two-way-sync/issue-sync-adapter-registry.service';
import { ProjectService } from '../../../features/project/project.service';
import { TagService } from '../../../features/tag/tag.service';
import { TaskService } from '../../../features/tasks/task.service';
import { WorkContextService } from '../../../features/work-context/work-context.service';
import { SyncWrapperService } from '../../../imex/sync/sync-wrapper.service';
import { LOCK_NAMES } from '../../../op-log/core/operation-log.const';
import { ActionType, OpType } from '../../../op-log/core/operation.types';
import { OperationLogStoreService } from '../../../op-log/persistence/operation-log-store.service';
import { TabSeqFrontierService } from '../../../op-log/persistence/tab-seq-frontier.service';
import { LockService } from '../../../op-log/sync/lock.service';
import { CLIENT_ID_PROVIDER } from '../../../op-log/util/client-id.provider';
import { IS_ONLINE$ } from '../../../util/is-online.token';
import { uuidv7 } from '../../../util/uuid-v7';
import { PluginHttpService } from '../../issue-provider/plugin-http.service';
import { PluginIssueProviderRegistryService } from '../../issue-provider/plugin-issue-provider-registry.service';
import { PluginOAuthBridgeService } from '../../oauth/plugin-oauth-bridge.service';
import { PluginBaseCfg, PluginManifest } from '../../plugin-api.model';
import { BACKUP_IMPORT } from '../../save-confirmation/testing/save-state.fixtures.fork.spec';
import { PluginBridgeService } from '../../plugin-bridge.service';
import { PluginCleanupService } from '../../plugin-cleanup.service';
import { PluginConfigService } from '../../plugin-config.service';
import { PluginHooksService } from '../../plugin-hooks';
import { PluginService } from '../../plugin.service';
import { PluginTaskContextMenuRegistryService } from '../../plugin-task-context-menu-registry.service';
import { PluginSecretService } from '../../secret/plugin-secret.service';
import { PluginIndexComponent } from '../../ui/plugin-index/plugin-index.component';
import { composeId } from '../plugin-persistence-key.util';
import { handlePluginMessage, PluginIframeConfig } from '../plugin-iframe.util';

export const CALLER = 'caller-test';
export const OTHER = 'foreign-test';
export const KEY = 'goal';
export const OWN_KEY = 'own';
export const METHOD = 'getSyncedDataSaveState';
export const CLIENT = 'B_bridgeClient';
export const NEXT = 'B_bridgeImport';
const DATA = '{"ver":"test"}';
const INDEX = '<!doctype html><html><body></body></html>';

const BASE_CONFIG: PluginBaseCfg = {
  theme: 'light',
  appVersion: '1.0.0',
  platform: 'web',
  isDev: false,
};

export const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  iFrame: true,
  manifestVersion: 1,
  version: '1.0.0',
  minSupVersion: '1.0.0',
  hooks: [],
  permissions: [],
});

export const event = (
  source: Window,
  keys: unknown,
  bridgeToken = 'synthetic-bridge',
  bridgeGeneration = 0,
  documentBinding?: string | null,
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
      ...(documentBinding == null ? {} : { documentBinding }),
    },
  });

export const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

interface IframeFixture {
  client: ClientIdService;
  otherTab: ClientIdService;
  lock: LockService;
  recipientGeneration: jasmine.Spy<PluginService['getPluginIframeGeneration']>;
  acknowledge: (pluginId: string, key: string) => Promise<void>;
  rotate: () => Promise<void>;
}

export const bootIframe = async (getGeneration: () => number): Promise<IframeFixture> => {
  const pluginService = jasmine.createSpyObj<PluginService>('PluginService', [
    'isInitialized',
    'getPluginIndexHtml',
    'getAllPlugins',
    'getBaseCfg',
    'getPluginIframeGeneration',
  ]);
  pluginService.isInitialized.and.returnValue(true);
  pluginService.getPluginIndexHtml.and.returnValue(INDEX);
  pluginService.getAllPlugins.and.resolveTo(
    [CALLER, OTHER].map((id) => ({
      manifest: manifest(id),
      loaded: true,
      isEnabled: true,
    })),
  );
  pluginService.getBaseCfg.and.resolveTo(BASE_CONFIG);
  const recipientGeneration =
    pluginService.getPluginIframeGeneration.and.callFake(getGeneration);

  TestBed.configureTestingModule({
    imports: [PluginIndexComponent, TranslateModule.forRoot()],
    providers: [
      {
        // The component still has a legacy animation trigger. Use Angular's noop engine.
        provide: RendererFactory2,
        useFactory: () =>
          new AnimationRendererFactory(
            inject(DomRendererFactory),
            createAnimationEngine('noop', inject(DOCUMENT)),
            inject(NgZone),
          ),
      },
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
        useValue: jasmine.createSpyObj<PluginCleanupService>('PluginCleanupService', [
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
  const journal = TestBed.inject(OperationLogStoreService);
  await journal.init();
  const client = TestBed.inject(ClientIdService);
  await client.persistClientId(CLIENT);
  const otherTab = new ClientIdService();
  expect(await otherTab.loadClientId()).toBe(CLIENT);
  const lock = TestBed.inject(LockService);

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
            opType: BACKUP_IMPORT,
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

  return { client, otherTab, lock, recipientGeneration, acknowledge, rotate };
};

export const config = (): PluginIframeConfig => ({
  pluginId: CALLER,
  manifest: manifest(CALLER),
  indexHtml: INDEX,
  baseCfg: BASE_CONFIG,
  pluginBridge: TestBed.inject(PluginBridgeService),
  bridgeToken: 'synthetic-bridge',
  bridgeGeneration: 0,
});

export const rpc = (keys: unknown): Promise<void> =>
  handlePluginMessage(event(window, keys), config());

export const expectReply = (post: jasmine.Spy, keys: object): void => {
  expect(post).toHaveBeenCalledOnceWith(
    {
      type: PluginIframeMessageType.API_RESPONSE,
      callId: 'save-state',
      result: { sync: 'ok', keys },
    },
    '*',
  );
};

export const saved = {
  state: 'saved',
  savedAt: jasmine.anything(),
  valueSha256: '63b0965eef2c6c4171608d53d23d317c3e4b27678dafc6dee804abe614a8843d',
};

const isSrcdocReady = (frame: HTMLIFrameElement, previous?: Document): boolean => {
  const doc = frame.contentDocument;
  return doc !== previous && doc?.URL === 'about:srcdoc' && doc.readyState === 'complete';
};

const waitForSrcdoc = (frame: HTMLIFrameElement, previous?: Document): Promise<void> => {
  if (isSrcdocReady(frame, previous)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onLoad = (): void => {
      if (isSrcdocReady(frame, previous)) {
        frame.removeEventListener('load', onLoad);
        resolve();
      }
    };
    frame.addEventListener('load', onLoad);
  });
};

interface SaveConfirmationRequest {
  type: PluginIframeMessageType;
  method: string;
  documentBinding?: unknown;
}

export const readIframeSaveRequests = async (
  apiScript: string,
): Promise<{ document: Document; requests: SaveConfirmationRequest[] }> => {
  const frame = document.createElement('iframe');
  frame.sandbox.add('allow-scripts', 'allow-same-origin');
  const requests: SaveConfirmationRequest[] = [];
  const received = deferred();
  const read = ({ source, data }: MessageEvent<SaveConfirmationRequest | null>): void => {
    if (source !== frame.contentWindow) return;
    if (data?.type !== PluginIframeMessageType.API_CALL || data.method !== METHOD) return;
    requests.push(data);
    if (requests.length === 2) received.resolve();
  };

  window.addEventListener('message', read);
  const timer = window.setTimeout(received.resolve, 3000);
  try {
    frame.srcdoc = `<!doctype html>${apiScript}<script>
      void window.PluginAPI.${METHOD}([]);
      window.setTimeout(() => window.PluginAPI.${METHOD}([]), 0);
    </script>`;
    document.body.appendChild(frame);
    await received.promise;
    const doc = frame.contentDocument;
    if (doc?.URL !== 'about:srcdoc' || requests.length !== 2) {
      throw new Error('Expected two requests from a loaded srcdoc document');
    }
    return { document: doc, requests };
  } finally {
    window.clearTimeout(timer);
    window.removeEventListener('message', read);
    frame.remove();
  }
};

export const replaceIframeDocument = async (frame: HTMLIFrameElement): Promise<void> => {
  const original = frame.contentDocument;
  if (!original) {
    throw new Error('Cannot replace the iframe document before it loads');
  }
  const loaded = waitForSrcdoc(frame, original);
  frame.srcdoc = '<!doctype html><title>Replacement document</title>';
  await loaded;
};

interface MountedPlugin {
  component: PluginIndexComponent;
  source: Window;
  findFrame: () => HTMLIFrameElement | null;
  destroy: () => void;
  send: () => Promise<void>;
}

export const mountPlugin = async (): Promise<MountedPlugin> => {
  const listen = spyOn(window, 'addEventListener').and.callThrough();
  const initialize = spyOn(PluginIndexComponent.prototype, 'ngOnInit').and.callThrough();
  const fixture = TestBed.createComponent(PluginIndexComponent);
  const component = fixture.componentInstance;
  const host = fixture.nativeElement as HTMLElement;
  const destroy = (): void => {
    fixture.destroy();
    host.remove();
  };
  try {
    fixture.componentRef.setInput('directPluginId', CALLER);
    fixture.componentRef.setInput('showFullUI', false);
    document.body.appendChild(host);
    fixture.detectChanges();
    const initialization = initialize.calls.all().at(0)?.returnValue;
    expect(initialization).toBeDefined();
    await initialization;
    fixture.detectChanges();

    const findFrame = (): HTMLIFrameElement | null =>
      host.querySelector<HTMLIFrameElement>('iframe[data-plugin-iframe]');
    const frame = findFrame();
    const registration = listen.calls.allArgs().find(([type]) => type === 'message');
    const token = frame?.srcdoc.match(/const bridgeToken = "([^"]+)"/)?.[1];
    if (!frame || !registration || !token) {
      throw new Error(
        component.error() ?? 'PluginIndexComponent did not mount its bridge',
      );
    }
    await waitForSrcdoc(frame);
    const source = frame.contentWindow;
    const documentBinding = frame.contentDocument?.documentElement.getAttribute(
      'data-sp-save-document',
    );
    if (!source) throw new Error('Plugin iframe has no window after loading srcdoc');
    const handler = registration[1] as (msg: Event) => Promise<void>;
    return {
      component,
      source,
      findFrame,
      destroy,
      send: (): Promise<void> => handler(event(source, [KEY], token, 0, documentBinding)),
    };
  } catch (error) {
    destroy();
    throw error;
  }
};
