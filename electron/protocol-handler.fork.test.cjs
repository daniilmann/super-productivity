const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

require('ts-node/register/transpile-only');

const protocolHandlerPath = path.resolve(__dirname, 'protocol-handler.ts');
const originalModuleLoad = Module._load;
let isAppReady;
let logCalls;
let focusCalls;
let toggleCalls;

// Exercise the real protocol module; only its Electron environment is replaced.
const loadModule = () => {
  delete require.cache[protocolHandlerPath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { App: class {}, BrowserWindow: class {} };
    }
    if (request === 'electron-log/main') {
      return { log: (...args) => logCalls.push(args) };
    }
    if (request === './main-window') {
      return { getIsAppReady: () => isAppReady };
    }
    if (request === './various-shared') {
      return {
        showOrFocus: (win) => focusCalls.push(win),
        toggleWindowVisibility: (win) => toggleCalls.push(win),
      };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  try {
    return require(protocolHandlerPath);
  } finally {
    Module._load = originalModuleLoad;
  }
};

const makeWin = () => {
  const sent = [];
  return {
    sent,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
};

const makeApp = () => {
  const handlers = {};
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  return {
    handlers,
    setAsDefaultProtocolClient: () => {},
    on: (event, handler) => {
      handlers[event] = handler;
    },
    whenReady: () => ready,
    resolveReady,
  };
};

const initialize = (mod, app, getWin, urls = []) => {
  const previousArgv = process.argv;
  process.argv = [process.execPath, '/path/to/app', ...urls];
  try {
    mod.initializeProtocolHandling(false, app, getWin);
  } finally {
    process.argv = previousArgv;
  }
};

test.beforeEach(() => {
  isAppReady = true;
  logCalls = [];
  focusCalls = [];
  toggleCalls = [];
});

const BLOCKED_HOSTS = [
  'create-task',
  'CrEaTe-TaSk',
  'complete-task',
  'CoMpLeTe-TaSk',
  'task-toggle-start',
  'TaSk-ToGgLe-StArT',
];
const SUFFIXES = [
  '',
  '?title=',
  '?title=%20',
  '/Private%20Title?title=Query%20Title&notes=Private%20Notes&projectId=proj%2F1',
  '?title=%D0%97%D0%B0%D0%B4%D0%B0%D1%87%D0%B0%20%F0%9F%8C%BF&notes=2%25%20fat&projectId=proj%2F1',
];

BLOCKED_HOSTS.forEach((host) => {
  SUFFIXES.forEach((suffix, index) => {
    test(`fork blocks direct ${host} URL form ${index} without IPC`, () => {
      const { processProtocolUrl } = loadModule();
      const win = makeWin();

      assert.doesNotThrow(() =>
        processProtocolUrl(`superproductivity://${host}${suffix}`, win),
      );

      assert.deepEqual(win.sent, []);
      assert.deepEqual(focusCalls, []);
      assert.deepEqual(toggleCalls, []);
    });
  });

  test(`fork blocks ${host} from second-instance`, () => {
    const mod = loadModule();
    const app = makeApp();
    const win = makeWin();
    initialize(mod, app, () => win);

    app.handlers['second-instance']({}, [
      '/path/to/app',
      `superproductivity://${host}?title=Private%20Title&notes=Private%20Notes`,
    ]);
    mod.processPendingProtocolUrls(win);

    assert.deepEqual(win.sent, []);
    assert.deepEqual(toggleCalls, []);
  });

  test(`fork blocks ${host} from open-url`, () => {
    const mod = loadModule();
    const app = makeApp();
    const win = makeWin();
    initialize(mod, app, () => win);
    let prevented = 0;

    app.handlers['open-url'](
      { preventDefault: () => prevented++ },
      `superproductivity://${host}/Private%20Title?title=Private%20Title`,
    );

    assert.equal(prevented, 1, 'the real macOS listener handled the event');
    assert.deepEqual(win.sent, []);
  });

  test(`fork blocks cold-launch ${host} through whenReady and repeated queue drains`, async () => {
    const mod = loadModule();
    const app = makeApp();
    const win = makeWin();
    isAppReady = false;
    initialize(mod, app, () => win, [
      `superproductivity://${host}?title=Private%20Title&notes=Private%20Notes`,
    ]);

    app.resolveReady();
    await Promise.resolve();
    assert.deepEqual(win.sent, [], 'renderer has not signalled APP_READY');
    mod.processPendingProtocolUrls(win);
    assert.deepEqual(win.sent, []);
    isAppReady = true;
    mod.processPendingProtocolUrls(win);
    mod.processPendingProtocolUrls(win);

    assert.deepEqual(win.sent, [], 'a queued task action must never escape on drain');
    assert.deepEqual(toggleCalls, []);
  });
});

test('fork drains a mixed queue without losing or duplicating permitted UI and OAuth', () => {
  const mod = loadModule();
  const win = makeWin();
  const oauth = 'superproductivity://oauth-callback?code=SecretCode&state=SecretState';
  const urls = [
    'superproductivity://create-task?title=Private%20Title',
    'superproductivity://add-task',
    'superproductivity://complete-task?title=Private%20Title',
    'superproductivity://today',
    'superproductivity://task-toggle-start',
    oauth,
    'superproductivity://inbox',
  ];
  // No BrowserWindow yet: these are genuine pendingUrls, not mocked callbacks.
  urls.forEach((url) => mod.processProtocolUrl(url, null));
  assert.deepEqual(win.sent, []);
  isAppReady = false;
  mod.processPendingProtocolUrls(win);
  assert.deepEqual(win.sent, []);
  isAppReady = true;
  mod.processPendingProtocolUrls(win);
  const expected = [
    { channel: 'SHOW_ADD_TASK_BAR', payload: undefined },
    { channel: 'APP_URI_QUICK_ACTION', payload: 'superproductivity://today' },
    { channel: 'OAUTH_CALLBACK', payload: { url: oauth } },
    { channel: 'APP_URI_QUICK_ACTION', payload: 'superproductivity://inbox' },
  ];
  assert.deepEqual(win.sent, expected);
  mod.processPendingProtocolUrls(win);
  assert.deepEqual(win.sent, expected, 'draining again must not duplicate allowed actions');
});

test('fork preserves add-note, mixed-case navigation, visibility, connect and OAuth', () => {
  const { processProtocolUrl } = loadModule();
  const win = makeWin();
  const oauth = 'superproductivity://oauth-callback?code=SecretCode&state=SecretState';
  [
    'superproductivity://add-task',
    'superproductivity://add-note',
    'superproductivity://Today',
    'superproductivity://Inbox',
    'superproductivity://toggle-visibility',
    'superproductivity://plainspace-connect',
    oauth,
  ].forEach((url) => processProtocolUrl(url, win));

  assert.deepEqual(win.sent, [
    { channel: 'SHOW_ADD_TASK_BAR', payload: undefined },
    { channel: 'ADD_NOTE', payload: undefined },
    { channel: 'APP_URI_QUICK_ACTION', payload: 'superproductivity://Today' },
    { channel: 'APP_URI_QUICK_ACTION', payload: 'superproductivity://Inbox' },
    { channel: 'OAUTH_CALLBACK', payload: { url: oauth } },
  ]);
  assert.equal(focusCalls.length, 6);
  assert.deepEqual(toggleCalls, [win]);
});

test('fork keeps title, notes and OAuth credentials out of logs on every launch path', async () => {
  const mod = loadModule();
  const app = makeApp();
  const win = makeWin();
  const title = 'SecretTitleMarker';
  const notes = 'SecretNotesMarker';
  const code = 'SecretCodeMarker';
  const state = 'SecretStateMarker';
  const taskUrl = `superproductivity://create-task/${title}?notes=${notes}`;
  const oauthUrl = `superproductivity://oauth-callback?code=${code}&state=${state}`;
  isAppReady = false;
  initialize(mod, app, () => win, [taskUrl, oauthUrl]);
  app.resolveReady();
  await Promise.resolve();
  app.handlers['second-instance']({}, ['/path/to/app', taskUrl, oauthUrl]);
  [taskUrl, oauthUrl].forEach((url) => {
    app.handlers['open-url']({ preventDefault: () => {} }, url);
    mod.processProtocolUrl(url, win);
  });
  // Preserve the old malformed-authority privacy regression too.
  mod.processProtocolUrl(`superproductivity://ho st/?title=${title}&notes=${notes}`, win);
  isAppReady = true;
  mod.processPendingProtocolUrls(win);

  const logged = JSON.stringify(logCalls);
  [title, notes, code, state].forEach((secret) => {
    assert.ok(!logged.includes(secret), `${secret} must not reach the exportable log`);
  });
  assert.ok(win.sent.some((event) => event.channel === 'OAUTH_CALLBACK'));
  assert.ok(win.sent.every((event) => event.channel === 'OAUTH_CALLBACK'));
});
