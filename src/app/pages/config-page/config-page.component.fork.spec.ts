import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import {
  ComponentFixture,
  fakeAsync,
  flushMicrotasks,
  TestBed,
} from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { BehaviorSubject, EMPTY, of } from 'rxjs';
import { BannerService } from '../../core/banner/banner.service';
import { ShareService } from '../../core/share/share.service';
import { SnackService } from '../../core/snack/snack.service';
import { UpdateCheckService } from '../../core/update-check/update-check.service';
import { FocusModeLocalSettingsService } from '../../features/config/focus-mode-local-settings.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { MiscConfig } from '../../features/config/global-config.model';
import { TaskWidgetSettingsService } from '../../features/config/task-widget-settings.service';
import { LocalBackupService } from '../../imex/local-backup/local-backup.service';
import { SyncConfigService } from '../../imex/sync/sync-config.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { SyncProviderManager } from '../../op-log/sync-providers/provider-manager.service';
import { PluginBridgeService } from '../../plugins/plugin-bridge.service';
import { T } from '../../t.const';
import { IS_ANDROID_WEB_VIEW_TOKEN } from '../../util/is-android-web-view';
import { ConfigPageComponent } from './config-page.component';

describe('Fork upstream update policy: settings page', () => {
  let fixture: ComponentFixture<ConfigPageComponent>;
  let http: HttpTestingController;
  let misc$: BehaviorSubject<Partial<MiscConfig>>;
  let banner: jasmine.SpyObj<{
    open: BannerService['open'];
    dismiss: BannerService['dismiss'];
  }>;
  let snack: jasmine.SpyObj<{ open: SnackService['open'] }>;
  let copy: jasmine.Spy<ShareService['copyToClipboard']>;

  beforeEach(() => {
    misc$ = new BehaviorSubject<Partial<MiscConfig>>({ isCheckForUpdates: true });
    banner = jasmine.createSpyObj<BannerService>('BannerService', ['open', 'dismiss']);
    snack = jasmine.createSpyObj<SnackService>('SnackService', ['open']);
    copy = jasmine
      .createSpy<ShareService['copyToClipboard']>('copyToClipboard')
      .and.resolveTo({ success: true });
    TestBed.configureTestingModule({
      imports: [ConfigPageComponent, TranslateModule.forRoot()],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        UpdateCheckService,
        { provide: BannerService, useValue: banner },
        { provide: SnackService, useValue: snack },
        {
          provide: GlobalConfigService,
          // Before hydration the forms are not rendered. The actual version
          // footer, including the update entry point, is outside that guard.
          useValue: { cfg$: EMPTY, misc$ },
        },
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
        { provide: PluginBridgeService, useValue: { shortcuts: signal([]) } },
        {
          provide: SyncConfigService,
          useValue: { syncSettingsForm$: of({ isEnabled: false }) },
        },
        { provide: SyncProviderManager, useValue: {} },
        { provide: SyncWrapperService, useValue: {} },
        { provide: ShareService, useValue: { copyToClipboard: copy } },
        { provide: MatDialog, useValue: {} },
        { provide: LocalBackupService, useValue: {} },
        { provide: TaskWidgetSettingsService, useValue: {} },
        { provide: FocusModeLocalSettingsService, useValue: {} },
        { provide: IS_ANDROID_WEB_VIEW_TOKEN, useValue: false },
      ],
    });
    fixture = TestBed.createComponent(ConfigPageComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    misc$.complete();
  });

  it('control: renders the actual footer without a check-for-updates control, holds in the browser test runner without the fork change', () => {
    const root = fixture.nativeElement as HTMLElement;
    const footer = root.querySelector('footer');
    expect(footer).not.toBeNull();
    const updateControls = Array.from(root.querySelectorAll('a, button')).filter(
      (element) => element.textContent.trim() === T.PS.CHECK_FOR_UPDATES,
    );
    expect(updateControls).toEqual([]);
  });

  [true, false, undefined].forEach((setting) => {
    it(`cannot start HTTP through the real page method with setting ${String(setting)}`, fakeAsync(() => {
      misc$.next(setting === undefined ? {} : { isCheckForUpdates: setting });
      fixture.componentInstance.checkForUpdates();
      const requests = http.match(() => true);
      expect(requests.length)
        .withContext('page delegates to the real update service')
        .toBe(0);
      requests.forEach((request) => {
        request.flush({ tag_name: 'v999.0.0' });
      });
      flushMicrotasks();
      expect(banner.open).not.toHaveBeenCalled();
      expect(snack.open).not.toHaveBeenCalled();
    }));
  });

  it('keeps version copy, changelog, logs, privacy and feedback controls', fakeAsync(() => {
    const root = fixture.nativeElement as HTMLElement;
    const footer = root.querySelector('footer');
    if (!footer) {
      throw new Error('the settings footer must render');
    }
    const links = Array.from(footer.querySelectorAll('a'));
    expect(links.some((link) => link.textContent.trim() === 'Logs')).toBe(true);
    expect(links.some((link) => link.textContent.trim() === 'Changelog')).toBe(true);
    expect(links.some((link) => link.textContent.trim() === T.PS.PRIVACY_POLICY)).toBe(
      true,
    );
    expect(links.some((link) => link.textContent.trim() === T.PS.PROVIDE_FEEDBACK)).toBe(
      true,
    );
    const version = footer.querySelector<HTMLAnchorElement>('a.version');
    expect(version).not.toBeNull();
    if (!version) {
      throw new Error('the footer must contain the version link');
    }
    version.click();
    flushMicrotasks();
    expect(copy).toHaveBeenCalledOnceWith(
      fixture.componentInstance.appVersion,
      'Version',
    );
    http.expectNone(() => true);
  }));
});
