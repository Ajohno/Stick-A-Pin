const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadFrontend({ pathname = "/focus-page.html", elements = {}, fetchImpl, BroadcastChannel } = {}) {
  const redirects = [];
  const toasts = [];
  const consoleErrors = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = [];
  function listen(listeners, type, callback) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  }
  const document = {
    visibilityState: "visible",
    body: { classList: { contains: () => false } },
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, callback) => listen(documentListeners, type, callback),
    dispatchEvent: () => {},
  };
  const location = {
    pathname,
    search: "",
    origin: "https://stickapin.test",
    replace: (value) => redirects.push(value),
  };
  const context = vm.createContext({
    console: { ...console, error: (...args) => consoleErrors.push(args) },
    document,
    window: {
      location,
      BroadcastChannel,
      addEventListener: (type, callback) => listen(windowListeners, type, callback),
      clearInterval: () => {},
      clearTimeout: () => {},
      setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
      setTimeout: () => 1,
    },
    location,
    URL,
    URLSearchParams,
    Headers,
    fetch: fetchImpl || (async () => { throw new Error("Unexpected fetch"); }),
    Toast: { show: (toast) => toasts.push(toast) },
    DurationUtils: require("../public/js/duration-utils"),
    setInterval: () => 1,
    clearInterval: () => {},
    CustomEvent: class CustomEvent {},
  });
  const source = `${fs.readFileSync("public/js/main.js", "utf8")}
    globalThis.frontendTestApi = {
      selectFilterForFocusedTask,
      stopFocusSession,
      toggleFocusPauseState,
      initFocusMode,
      initFocusSessionSync,
      requestFocusRefresh,
      focusSync,
      focusState,
      checkAuthStatus,
      callApiFetch(...args) { return apiFetch(...args); },
      getSafeNextPath,
      setApiFetch(value) { apiFetch = value; },
      resetAuthPromise() { authStatusPromise = null; },
      disableNavRefresh() { updateNavTaskCounter = () => {}; },
      disableTaskRendering() { updateFocusTaskOptions = () => {}; },
    };`;
  vm.runInContext(source, context);
  return {
    api: context.frontendTestApi, redirects, toasts, consoleErrors, document, intervals,
    fireDocument(type) { for (const callback of documentListeners.get(type) || []) callback({}); },
    fireWindow(type) { for (const callback of windowListeners.get(type) || []) callback({}); },
  };
}

