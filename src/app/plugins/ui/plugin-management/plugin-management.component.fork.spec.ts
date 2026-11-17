import { signal, WritableSignal } from '@angular/core';
import {
  ComponentFixture,
  fakeAsync,
  flushMicrotasks,
  TestBed,
} from '@angular/core/testing';
import { MatDialog, MatDialogConfig } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateModule } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { LayoutService } from '../../../core-ui/layout/layout.service';
import { SnackService } from '../../../core/snack/snack.service';
import { GlobalConfigService } from '../../../features/config/global-config.service';
import { T } from '../../../t.const';
import { DialogConfirmComponent } from '../../../ui/dialog-confirm/dialog-confirm.component';
import { PluginBridgeService } from '../../plugin-bridge.service';
import { PluginCacheService } from '../../plugin-cache.service';
import { PluginConfigService } from '../../plugin-config.service';
import { PluginMetaPersistenceService } from '../../plugin-meta-persistence.service';
import { PluginState } from '../../plugin-state.model';
import { PluginService } from '../../plugin.service';
import { PluginManagementComponent } from './plugin-management.component';

describe('Fork protected plugin removal UI', () => {
  let fixture: ComponentFixture<PluginManagementComponent>;
  let states: WritableSignal<Map<string, PluginState>>;
  let remove: jasmine.Spy<PluginService['removeUploadedPlugin']>;
  let clearMemory: jasmine.Spy<PluginService['clearUploadedPluginsFromMemory']>;
  let clearCache: jasmine.Spy<PluginCacheService['clearCache']>;
  type ConfirmDialogOpen = (
    component: typeof DialogConfirmComponent,
    config: MatDialogConfig<unknown>,
  ) => { afterClosed: () => Observable<boolean | undefined> };
  let dialog: jasmine.Spy<ConfirmDialogOpen>;

  beforeEach(() => {
    states = signal(new Map<string, PluginState>());
    remove = jasmine
      .createSpy<PluginService['removeUploadedPlugin']>('removeUploadedPlugin')
      .and.resolveTo();
    clearMemory = jasmine
      .createSpy<
        PluginService['clearUploadedPluginsFromMemory']
      >('clearUploadedPluginsFromMemory')
      .and.resolveTo();
    clearCache = jasmine
      .createSpy<PluginCacheService['clearCache']>('clearCache')
      .and.resolveTo();
    dialog = jasmine
      .createSpy<ConfirmDialogOpen>('open')
      .and.returnValue({ afterClosed: () => of(true) });
    const icons = signal(new Map<string, string>());

    TestBed.configureTestingModule({
      imports: [PluginManagementComponent, TranslateModule.forRoot()],
      providers: [
        {
          provide: PluginService,
          useValue: {
            pluginStates: states,
            getPluginPath: (id: string) => states().get(id)?.path,
            getPluginIconsSignal: () => icons,
            removeUploadedPlugin: remove,
            clearUploadedPluginsFromMemory: clearMemory,
          },
        },
        { provide: PluginMetaPersistenceService, useValue: {} },
        { provide: PluginCacheService, useValue: { clearCache } },
        { provide: PluginConfigService, useValue: {} },
        {
          provide: GlobalConfigService,
          useValue: { localization: signal({ lng: 'en' }) },
        },
        { provide: MatDialog, useValue: { open: dialog } },
        { provide: Router, useValue: {} },
        { provide: LayoutService, useValue: {} },
        { provide: Store, useValue: { selectSignal: () => signal([]) } },
        { provide: PluginBridgeService, useValue: { hasConfigHandler: () => false } },
        {
          provide: SnackService,
          useValue: jasmine.createSpyObj<SnackService>('SnackService', ['open']),
        },
      ],
    });
    fixture = TestBed.createComponent(PluginManagementComponent);
    fixture.componentInstance.communityPlugins.set([]);
  });

  const renderUploaded = (id: string, name: string, isEnabled: boolean): HTMLElement => {
    const manifest = {
      id,
      name,
      manifestVersion: 1,
      version: '1.0.0',
      minSupVersion: '1.0.0',
      hooks: [],
      permissions: [],
    };
    states.set(
      new Map([
        [
          id,
          {
            manifest,
            status: 'loaded',
            path: `uploaded://${id}`,
            type: 'uploaded',
            isEnabled,
            instance: { manifest, loaded: true, isEnabled },
          },
        ],
      ]),
    );
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const card = Array.from(root.querySelectorAll<HTMLElement>('mat-card')).find(
      (candidate) =>
        candidate.querySelector('mat-card-title')?.textContent.trim() === name,
    );
    expect(card).withContext('the loaded plugin card must actually render').toBeDefined();
    if (!card) {
      throw new Error('the loaded plugin card must actually render');
    }
    expect(card.querySelector('mat-slide-toggle')).not.toBeNull();
    return card;
  };

  const removeButton = (card: HTMLElement): HTMLButtonElement | undefined =>
    Array.from(card.querySelectorAll<HTMLButtonElement>('mat-card-actions button')).find(
      (button) => button.textContent.includes(T.PLUGINS.REMOVE),
    );

  [true, false].forEach((isEnabled) => {
    it(`hides Remove for a loaded sp-telos with isEnabled=${String(isEnabled)}`, () => {
      const card = renderUploaded('sp-telos', 'Ordinary display name', isEnabled);
      expect(removeButton(card)).toBeUndefined();
      expect(remove).not.toHaveBeenCalled();
    });

    it(`keeps Remove for another uploaded ID named sp-telos, enabled=${String(isEnabled)}`, () => {
      const card = renderUploaded('another-plugin', 'sp-telos', isEnabled);
      const button = removeButton(card);
      expect(button).toBeDefined();
      expect(button?.disabled).toBe(false);
    });
  });

  it('removes another uploaded plugin only after confirmation through its button', fakeAsync(() => {
    const card = renderUploaded('another-plugin', 'Other Plugin', true);
    const button = removeButton(card);
    expect(button).toBeDefined();
    if (!button) {
      throw new Error('the expected plugin management button must render');
    }
    button.click();
    flushMicrotasks();

    expect(dialog).toHaveBeenCalledOnceWith(DialogConfirmComponent, {
      restoreFocus: true,
      data: {
        message: T.PLUGINS.CONFIRM_REMOVE,
        translateParams: { name: 'Other Plugin' },
        okTxt: T.PLUGINS.REMOVE,
      },
    });
    expect(remove).toHaveBeenCalledOnceWith('another-plugin');
  }));

  [false, undefined].forEach((result) => {
    it(`keeps another uploaded plugin when confirmation returns ${String(result)}`, fakeAsync(() => {
      dialog.and.returnValue({ afterClosed: () => of(result) });
      const card = renderUploaded('another-plugin', 'Other Plugin', false);
      const button = removeButton(card);
      expect(button).toBeDefined();
      if (!button) {
        throw new Error('the expected plugin management button must render');
      }
      button.click();
      flushMicrotasks();

      expect(dialog).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    }));
  });

  it('preserves Remove all uploaded plugins when only sp-telos is installed', fakeAsync(() => {
    renderUploaded('sp-telos', 'Product plugin', true);
    const root = fixture.nativeElement as HTMLElement;
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) =>
        candidate.textContent.includes(T.PLUGINS.REMOVE_ALL_UPLOADED_PLUGINS),
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    if (!button) {
      throw new Error('the expected plugin management button must render');
    }
    button.click();
    flushMicrotasks();

    expect(dialog).toHaveBeenCalledOnceWith(DialogConfirmComponent, {
      restoreFocus: true,
      data: {
        message: T.PLUGINS.CONFIRM_CLEAR_CACHE,
        translateParams: { count: 1 },
        okTxt: T.PLUGINS.REMOVE_ALL_UPLOADED_PLUGINS,
      },
    });
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  }));
});
