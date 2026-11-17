import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { Observable, ReplaySubject, shareReplay, take } from 'rxjs';
import { DataInitStateService } from '../../../core/data-init/data-init-state.service';
import { SnackService } from '../../../core/snack/snack.service';
import { ProjectService } from '../../project/project.service';
import { selectAllTasksInActiveProjects } from '../store/task.selectors';
import { Task } from '../task.model';
import { TaskService } from '../task.service';
import { AppUriTaskAction } from '../util/parse-app-uri-task-action';
import { AppUriTaskActionsService } from './app-uri-task-actions.service';
import { PENDING_CAPACITOR_APP_URI_ACTION } from './pending-capacitor-app-uri-action';

describe('Fork task URI policy: common consumer', () => {
  let service: AppUriTaskActionsService | undefined;
  let pending$: ReplaySubject<AppUriTaskAction>;
  let loaded$: ReplaySubject<boolean>;
  let taskService: jasmine.SpyObj<TaskService>;
  let snack: jasmine.SpyObj<SnackService>;
  let store: MockStore;
  let dispatch: jasmine.Spy;
  let select: jasmine.Spy;
  let subscribePending: jasmine.Spy;
  let subscribeHydration: jasmine.Spy;

  const markup = '<img src=https://example.com/pixel>&';
  const tasks: Task[] = [
    { id: 'milk', title: 'Buy milk', isDone: false } as Task,
    { id: 'done', title: 'Already done milk run', isDone: true } as Task,
    {
      id: 'sub',
      title: 'Subtask milk errand',
      isDone: false,
      parentId: 'milk',
    } as Task,
    { id: 'standup', title: 'Standup', isDone: false } as Task,
    { id: 'notes', title: 'Standup notes', isDone: false } as Task,
    { id: 'bob1', title: 'Email Bob', isDone: false } as Task,
    { id: 'bob2', title: 'Call Bob', isDone: false } as Task,
    { id: 'markup', title: markup, isDone: false } as Task,
    { id: 'long', title: 'a'.repeat(301), isDone: false } as Task,
  ];

  beforeEach(() => {
    service = undefined;
    pending$ = new ReplaySubject<AppUriTaskAction>(1);
    loaded$ = new ReplaySubject<boolean>(1);
    taskService = jasmine.createSpyObj('TaskService', ['add', 'setDone']);
    taskService.add.and.returnValue('created-task');
    snack = jasmine.createSpyObj('SnackService', ['open']);
    subscribePending = jasmine.createSpy('pending action subscription');
    subscribeHydration = jasmine.createSpy('hydration subscription');
    // Match DataInitStateService's one-shot replay contract: late consumers
    // see the completed initial hydration, never repeated hydration events.
    const initiallyLoaded$ = loaded$.pipe(take(1), shareReplay(1));

    TestBed.configureTestingModule({
      providers: [
        AppUriTaskActionsService,
        provideMockStore({
          selectors: [{ selector: selectAllTasksInActiveProjects, value: tasks }],
        }),
        { provide: TaskService, useValue: taskService },
        { provide: SnackService, useValue: snack },
        { provide: ProjectService, useValue: { list: () => [{ id: 'proj-1' }] } },
        {
          provide: PENDING_CAPACITOR_APP_URI_ACTION,
          useValue: new Observable<AppUriTaskAction>((subscriber) => {
            subscribePending();
            return pending$.subscribe(subscriber);
          }),
        },
        {
          provide: DataInitStateService,
          useValue: {
            isAllDataLoadedInitially$: new Observable<boolean>((subscriber) => {
              subscribeHydration();
              return initiallyLoaded$.subscribe(subscriber);
            }),
          },
        },
      ],
    });
    store = TestBed.inject(MockStore);
    dispatch = spyOn(store, 'dispatch');
    select = spyOn(store, 'select').and.callThrough();
  });

  afterEach(() => {
    service?.ngOnDestroy();
    pending$.complete();
    loaded$.complete();
    store.resetSelectors();
  });

  const createService = (): void => {
    service = TestBed.inject(AppUriTaskActionsService);
  };

  const expectNoEffects = (): void => {
    expect(taskService.add).not.toHaveBeenCalled();
    expect(taskService.setDone).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(snack.open).not.toHaveBeenCalled();
  };

  const validActions: AppUriTaskAction[] = [
    { type: 'add', title: 'Buy milk', notes: 'whole milk', projectId: 'proj-1' },
    { type: 'complete', title: 'Buy milk' },
  ];
  validActions.forEach((action) => {
    it(`ignores a buffered ${action.type} received before service creation`, () => {
      pending$.next(action);
      createService();
      expectNoEffects();
      loaded$.next(true);
      expectNoEffects();
    });

    it(`ignores ${action.type} before hydration without deferring a write`, () => {
      createService();
      pending$.next(action);
      expectNoEffects();
      loaded$.next(true);
      expectNoEffects();
    });

    it(`ignores repeated ${action.type} after hydration`, () => {
      createService();
      loaded$.next(true);
      pending$.next(action);
      pending$.next(action);
      expectNoEffects();
    });

    it(`ignores a buffered ${action.type} when service starts after hydration`, () => {
      pending$.next(action);
      loaded$.next(true);
      createService();
      expectNoEffects();
    });
  });

  const rejectedInputs: { label: string; action: AppUriTaskAction }[] = [
    { label: 'empty add title', action: { type: 'add', title: '' } },
    { label: 'whitespace add title', action: { type: 'add', title: '   ' } },
    { label: 'padded add title', action: { type: 'add', title: ' Buy milk ' } },
    { label: '300 character title', action: { type: 'add', title: 'a'.repeat(300) } },
    { label: '301 character title', action: { type: 'add', title: 'a'.repeat(301) } },
    {
      label: 'oversized notes',
      action: { type: 'add', title: 'Buy milk', notes: 'a'.repeat(100_001) },
    },
    {
      label: 'unknown project',
      action: { type: 'add', title: 'Buy milk', projectId: 'missing' },
    },
    { label: 'HTML add title', action: { type: 'add', title: markup } },
    {
      label: 'HTML title with missing project',
      action: { type: 'add', title: markup, projectId: 'missing' },
    },
    {
      label: 'literal short syntax',
      action: { type: 'add', title: 'Задача 🌿 +project #tag @today' },
    },
    { label: 'empty completion', action: { type: 'complete', title: '' } },
    { label: 'whitespace completion', action: { type: 'complete', title: '   ' } },
    { label: 'no match', action: { type: 'complete', title: 'nonexistent' } },
    { label: 'ambiguous match', action: { type: 'complete', title: 'bob' } },
    {
      label: 'exact match among substring matches',
      action: { type: 'complete', title: 'Standup' },
    },
    { label: 'subtask match', action: { type: 'complete', title: 'errand' } },
    {
      label: 'already done match',
      action: { type: 'complete', title: 'Already done milk run' },
    },
    { label: 'HTML completion', action: { type: 'complete', title: markup } },
    {
      label: '301 character completion',
      action: { type: 'complete', title: 'a'.repeat(301) },
    },
    {
      label: 'oversized lookup',
      action: { type: 'complete', title: 'a'.repeat(100_001) },
    },
  ];
  rejectedInputs.forEach(({ label, action }) => {
    it(`silently ignores ${label} without validation snacks or task writes`, () => {
      loaded$.next(true);
      createService();
      pending$.next(action);
      expectNoEffects();
    });
  });

  it('does not subscribe to either the pending stream or hydration', () => {
    createService();
    validActions.forEach((action) => pending$.next(action));
    loaded$.next(true);
    expect(subscribePending).not.toHaveBeenCalled();
    expect(subscribeHydration).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('has no delayed write when destroyed before hydration', fakeAsync(() => {
    createService();
    validActions.forEach((action) => pending$.next(action));
    service!.ngOnDestroy();
    loaded$.next(true);
    validActions.forEach((action) => pending$.next(action));
    tick(60_000);
    expectNoEffects();
  }));
});