function jsonResponse(status, payload = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("restored filters retain matching filters and reveal non-Big-3 tasks", () => {
  const { api } = loadFrontend();
  const tasks = [
    { _id: "big", status: "active", isBigThree: true, effortLevel: 3 },
    { _id: "list", status: "active", isBigThree: false, effortLevel: 2 },
  ];
  assert.equal(api.selectFilterForFocusedTask(tasks, "big-three", "list"), "task-list");
  assert.equal(api.selectFilterForFocusedTask(tasks, "big-three", "big"), "big-three");
  assert.equal(api.selectFilterForFocusedTask(tasks, "effort", "list"), "effort");
  assert.equal(api.selectFilterForFocusedTask(tasks, "task-list", "list"), "task-list");
});

test("stop acknowledges pending state, prevents duplicates, then confirms before log refresh", async () => {
  const status = { textContent: "Focus session resumed." };
  const timer = { textContent: "00:12", isConnected: true };
  const { api, toasts } = loadFrontend({
    elements: { "focus-status": status, focusTimer: timer },
  });
  api.focusState.taskId = "task";
  api.focusState.startedAt = Date.now();
  api.focusState.allTasks = [{ _id: "task", status: "active" }];
  let resolveStop;
  let requests = 0;
  api.setApiFetch(() => {
    requests += 1;
    return new Promise((resolve) => { resolveStop = resolve; });
  });

  const firstStop = api.stopFocusSession();
  const duplicateStop = await api.stopFocusSession();
  assert.equal(status.textContent, "Stopping focus session…");
  assert.equal(duplicateStop, false);
  assert.equal(requests, 1);

  resolveStop({ ok: true, status: 200 });
  assert.equal(await firstStop, true);
  assert.equal(status.textContent, "Focus session stopped.");
  assert.equal(timer.textContent, "00:00");
  assert.equal(toasts.at(-1).type, "success");
});

test("a stale Stop conflict clears local state after another tab ended the session", async () => {
  const status = { textContent: "Focused on: task" };
  const timer = { textContent: "02:34", isConnected: true };
  const { api, toasts, consoleErrors } = loadFrontend({
    elements: { "focus-status": status, focusTimer: timer },
  });
  api.focusState.taskId = "task";
  api.focusState.startedAt = Date.now();
  api.focusState.allTasks = [{ _id: "task", status: "active" }];

  const requests = [];
  api.setApiFetch(async (url) => {
    requests.push(url);
    if (url === "/focus-sessions/stop") {
      return jsonResponse(409, { error: "Focus session is no longer active." });
    }
    if (url === "/focus-sessions/active") return jsonResponse(204);
    throw new Error(`Unexpected request: ${url}`);
  });

  assert.equal(await api.stopFocusSession(), true);
  assert.deepEqual(requests, [
    "/focus-sessions/stop",
    "/focus-sessions/active",
  ]);
  assert.equal(api.focusState.taskId, null);
  assert.equal(timer.textContent, "00:00");
  assert.equal(status.textContent, "Focus session ended in another tab.");
  assert.equal(toasts.at(-1).type, "info");
  assert.equal(consoleErrors.length, 0);
});

test("a Pause conflict reconciles an already-ended session without console noise", async () => {
  const status = { textContent: "Focused on: task" };
  const timer = { textContent: "00:17", isConnected: true };
  const { api, toasts, consoleErrors } = loadFrontend({
    elements: { "focus-status": status, focusTimer: timer },
  });
  api.focusState.taskId = "task";
  api.focusState.startedAt = Date.now();
  api.focusState.allTasks = [{ _id: "task", status: "active" }];

  const requests = [];
  api.setApiFetch(async (url) => {
    requests.push(url);
    if (url === "/focus-sessions/pause") {
      return jsonResponse(409, { error: "Focus session is no longer active." });
    }
    if (url === "/focus-sessions/active") return jsonResponse(204);
    throw new Error(`Unexpected request: ${url}`);
  });

  assert.equal(await api.toggleFocusPauseState(status), false);
  assert.deepEqual(requests, [
    "/focus-sessions/pause",
    "/focus-sessions/active",
  ]);
  assert.equal(api.focusState.taskId, null);
  assert.equal(timer.textContent, "00:00");
  assert.equal(status.textContent, "Focus session ended in another tab.");
  assert.equal(toasts.at(-1).type, "info");
  assert.equal(consoleErrors.length, 0);
});

test("focus controls start disabled until active-session restoration completes", () => {
  const html = fs.readFileSync("public/focus-page.html", "utf8");
  const disabledButtons = [
    "focusStartBtn",
    "focusTabBigThree",
    "focusTabTaskList",
    "focusTabEffort",
  ];

  disabledButtons.forEach((id) => {
    assert.match(
      html,
      new RegExp(`<button(?=[^>]*id="${id}")(?=[^>]*disabled)[^>]*>`),
    );
  });
  assert.match(
    html,
    /<select(?=[^>]*id="focusTaskSelect")(?=[^>]*disabled)[^>]*>/,
  );
  assert.match(
    html,
    /<ul(?=[^>]*id="focusTaskList")(?=[^>]*aria-disabled="true")[^>]*>/,
  );
});

test("a Focus Log refresh failure cannot restore a successfully stopped session", async () => {
  const status = { textContent: "Focused on: task" };
  const timer = { textContent: "00:12", isConnected: true };
  const log = { innerHTML: "" };
  const { api, consoleErrors } = loadFrontend({
    elements: { "focus-status": status, focusTimer: timer, "focus-log-body": log },
  });
  api.focusState.taskId = "task";
  api.focusState.startedAt = Date.now();
  api.focusState.allTasks = [{ _id: "task", status: "active" }];
  let requests = 0;
  api.setApiFetch(async () => {
    requests += 1;
    if (requests === 1) return { ok: true, status: 200 };
    throw new Error("log unavailable");
  });
  assert.equal(await api.stopFocusSession(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.focusState.taskId, null);
  assert.equal(status.textContent, "Focus session stopped.");
  assert.match(log.innerHTML, /Could not load/);
  assert.equal(consoleErrors.length, 1);
});

test("authentication gate redirects signed-out protected pages once", async () => {
  const { api, redirects } = loadFrontend({ pathname: "/dashboard.html" });
  api.setApiFetch(async () => ({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ loggedIn: false }),
  }));
  assert.equal(await api.checkAuthStatus({ isProtectedPage: true }), false);
  assert.equal(await api.checkAuthStatus({ isProtectedPage: true }), false);
  assert.equal(redirects.length, 1);
  assert.match(redirects[0], /^\/login\.html\?next=/);
});

