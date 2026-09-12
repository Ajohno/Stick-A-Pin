const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { createPasswordResetHandler } = require("../config/password-reset");
const { validatePasswordStrength } = require("../config/account-action-routes");
const { hashAccountActionToken } = require("../config/account-action-jobs");

test("successful reset records one secret-free revocation event", async () => {
  const events = [];
  const errors = [];
  let databaseUpdated = false;
  let savedUpdate;

  const handler = createPasswordResetHandler({
    User: {
      async findOneAndUpdate(filter, update) {
        savedUpdate = update;
        databaseUpdated = true;

        return {
          _id: "test-user",
          authVersion: 3,
          email: "private@example.test",
          passwordHash: update.$set.passwordHash,
          authProviders: { google: { id: "private-google-id" } },
        };
      },
    },
    bcrypt,
    validatePasswordStrength,
    hashVerificationToken: hashAccountActionToken,
    logger: {
      info(message) {
        assert.equal(databaseUpdated, true);
        events.push(JSON.parse(message));
      },
      error(message) {
        errors.push(message);
      },
    },
  });

  const req = {
    body: {
      email: "private@example.test",
      token: "private-reset-token",
      newPassword: "NewPassword123!",
    },
  };

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, "Password reset successful. You can now log in.");
  assert.equal(errors.length, 0);
  assert.equal(events.length, 1);

  const { timestamp, ...event } = events[0];
  assert.equal(typeof timestamp, "string");
  assert.equal(Number.isNaN(Date.parse(timestamp)), false);
  assert.deepEqual(event, {
    event: "password_reset_sessions_revoked",
    userId: "test-user",
    reason: "password_reset",
    authVersion: 3,
  });

  assert.equal(savedUpdate.$inc.authVersion, 1);
  assert.equal(savedUpdate.$set.passwordResetTokenHash, null);
  assert.equal(savedUpdate.$set.passwordResetExpiresAt, null);
  assert.equal(savedUpdate.$set.passwordResetRequestedAt, null);
  assert.equal(
    await bcrypt.compare(req.body.newPassword, savedUpdate.$set.passwordHash),
    true
  );
});

test("a rejected reset returns a generic error and emits no revocation event", async () => {
  const events = [];
  const errors = [];

  const handler = createPasswordResetHandler({
    User: {
      async findOneAndUpdate() {
        return null;
      },
    },
    bcrypt,
    validatePasswordStrength,
    hashVerificationToken: hashAccountActionToken,
    logger: {
      info(message) {
        events.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
  });

  const req = {
    body: {
      email: "private@example.test",
      token: "rejected-reset-token",
      newPassword: "NewPassword123!",
    },
  };

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: "This password reset link is invalid or expired.",
  });
  assert.equal(events.length, 0);
  assert.equal(errors.length, 0);
});