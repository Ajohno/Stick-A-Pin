const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadNotificationHelpers() {
  const source = fs.readFileSync("public/js/main.js", "utf8");
  const end = source.indexOf("let csrfTokenPromise = null;");
  assert.ok(end > 0, "notification helpers must precede application state");

  const toasts = [];
  const diagnostics = [];
  const context = {
    Toast: { show: (toast) => toasts.push(toast) },
    window: { alert: (message) => toasts.push({ message, fallback: true }) },
    console: { error: (...args) => diagnostics.push(args) },
  };

  vm.runInNewContext(
    `${source.slice(0, end)}\n` +
      "globalThis.notificationCopy = NOTIFICATION_COPY;\n" +
      "globalThis.notifyFailureForTest = notifyFailure;",
    context,
  );

  return { ...context, toasts, diagnostics };
}

test("notification failures show reviewed copy and keep diagnostics out of toasts", () => {
  const { notificationCopy, notifyFailureForTest, toasts, diagnostics } =
    loadNotificationHelpers();
  const serverError = "MongoDB connection failed for admin@example.test";

  notifyFailureForTest("loginFailed", serverError);

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, notificationCopy.loginFailed);
  assert.equal(toasts[0].type, "error");
  assert.equal(toasts[0].duration, 3200);
  assert.equal(toasts[0].message.includes(serverError), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0][0], "Notification failure: loginFailed");
  assert.equal(diagnostics[0][1], serverError);
});

test("representative auth, task, focus, and feedback failures use reviewed copy", () => {
  const source = fs.readFileSync("public/js/main.js", "utf8");

  for (const copyKey of [
    "registrationFailed",
    "loginFailed",
    "resendVerificationFailed",
    "passwordResetRequestFailed",
    "passwordResetFailed",
    "focusUpdateFailed",
    "taskCreateFailed",
    "taskUpdateFailed",
    "feedbackSubmitFailed",
  ]) {
    assert.match(source, new RegExp(`notifyFailure\\("${copyKey}"`));
  }

  assert.doesNotMatch(
    source,
    /message:\s*(?:error\??\.message|data\??\.error|updateData\.error|updatedTask\.error|completion\.error)/,
  );
  assert.doesNotMatch(source, /notify\([^\n]*(?:data\.error|Unknown error)/);
  assert.doesNotMatch(source, /Login Sucessful|function sucessToast|function errorToast/);
});

test("smoke-tested success notifications use sentence case and confirm both Big 3 states", () => {
  const source = fs.readFileSync("public/js/main.js", "utf8");

  assert.match(source, /message: "Task completed\. One step down, time for the next\."/);
  assert.match(source, /message: "Board preferences saved\."/);
  assert.match(
    source,
    /\? "Task added to your Big 3\."\s*:\s*"Task removed from your Big 3\."/,
  );
  assert.doesNotMatch(source, /Task Completed!|Board preferences saved"/);
});
