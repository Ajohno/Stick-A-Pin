const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthorizedCronRequest } = require("../config/cron-auth");

test("account-action cron requires the exact configured Bearer secret", () => {
  assert.equal(isAuthorizedCronRequest("Bearer cron-secret", "cron-secret"), true);
  assert.equal(isAuthorizedCronRequest("Bearer wrong-secret", "cron-secret"), false);
  assert.equal(isAuthorizedCronRequest("cron-secret", "cron-secret"), false);
  assert.equal(isAuthorizedCronRequest("Bearer ", ""), false);
});
