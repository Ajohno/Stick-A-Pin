const test = require("node:test");
const assert = require("node:assert/strict");
const { toSessionIdentity, parseSessionIdentity } = require("../config/auth-version");

test("new local and OAuth logins serialize the current authentication version", () => {
  assert.deepEqual(toSessionIdentity({ id: "local", authVersion: 0 }), {
    id: "local", authVersion: 0,
  });
  assert.deepEqual(toSessionIdentity({ id: "oauth", authVersion: 4 }), {
    id: "oauth", authVersion: 4,
  });
});

test("legacy, missing, malformed, and negative session versions fail closed", () => {
  assert.equal(parseSessionIdentity("legacy-user-id"), null);
  assert.equal(parseSessionIdentity({ id: "user" }), null);
  assert.equal(parseSessionIdentity({ id: "user", authVersion: "bad" }), null);
  assert.equal(parseSessionIdentity({ id: "user", authVersion: -1 }), null);
  assert.deepEqual(parseSessionIdentity({ id: "user", authVersion: 2 }), {
    id: "user", authVersion: 2,
  });
});
