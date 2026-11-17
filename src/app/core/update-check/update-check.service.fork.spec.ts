import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  discardPeriodicTasks,
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { MiscConfig } from '../../features/config/global-config.model';
import { BannerService } from '../banner/banner.service';
import { LS } from '../persistence/storage-keys.const';
import { SnackService } from '../snack/snack.service';
import { isUpdateCheckPossible } from './is-update-check-possible.util';
import { UpdateCheckService } from './update-check.service';

describe('Fork upstream update policy', () => {
  let service: UpdateCheckService;
  let http: HttpTestingController;
  let misc$: BehaviorSubject<Partial<MiscConfig> | undefined>;
  let banner: jasmine.SpyObj<BannerService>;
  let snack: jasmine.SpyObj<SnackService>;
  let openExternal: jasmine.Spy;
  let openWindow: jasmine.Spy;
  let previousEa: unknown;
  let previousDismissedVersion: string | null;

  beforeEach(() => {
    misc$ = new BehaviorSubject<Partial<MiscConfig> | undefined>(undefined);
    banner = jasmine.createSpyObj('BannerService', ['open', 'dismiss']);
    snack = jasmine.createSpyObj('SnackService', ['open']);
    openExternal = jasmine.createSpy('openExternalUrl');
    openWindow = spyOn(window, 'open');
    previousEa = (window as unknown as { ea?: unknown }).ea;
    (window as unknown as { ea: unknown }).ea = { openExternalUrl: openExternal };
    previousDismissedVersion = localStorage.getItem(LS.UPDATE_CHECK_DISMISSED_VERSION);
    localStorage.removeItem(LS.UPDATE_CHECK_DISMISSED_VERSION);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        UpdateCheckService,
        { provide: GlobalConfigService, useValue: { misc$ } },
        { provide: BannerService, useValue: banner },
        { provide: SnackService, useValue: snack },
      ],
    });
    service = TestBed.inject(UpdateCheckService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    misc$.complete();
    (window as unknown as { ea?: unknown }).ea = previousEa;
    if (previousDismissedVersion === null) {
      localStorage.removeItem(LS.UPDATE_CHECK_DISMISSED_VERSION);
    } else {
      localStorage.setItem(LS.UPDATE_CHECK_DISMISSED_VERSION, previousDismissedVersion);
    }
  });

  // Drain unexpected requests too: on upstream the assertion fails immediately,
  // rather than leaving checkForUpdate() pending until its network timeout.
  const expectNoRequestOrFeedback = (): void => {
    const requests = http.match(() => true);
    expect(requests.length).withContext('no upstream release request').toBe(0);
    requests.forEach((request) => request.flush({ tag_name: 'v999.0.0' }));
    flushMicrotasks();
    expect(banner.open).not.toHaveBeenCalled();
    expect(banner.dismiss).not.toHaveBeenCalled();
    expect(snack.open).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(localStorage.getItem(LS.UPDATE_CHECK_DISMISSED_VERSION)).toBeNull();
  };

  [true, false, undefined].forEach((setting) => {
    const settings = setting === undefined ? {} : { isCheckForUpdates: setting };

    it(`reports update checks unavailable with setting ${setting}`, () => {
      misc$.next(settings);
      expect(isUpdateCheckPossible()).toBe(false);
    });

    [false, true].forEach((isUserTriggered) => {
      it(`blocks repeated direct checks: setting=${setting}, user=${isUserTriggered}`, fakeAsync(() => {
        misc$.next(settings);
        void service.checkForUpdate({ isUserTriggered });
        void service.checkForUpdate({ isUserTriggered });
        expectNoRequestOrFeedback();
        void service.checkForUpdate({ isUserTriggered });
        expectNoRequestOrFeedback();
      }));
    });
  });

  it('blocks the default direct call before settings hydration', fakeAsync(() => {
    void service.checkForUpdate();
    expectNoRequestOrFeedback();
  }));

  it('does not start checks on init, setting changes or later timer intervals', fakeAsync(() => {
    service.init();
    tick(30_001);
    expectNoRequestOrFeedback();
    [false, true, undefined, false, true].forEach((setting) => {
      misc$.next(setting === undefined ? {} : { isCheckForUpdates: setting });
      tick(30_001);
      expectNoRequestOrFeedback();
    });
    tick(2 * 24 * 60 * 60 * 1000);
    expectNoRequestOrFeedback();
    discardPeriodicTasks();
  }));
});
