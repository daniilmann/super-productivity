import { ReplaySubject, Subject } from 'rxjs';
import { routeCapacitorAppUrl } from './app-url-open-router';
import { AppUriTaskAction } from '../features/tasks/util/parse-app-uri-task-action';
import { AppUriQuickAction } from './app-uri-actions/parse-app-uri-quick-action';

/**
 * Capacitor delivers a cold-start `appUrlOpen` URL only to the *first*
 * listener registered for the event and then discards the retained argument
 * (`CAPPlugin.m`, `addEventListener` → `sendRetainedArgumentsForEvent`).
 * With one listener per consumer, a launch URL for whichever consumer
 * registered second was silently dropped. These cover the router that
 * replaced those two listeners.
 *
 * The sinks mirror production's types: the task and quick-action sinks replay,
 * because those actions do arrive before Angular exists on a cold launch, so
 * those tests subscribe *after* routing. The OAuth sink is a plain `Subject`
 * (a cold-start callback cannot be completed at all, see
 * `pending-capacitor-oauth-url.ts`), so those tests subscribe first, as its
 * real consumer does at bootstrap.
 */
describe('routeCapacitorAppUrl', () => {
  let taskSink: ReplaySubject<AppUriTaskAction>;
  let oAuthSink: Subject<string>;
  let quickSink: ReplaySubject<AppUriQuickAction>;

  beforeEach(() => {
    taskSink = new ReplaySubject<AppUriTaskAction>(1);
    oAuthSink = new Subject<string>();
    quickSink = new ReplaySubject<AppUriQuickAction>(1);
  });

  // Always pass all three sinks: an omitted one falls back to the app-wide
  // singleton, which persists across tests and would replay into the next.
  const route = (url: string): ReturnType<typeof routeCapacitorAppUrl> =>
    routeCapacitorAppUrl(url, taskSink, oAuthSink, quickSink);

  const OAUTH_URLS = [
    'com.super-productivity.app://oauth-callback?code=ABC123',
    'superproductivity://oauth-callback?code=ABC123',
    'com.super-productivity.app://plugin-oauth-callback?code=ABC123',
  ];

  const QUICK_ACTION_URLS = [
    'com.super-productivity.app://add-task',
    'com.super-productivity.app://today',
    'com.super-productivity.app://inbox',
  ];

  describe('quick-action route family', () => {
    QUICK_ACTION_URLS.forEach((url) => {
      it(`should deliver "${url}" to the quick-action consumer`, () => {
        expect(route(url)).toBe('quick-action');

        // As with task actions, an iOS home screen quick action can cold-launch
        // the app, so the consumer subscribes long after the URL arrived.
        const received: AppUriQuickAction[] = [];
        quickSink.subscribe((a) => received.push(a));

        expect(received.length).toBe(1);
      });
    });

    it('should not leak a quick action into the other route families', () => {
      let oAuthReceived = false;
      oAuthSink.subscribe(() => (oAuthReceived = true));

      route('com.super-productivity.app://today');

      let taskReceived = false;
      taskSink.subscribe(() => (taskReceived = true));

      expect(oAuthReceived).toBe(false);
      expect(taskReceived).toBe(false);
    });
  });

  describe('OAuth route family', () => {
    OAUTH_URLS.forEach((url) => {
      it(`should deliver "${url.split('?')[0]}" to the OAuth consumer`, () => {
        const received: string[] = [];
        oAuthSink.subscribe((u) => received.push(u));

        expect(route(url)).toBe('other');
        expect(received).toEqual([url]);
      });
    });

    it('should not leak an OAuth callback into the task route family', () => {
      route(OAUTH_URLS[0]);

      let taskReceived = false;
      taskSink.subscribe(() => (taskReceived = true));

      expect(taskReceived).toBe(false);
    });
  });

  it('should route an unrecognized URL to the OAuth consumer, which ignores it', () => {
    // Unknown routes go to the OAuth side rather than being dropped here, so
    // there is exactly one owner deciding what is not a callback.
    const received: string[] = [];
    oAuthSink.subscribe((u) => received.push(u));

    expect(route('superproductivity://toggle-visibility')).toBe('other');
    expect(received).toEqual(['superproductivity://toggle-visibility']);
  });
});