test("authentication gate continues for users and preserves genuine failures", async () => {
  const { api, redirects, consoleErrors } = loadFrontend({ pathname: "/settings-page.html" });
  api.disableNavRefresh();
  api.setApiFetch(async () => ({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ loggedIn: true, user: { firstName: "Ada" } }),
  }));
  assert.equal(await api.checkAuthStatus({ isProtectedPage: true }), true);
  assert.equal(redirects.length, 0);

  api.setApiFetch(async () => { throw new Error("network unavailable"); });
  api.resetAuthPromise();
  assert.equal(await api.checkAuthStatus({ isProtectedPage: true }), null);
  assert.equal(redirects.length, 0);
  assert.equal(consoleErrors.length, 1);
});

test("expired protected API calls redirect once without a caller error storm", async () => {
  const unauthorized = {
    status: 401,
    ok: false,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ error: "Unauthorized" }),
  };
  const { api, redirects } = loadFrontend({
    pathname: "/calendar-page.html",
    fetchImpl: async () => unauthorized,
  });
  void api.callApiFetch("/tasks");
  void api.callApiFetch("/settings/board-preferences");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(redirects.length, 1);
});

test("public pages avoid redirect loops and next paths stay same-origin", async () => {
  const unauthorized = {
    status: 401,
    ok: false,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ error: "Unauthorized" }),
  };
  const { api, redirects } = loadFrontend({
    pathname: "/login.html",
    fetchImpl: async () => unauthorized,
  });
  const response = await api.callApiFetch("/auth-status");
  assert.equal(response.status, 401);
  assert.equal(redirects.length, 0);
  assert.equal(api.getSafeNextPath("/focus-page.html?mode=resume"), "/focus-page.html?mode=resume");
  assert.equal(api.getSafeNextPath("//evil.example/path"), null);
  assert.equal(api.getSafeNextPath("https://evil.example/path"), null);
  assert.equal(api.getSafeNextPath("/login.html"), null);
});

function createFocusTab(BroadcastChannel) {
  const button = () => ({
    setAttribute() {},
    addEventListener(type, callback) { this[type] = callback; },
  });
  const elements = {
    "focus-status": { textContent: "" },
    focusTimer: { textContent: "00:00", isConnected: true },
    focusTaskSelect: { ...button(), value: "task", options: [{ text: "Test task" }], selectedIndex: 0 },
    focusStartBtn: button(), focusStopBtn: button(), focusPauseBtn: button(),
    focusCompleteBtn: button(), focusPiPToggleBtn: button(),
  };
  const tab = loadFrontend({ elements, BroadcastChannel });
  tab.api.disableTaskRendering();
  tab.api.initFocusSessionSync();
  return { ...tab, elements };
}

function activeSession(overrides = {}) {
  return {
    _id: "session", taskId: "task", taskDescription: "Test task",
    startedAt: "2026-10-02T18:00:00.000Z", pausedAt: null,
    totalPausedMs: 0, serverNow: "2026-10-02T18:01:00.000Z", ...overrides,
  };
}

function installSessionReads(tab, sessionReader, requests = []) {
  tab.api.setApiFetch(async (url) => {
    requests.push(url);
    if (url === "/focus-sessions/active") {
      const session = await sessionReader();
      return session ? jsonResponse(200, session) : jsonResponse(204);
    }
    if (url === "/tasks") return jsonResponse(200, [{ _id: "task", status: "active" }]);
    throw new Error(`Unexpected request: ${url}`);
  });
}

function createTabMessaging() {
  const channels = [];
  const messages = [];
  class BroadcastChannel {
    constructor(name) { this.name = name; channels.push(this); }
    addEventListener(type, callback) { if (type === "message") this.receive = callback; }
    postMessage(data) {
      messages.push(data);
      for (const peer of channels) {
        if (peer !== this && peer.name === this.name) peer.receive({ data });
      }
    }
  }
  return { BroadcastChannel, channels, messages };
}

async function settleRefresh(tab) {
  if (tab.api.focusSync.refreshPromise) await tab.api.focusSync.refreshPromise;
  await new Promise((resolve) => setImmediate(resolve));
}

