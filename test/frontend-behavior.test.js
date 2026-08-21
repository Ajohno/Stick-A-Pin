const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadFrontend({ pathname = "/focus-page.html", elements = {}, fetchImpl } = {}) {
  const redirects = [];
  const toasts = [];
  const consoleErrors = [];
  const document = {
    body: { classList: { contains: () => false } },
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
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
      clearInterval: () => {},
      clearTimeout: () => {},
      setInterval: () => 1,
      setTimeout: () => 1,
    },
    location,
    URL,
    URLSearchParams,
    Headers,
    fetch: fetchImpl || (async () => { throw new Error("Unexpected fetch"); }),
    Toast: { show: (toast) => toasts.push(toast) },
    DurationUtils: { formatTimer: () => "00:00", calculateElapsedMs: () => 0 },
    setInterval: () => 1,
    clearInterval: () => {},
    CustomEvent: class CustomEvent {},
  });
  const source = `${fs.readFileSync("public/js/main.js", "utf8")}
    globalThis.frontendTestApi = {
      selectFilterForFocusedTask,
      stopFocusSession,
      focusState,
      checkAuthStatus,
      callApiFetch(...args) { return apiFetch(...args); },
      getSafeNextPath,
      setApiFetch(value) { apiFetch = value; },
      resetAuthPromise() { authStatusPromise = null; },
      disableNavRefresh() { updateNavTaskCounter = () => {}; },
    };`;
  vm.runInContext(source, context);
  return { api: context.frontendTestApi, redirects, toasts, consoleErrors };
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
