import { ReplaySubject, Subject } from 'rxjs';
import { routeCapacitorAppUrl } from './app-url-open-router';
import { AppUriTaskAction } from '../features/tasks/util/parse-app-uri-task-action';
import { AppUriQuickAction } from './app-uri-actions/parse-app-uri-quick-action';

describe('Fork task URI policy: Capacitor router', () => {
  let taskSink: ReplaySubject<AppUriTaskAction>;
  let quickSink: ReplaySubject<AppUriQuickAction>;
  let oauthSink: Subject<string>;

  beforeEach(() => {
    taskSink = new ReplaySubject<AppUriTaskAction>(1);
    quickSink = new ReplaySubject<AppUriQuickAction>(1);
    oauthSink = new Subject<string>();
  });

  afterEach(() => {
    taskSink.complete();
    quickSink.complete();
    oauthSink.complete();
  });

  const route = (url: string): ReturnType<typeof routeCapacitorAppUrl> =>
    routeCapacitorAppUrl(url, taskSink, oauthSink, quickSink);

  ['com.super-productivity.app', 'superproductivity'].forEach((scheme) => {
    [
      'create-task',
      'CrEaTe-TaSk',
      'complete-task',
      'CoMpLeTe-TaSk',
      'task-toggle-start',
      'TaSk-ToGgLe-StArT',
    ].forEach((host) => {
      ['', '?title=', '?title=Buy%20milk', '/Buy%20milk?notes=private'].forEach(
        (suffix) => {
          it(`absorbs ${scheme}://${host}${suffix} before every sink`, () => {
            const tasks: AppUriTaskAction[] = [];
            const quick: AppUriQuickAction[] = [];
            const oauth: string[] = [];
            taskSink.subscribe((action) => tasks.push(action));
            quickSink.subscribe((action) => quick.push(action));
            oauthSink.subscribe((url) => oauth.push(url));

            expect(route(`${scheme}://${host}${suffix}`)).toBe('other');

            const lateTasks: AppUriTaskAction[] = [];
            const lateQuick: AppUriQuickAction[] = [];
            const lateOauth: string[] = [];
            taskSink.subscribe((action) => lateTasks.push(action));
            quickSink.subscribe((action) => lateQuick.push(action));
            oauthSink.subscribe((url) => lateOauth.push(url));
            expect(tasks).toEqual([]);
            expect(quick).toEqual([]);
            expect(oauth).toEqual([]);
            expect(lateTasks).toEqual([]);
            expect(lateQuick).toEqual([]);
            expect(lateOauth).toEqual([]);
          });
        },
      );
    });
  });

  ['create-task', 'complete-task', 'task-toggle-start'].forEach((host) => {
    it(`does not treat plugin-oauth-callback inside ${host} notes as OAuth`, () => {
      const tasks = jasmine.createSpy('task sink');
      const quick = jasmine.createSpy('quick sink');
      const oauth = jasmine.createSpy('OAuth sink');
      taskSink.subscribe(tasks);
      quickSink.subscribe(quick);
      oauthSink.subscribe(oauth);

      route(
        `com.super-productivity.app://${host}?title=private&notes=` +
          encodeURIComponent('superproductivity://plugin-oauth-callback?code=secret'),
      );

      expect(tasks).not.toHaveBeenCalled();
      expect(quick).not.toHaveBeenCalled();
      expect(oauth).not.toHaveBeenCalled();
    });
  });

  const quickActions: { host: string; action: AppUriQuickAction }[] = [
    { host: 'add-task', action: { type: 'add-task' } },
    { host: 'today', action: { type: 'navigate', target: 'today' } },
    { host: 'inbox', action: { type: 'navigate', target: 'inbox' } },
  ];
  quickActions.forEach(({ host, action }) => {
    it(`preserves ${host} for live and late quick-action consumers only`, () => {
      const quick: AppUriQuickAction[] = [];
      const lateQuick: AppUriQuickAction[] = [];
      const tasks = jasmine.createSpy('task sink');
      const oauth = jasmine.createSpy('OAuth sink');
      taskSink.subscribe(tasks);
      oauthSink.subscribe(oauth);
      quickSink.subscribe((value) => quick.push(value));

      expect(route(`com.super-productivity.app://${host}`)).toBe('quick-action');
      quickSink.subscribe((value) => lateQuick.push(value));

      expect(quick).toEqual([action]);
      expect(lateQuick).toEqual([action]);
      expect(tasks).not.toHaveBeenCalled();
      expect(oauth).not.toHaveBeenCalled();
    });
  });

  [
    'com.super-productivity.app://oauth-callback?code=ABC123&provider=dropbox',
    'superproductivity://oauth-callback?code=ABC123',
    'com.super-productivity.app://plugin-oauth-callback?code=ABC123&state=opaque',
  ].forEach((url) => {
    it(`preserves the OAuth consumer for ${new URL(url).hostname}`, () => {
      const oauth: string[] = [];
      const tasks = jasmine.createSpy('task sink');
      const quick = jasmine.createSpy('quick sink');
      oauthSink.subscribe((value) => oauth.push(value));
      taskSink.subscribe(tasks);
      quickSink.subscribe(quick);

      expect(route(url)).toBe('other');

      expect(oauth).toEqual([url]);
      expect(tasks).not.toHaveBeenCalled();
      expect(quick).not.toHaveBeenCalled();
    });
  });

  it('keeps quick actions and OAuth usable after absorbing blocked URLs', () => {
    const oauth: string[] = [];
    const tasks = jasmine.createSpy('task sink');
    oauthSink.subscribe((value) => oauth.push(value));
    taskSink.subscribe(tasks);
    route('superproductivity://create-task?title=private');
    route('superproductivity://task-toggle-start');
    route('superproductivity://inbox');
    const oauthUrl = 'superproductivity://oauth-callback?code=ABC123';
    route(oauthUrl);

    const quick: AppUriQuickAction[] = [];
    quickSink.subscribe((value) => quick.push(value));
    expect(quick).toEqual([{ type: 'navigate', target: 'inbox' }]);
    expect(oauth).toEqual([oauthUrl]);
    expect(tasks).not.toHaveBeenCalled();
  });
});