test("returning to Focus restores paused server time and clears a remotely stopped timer", async () => {
  const tab = createFocusTab();
  let session = activeSession({ pausedAt: "2026-10-02T18:00:30.000Z" });
  const requests = [];
  installSessionReads(tab, () => session, requests);
  tab.document.visibilityState = "hidden";
  tab.fireDocument("visibilitychange");
  assert.equal(requests.length, 0);
  tab.document.visibilityState = "visible";
  tab.fireDocument("visibilitychange");
  await settleRefresh(tab);
  assert.equal(tab.api.focusState.sessionId, "session");
  assert.equal(tab.api.focusState.isPaused, true);
  assert.equal(tab.elements.focusTimer.textContent, "00:30");
  assert.equal(tab.elements.focusPauseBtn.textContent, "Resume");
  assert.equal(tab.elements.focusStartBtn.hidden, true);
  assert.equal(tab.elements.focusStopBtn.disabled, false);
  session = null;
  tab.fireWindow("focus");
  await settleRefresh(tab);
  assert.equal(tab.api.focusState.sessionId, null);
  assert.equal(tab.elements.focusTimer.textContent, "00:00");
  assert.equal(tab.elements.focusStopBtn.hidden, true);
  assert.equal(tab.elements.focusStartBtn.hidden, false);
  assert.equal(tab.toasts.length, 0);
  assert.ok(requests.every((url) => url === "/tasks" || url === "/focus-sessions/active"));
});

test("visible peer tabs automatically reconcile successful Pause, Resume, and Stop", async () => {
  const messaging = createTabMessaging();
  const a = createFocusTab(messaging.BroadcastChannel);
  const b = createFocusTab(messaging.BroadcastChannel);
  let session = activeSession();
  const bRequests = [];
  installSessionReads(b, () => session, bRequests);
  installSessionReads(a, () => session);
  await a.api.requestFocusRefresh();
  await b.api.requestFocusRefresh();
  a.api.setApiFetch(async (url) => {
    if (url === "/focus-sessions/pause") session = activeSession({ pausedAt: "2026-10-02T18:00:30.000Z" });
    else if (url === "/focus-sessions/resume") session = activeSession({ totalPausedMs: 15000 });
    else if (url === "/focus-sessions/stop") session = null;
    else throw new Error(`Unexpected action: ${url}`);
    return jsonResponse(200, session);
  });
  assert.equal(await a.api.toggleFocusPauseState(), true);
  await settleRefresh(b);
  assert.equal(b.elements.focusTimer.textContent, "00:30");
  assert.equal(b.elements.focusPauseBtn.textContent, "Resume");
  assert.equal(await a.api.toggleFocusPauseState(), true);
  await settleRefresh(b);
  assert.equal(b.api.focusState.isPaused, false);
  assert.equal(b.api.focusState.totalPausedMs, 15000);
  assert.equal(b.elements.focusPauseBtn.textContent, "Pause");
  assert.equal(await a.api.stopFocusSession(), true);
  await settleRefresh(b);
  assert.equal(b.api.focusState.sessionId, null);
  assert.equal(b.elements.focusTimer.textContent, "00:00");
  assert.equal(b.elements.focusStopBtn.hidden, true);
  assert.equal(b.toasts.length, 0);
  assert.equal(messaging.messages.length, 3);
  for (const message of messaging.messages) assert.deepEqual(Object.keys(message), ["type"]);
  assert.ok(bRequests.every((url) => url === "/tasks" || url === "/focus-sessions/active"));
});

test("a new session signal restores a peer whose old task list did not include that task", async () => {
  const messaging = createTabMessaging();
  const tab = createFocusTab(messaging.BroadcastChannel);
  tab.api.focusState.allTasks = [];
  installSessionReads(tab, () => activeSession());
  messaging.channels[0].receive({ data: { type: "focus-session-changed" } });
  await settleRefresh(tab);
  assert.equal(tab.api.focusState.taskId, "task");
  assert.equal(tab.api.focusState.sessionId, "session");
  assert.equal(tab.elements.focusTaskSelect.value, "task");
  assert.equal(tab.elements.focusTimer.textContent, "01:00");
  assert.equal(tab.toasts.length, 0);
});

