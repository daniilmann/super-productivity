import { TestBed } from '@angular/core/testing';
import { MockStore } from '@ngrx/store/testing';
import { PluginIframeMessageType } from '@super-productivity/plugin-api';
import { openDB } from 'idb';
import { LOCK_NAMES } from '../../op-log/core/operation-log.const';
import {
  DB_NAME,
  DB_VERSION,
  SINGLETON_KEY,
  STORE_NAMES,
} from '../../op-log/persistence/db-keys.const';
import { MAX_PLUGIN_PERSISTENCE_KEY_LENGTH } from './plugin-persistence-key.util';
import {
  CALLER,
  CLIENT,
  KEY,
  METHOD,
  NEXT,
  OTHER,
  OWN_KEY,
  bootIframe,
  config,
  deferred,
  event,
  expectReply,
  manifest,
  mountPlugin,
  readIframeSaveRequests,
  replaceIframeDocument,
  rpc,
  saved,
} from './testing/plugin-iframe-save-confirmation.fixtures.fork.spec';
import { createPluginApiScript, handlePluginMessage } from './plugin-iframe.util';

const UNKNOWN = { state: 'unknown' } as const;

describe('iframe save confirmation', () => {
  let fixture: Awaited<ReturnType<typeof bootIframe>>;
  let mounted: Awaited<ReturnType<typeof mountPlugin>> | undefined;
  let generation: number;

  beforeEach(async () => {
    generation = 0;
    fixture = await bootIframe(() => generation);
  });

  afterEach(() => {
    mounted?.destroy();
    mounted = undefined;
  });

  const mount = async (): ReturnType<typeof mountPlugin> => {
    mounted = await mountPlugin();
    return mounted;
  };

  it('binds save confirmation requests to their originating srcdoc', async () => {
    const bridge = config();
    const script = createPluginApiScript(bridge);
    const [first, second] = await Promise.all([
      readIframeSaveRequests(script),
      readIframeSaveRequests(script),
    ]);

    expect(first.document).not.toBe(second.document);
    const requests = [...first.requests, ...second.requests];
    for (const request of requests) {
      expect(request).toEqual(
        jasmine.objectContaining({
          args: [[]],
          bridgeToken: bridge.bridgeToken,
          bridgeGeneration: bridge.bridgeGeneration,
        }),
      );
    }
    const bindings = requests.map(({ documentBinding }) => documentBinding);
    if (!bindings.every((binding) => typeof binding === 'string' && binding.trim())) {
      throw new Error(
        `Expected a non-empty documentBinding in each iframe request, got ${bindings.map((binding) => typeof binding).join(', ')}`,
      );
    }
    const [firstBinding, firstRepeat, secondBinding, secondRepeat] = bindings;
    expect(firstRepeat).toBe(firstBinding);
    expect(secondRepeat).toBe(secondBinding);
    expect(secondBinding).not.toBe(firstBinding);
  }, 5000);

  it('routes only the caller keys through the read method', async () => {
    await fixture.acknowledge(OTHER, KEY);
    await fixture.acknowledge(CALLER, OWN_KEY);
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
      await fixture.acknowledge(CALLER, KEY);
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
      await fixture.acknowledge(CALLER, KEY);
      const post: jasmine.Spy = spyOn(window, 'postMessage');
      const committed = deferred();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const request = fixture.lock.request.bind(fixture.lock);
      let requests = 0;
      let rotation: Promise<void> | undefined;

      if (point === 'while hashing') {
        spyOn(crypto.subtle, 'digest').and.callFake(async (algorithm, bytes) => {
          rotation ??= fixture.rotate();
          await rotation;
          committed.resolve();
          return digest(algorithm, bytes);
        });
      } else {
        spyOn(fixture.lock, 'request').and.callFake(
          async <T>(name: string, run: () => Promise<T>) => {
            if (name === LOCK_NAMES.OPERATION_LOG && ++requests === 2) {
              // Submit rotation first, then the actual second lock request.
              rotation = fixture.rotate().then(() => {
                committed.resolve();
              });
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
      expect(await fixture.client.loadClientId()).toBe(CLIENT);
      expect(await fixture.otherTab.loadClientId()).toBe(NEXT);
      expectReply(post, { [KEY]: UNKNOWN });
    });
  }

  it('serializes the live recipient check and postMessage with competing client rotation', async () => {
    await fixture.acknowledge(CALLER, KEY);
    const view = await mount();
    const request = fixture.lock.request.bind(fixture.lock);
    let acquisitions = 0;
    let held = 0;
    let rotation: Promise<void> | undefined;
    const trace: string[] = [];
    spyOn(fixture.lock, 'request').and.callFake(
      <T>(name: string, run: () => Promise<T>, timeout?: number) => {
        if (name !== LOCK_NAMES.OPERATION_LOG) {
          return request(name, run, timeout);
        }
        return request(
          name,
          async () => {
            held = ++acquisitions;
            try {
              return await run();
            } finally {
              held = 0;
            }
          },
          timeout,
        );
      },
    );
    const get = Reflect.get(IDBObjectStore.prototype, 'get');
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
            rotation = fixture.rotate().then(() => {
              trace.push('rotation committed');
            });
          },
          { once: true },
        );
      }
      return result;
    });
    fixture.recipientGeneration.and.callFake(() => {
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
    expect(await fixture.otherTab.loadClientId()).toBe(NEXT);
    expect(await fixture.client.loadClientId()).toBe(CLIENT);
  });

  for (const fault of ['missing ID', 'ID read failure', 'second lock timeout'] as const) {
    it(`sends the appropriate reply after ${fault}`, async () => {
      await fixture.acknowledge(CALLER, KEY);
      const post: jasmine.Spy = spyOn(window, 'postMessage');
      const db = await openDB(DB_NAME, DB_VERSION);
      const request = fixture.lock.request.bind(fixture.lock);
      const gate = deferred();
      let acquisitions = 0;
      let failRead = false;
      let blocking: Promise<void> | undefined;
      const get = Reflect.get(IDBObjectStore.prototype, 'get');
      spyOn(IDBObjectStore.prototype, 'get').and.callFake(function (
        this: IDBObjectStore,
        key,
      ) {
        if (this.name === STORE_NAMES.CLIENT_ID && failRead) {
          throw new DOMException('synthetic read failure', 'UnknownError');
        }
        return get.call(this, key);
      });
      spyOn(fixture.lock, 'request').and.callFake(
        <T>(name: string, run: () => Promise<T>) => {
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
        },
      );
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
    'navigate iframe in the same window',
    'switch plugin in the same window',
    'close iframe',
    'change generation',
  ] as const) {
    for (const outcome of ['reply', 'error'] as const) {
      it(`drops the old ${outcome} when the view can ${invalidation}`, async () => {
        await fixture.acknowledge(CALLER, KEY);
        const view = await mount();
        const navigates = invalidation === 'navigate iframe in the same window';
        let post = navigates ? undefined : spyOn(view.source, 'postMessage');
        const beforeSecond = deferred();
        const resume = deferred();
        const request = fixture.lock.request.bind(fixture.lock);
        let requests = 0;
        let blocking: Promise<void> | undefined;
        const release = deferred();
        spyOn(fixture.lock, 'request').and.callFake(
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
          if (navigates) {
            const frame = view.findFrame();
            if (!frame) {
              throw new Error('Plugin iframe is missing before navigation');
            }
            const original = frame.contentDocument;
            await replaceIframeDocument(frame);
            expect(view.findFrame()).toBe(frame);
            expect(frame.contentWindow).toBe(view.source);
            expect(frame.contentDocument).not.toBe(original);
            post = spyOn(view.source, 'postMessage');
          } else if (invalidation === 'switch plugin in the same window') {
            view.component['_cleanupIframeCommunication']();
            view.component.pluginId.set(OTHER);
            await view.component['_loadPluginIndex'](OTHER);
            expect(view.findFrame()?.contentWindow).toBe(view.source);
          } else if (invalidation === 'close iframe') {
            view.destroy();
            mounted = undefined;
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
        expect(post?.calls.allArgs()).toEqual([]);
      });
    }
  }
});
