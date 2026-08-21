const test = require("node:test");
const assert = require("node:assert/strict");
const { genericAccountActionResponse } = require("../config/account-action-response");

test("registration account states have identical public responses", () => {
  const states = ["new", "verified", "unverified"];
  const responses = states.map(() => genericAccountActionResponse());
  responses.forEach((response) => assert.deepEqual(response, responses[0]));
  assert.equal(responses[0].status, 202);
});

test("verification resend account states have identical public responses", () => {
  const states = ["unknown", "verified", "unverified"];
  const responses = states.map(() => genericAccountActionResponse());
  responses.forEach((response) => assert.deepEqual(response, responses[0]));
  assert.equal(Object.keys(responses[0].body).join(","), "message");
});

test("forgot-password uses the same non-enumerating response contract", () => {
  assert.deepEqual(genericAccountActionResponse(), {
    status: 202,
    body: { message: "If the address can be used, check your email for the next step." },
  });
});