test("overlapping tab events serialize reads and discard the earlier running snapshot", async () => {
  const tab = createFocusTab();
  let resolveFirst;
  let reads = 0;
  installSessionReads(tab, () => {
    reads += 1;
    if (reads === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return activeSession({ pausedAt: "2026-10-02T18:00:20.000Z" });
  });
  const first = tab.api.requestFocusRefresh();
  tab.fireWindow("focus");
  tab.fireDocument("visibilitychange");
  assert.equal(reads, 1);
  resolveFirst(activeSession());
  await first;
  assert.equal(reads, 2);
  assert.equal(tab.api.focusState.isPaused, true);
  assert.equal(tab.elements.focusTimer.textContent, "00:20");
});

test("an in-flight refresh cannot resurrect a locally stopped session", async () => {
  const tab = createFocusTab();
  installSessionReads(tab, () => activeSession());
  await tab.api.requestFocusRefresh();
  let resolveRead;
  tab.api.setApiFetch(async (url) => {
    if (url === "/focus-sessions/active") return new Promise((resolve) => { resolveRead = resolve; });
    if (url === "/tasks") return jsonResponse(200, [{ _id: "task", status: "active" }]);
    if (url === "/focus-sessions/stop") return jsonResponse(200);
    throw new Error(`Unexpected request: ${url}`);
  });
  const refresh = tab.api.requestFocusRefresh();
  assert.equal(await tab.api.stopFocusSession(), true);
  resolveRead(jsonResponse(200, activeSession()));
  await refresh;
  assert.equal(tab.api.focusState.sessionId, null);
  assert.equal(tab.elements.focusTimer.textContent, "00:00");
  assert.equal(tab.elements["focus-status"].textContent, "Focus session stopped.");
});

test("refresh signals wait for a local Pause and then read fresh server state", async () => {
  const tab = createFocusTab();
  installSessionReads(tab, () => activeSession());
  await tab.api.requestFocusRefresh();
  let resolvePause;
  let reads = 0;
  const paused = activeSession({ pausedAt: "2026-10-02T18:00:25.000Z" });
  tab.api.setApiFetch(async (url) => {
    if (url === "/focus-sessions/pause") return new Promise((resolve) => { resolvePause = resolve; });
    if (url === "/focus-sessions/active") { reads += 1; return jsonResponse(200, paused); }
    if (url === "/tasks") return jsonResponse(200, [{ _id: "task", status: "active" }]);
    throw new Error(`Unexpected request: ${url}`);
  });
  const pause = tab.api.toggleFocusPauseState();
  tab.fireWindow("focus");
  assert.equal(reads, 0);
  resolvePause(jsonResponse(200, paused));
  assert.equal(await pause, true);
  await settleRefresh(tab);
  assert.equal(reads, 1);
  assert.equal(tab.elements.focusTimer.textContent, "00:25");
  assert.equal(tab.api.focusState.isPaused, true);
  assert.equal(tab.api.focusState.transitionPending, false);
});

test("failed refresh preserves the current timer without a toast and retries on pageshow", async () => {
  const tab = createFocusTab();
  installSessionReads(tab, () => activeSession());
  await tab.api.requestFocusRefresh();
  tab.api.setApiFetch(async () => { throw new Error("offline"); });
  await tab.api.requestFocusRefresh();
  assert.equal(tab.api.focusState.sessionId, "session");
  assert.equal(tab.elements.focusTimer.textContent, "01:00");
  assert.equal(tab.toasts.length, 0);
  assert.equal(tab.consoleErrors.length, 1);
  installSessionReads(tab, () => null);
  tab.fireWindow("pageshow");
  await settleRefresh(tab);
  assert.equal(tab.api.focusState.sessionId, null);
});

test("fallback polling is visible-only and sync initialization does not duplicate listeners", async () => {
  const tab = createFocusTab();
  tab.api.initFocusSessionSync();
  const polls = tab.intervals.filter((interval) => interval.delay === 15000);
  assert.equal(polls.length, 1);
  let reads = 0;
  installSessionReads(tab, () => { reads += 1; return null; });
  tab.document.visibilityState = "hidden";
  polls[0].callback();
  assert.equal(reads, 0);
  tab.document.visibilityState = "visible";
  polls[0].callback();
  await settleRefresh(tab);
  assert.equal(reads, 1);
});

test("hidden tabs queue messages until visible and unknown messages do not trigger reads", async () => {
  const messaging = createTabMessaging();
  const tab = createFocusTab(messaging.BroadcastChannel);
  let reads = 0;
  installSessionReads(tab, () => { reads += 1; return activeSession(); });
  messaging.channels[0].receive({ data: { type: "unrelated" } });
  assert.equal(reads, 0);
  tab.document.visibilityState = "hidden";
  messaging.channels[0].receive({ data: { type: "focus-session-changed" } });
  assert.equal(reads, 0);
  tab.document.visibilityState = "visible";
  tab.fireDocument("visibilitychange");
  await settleRefresh(tab);
  assert.equal(reads, 1);
  assert.equal(tab.api.focusState.sessionId, "session");
});

test("background recovery of an inactive task never sends a stop mutation", async () => {
  const tab = createFocusTab();
  const requests = [];
  tab.api.setApiFetch(async (url) => {
    requests.push(url);
    if (url === "/focus-sessions/active") return jsonResponse(200, activeSession());
    if (url === "/tasks") return jsonResponse(200, [{ _id: "task", status: "completed" }]);
    throw new Error(`Background refresh attempted a mutation: ${url}`);
  });
  await tab.api.requestFocusRefresh();
  assert.deepEqual(requests, ["/focus-sessions/active", "/tasks"]);
  assert.equal(tab.api.focusState.sessionId, null);
  assert.equal(tab.elements["focus-status"].textContent, "The focused task is no longer active.");
  assert.equal(tab.consoleErrors.length, 0);
});

test("Start broadcasts only after the server creates the session and restores an idle peer", async () => {
  const messaging = createTabMessaging();
  const a = createFocusTab(messaging.BroadcastChannel);
  const b = createFocusTab(messaging.BroadcastChannel);
  let session = null;
  installSessionReads(a, () => session);
  installSessionReads(b, () => session);
  await a.api.initFocusMode();
  let resolveStart;
  a.api.setApiFetch(async (url) => {
    assert.equal(url, "/focus-sessions/start");
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const start = a.elements.focusStartBtn.click();
  assert.equal(messaging.messages.length, 0);
  assert.equal(a.api.focusState.transitionPending, true);
  await a.elements.focusStartBtn.click();
  session = activeSession();
  resolveStart(jsonResponse(200, session));
  await start;
  await settleRefresh(b);
  assert.equal(messaging.messages.length, 1);
  assert.equal(b.api.focusState.sessionId, "session");
  assert.equal(b.elements.focusStopBtn.hidden, false);
  assert.equal(a.api.focusState.transitionPending, false);
});

test("a delayed running snapshot cannot overwrite a successful local Pause", async () => {
  const tab = createFocusTab();
  installSessionReads(tab, () => activeSession());
  await tab.api.requestFocusRefresh();
  let resolveRead;
  const paused = activeSession({ pausedAt: "2026-10-02T18:00:40.000Z" });
  tab.api.setApiFetch(async (url) => {
    if (url === "/focus-sessions/active") return new Promise((resolve) => { resolveRead = resolve; });
    if (url === "/tasks") return jsonResponse(200, [{ _id: "task", status: "active" }]);
    if (url === "/focus-sessions/pause") return jsonResponse(200, paused);
    throw new Error(`Unexpected request: ${url}`);
  });
  const refresh = tab.api.requestFocusRefresh();
  assert.equal(await tab.api.toggleFocusPauseState(), true);
  resolveRead(jsonResponse(200, activeSession()));
  await refresh;
  assert.equal(tab.api.focusState.isPaused, true);
  assert.equal(tab.elements.focusTimer.textContent, "00:40");
  assert.equal(tab.elements.focusPauseBtn.textContent, "Resume");
});

test("failed local mutations do not broadcast a state change", async () => {
  const messaging = createTabMessaging();
  const tab = createFocusTab(messaging.BroadcastChannel);
  installSessionReads(tab, () => activeSession());
  await tab.api.requestFocusRefresh();
  tab.api.setApiFetch(async () => jsonResponse(500, { error: "internal detail" }));
  assert.equal(await tab.api.toggleFocusPauseState(), false);
  assert.equal(await tab.api.stopFocusSession(), false);
  assert.equal(messaging.messages.length, 0);
  assert.equal(tab.api.focusState.sessionId, "session");
  assert.equal(tab.api.focusSync.mutationDepth, 0);
  assert.equal(tab.api.focusState.transitionPending, false);
});
