const test = require("node:test");
const assert = require("node:assert/strict");
const { createPasswordResetHandler } = require("../config/password-reset");
const { validatePasswordStrength } = require("../config/account-action-routes");
const { hashAccountActionToken } = require("../config/account-action-jobs");
const TEST_MONGO_URI = process.env.TEST_MONGO_URI;
const TEST_DB_NAME = "stickapin_session_revocation_integration";

function createPassportHarness(UserModel) {
  const configurePassport = require("../config/passport-config");
  const passport = {
    use() {},
    serializeUser(callback) {
      this.serializer = callback;
    },
    deserializeUser(callback) {
      this.deserializer = callback;
    },
  };
  configurePassport(passport, { UserModel });
  return passport;
}

function deserialize(passport, identity) {
  return new Promise((resolve, reject) => {
    passport.deserializer(identity, (error, user) => {
      if (error) reject(error);
      else resolve(user);
    });
  });
}

async function withResetHttpServer(User, resetHandler, callback) {
  const express = require("express");
  const session = require("express-session");
  const { Passport } = require("passport");
  const configurePassport = require("../config/passport-config");
  const {
    createEnsureAuthenticated,
  } = require("../config/ensure-authenticated");

  const passport = new Passport();
  configurePassport(passport, { UserModel: User });

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: "session-revocation-http-test-only",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, sameSite: "lax" },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  const ensureAuthenticated = createEnsureAuthenticated({
    clearSessionCookie(res) {
      res.clearCookie("connect.sid", { path: "/" });
    },
  });

  app.post(
    "/login",
    passport.authenticate("local"),
    (req, res) => res.json({ ok: true })
  );

  app.post("/reset-password", resetHandler);

  app.get("/protected", ensureAuthenticated, (req, res) => {
    res.json({ userId: String(req.user._id) });
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

test("legacy rollout, password reset, and session revocation work end to end", {
  skip: !TEST_MONGO_URI,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production", "never run against production");
  assert.notEqual(TEST_MONGO_URI, process.env.MONGO_URI, "TEST_MONGO_URI must be isolated");
  assert.match(TEST_DB_NAME, /^stickapin_.*_integration$/);

  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const User = require("../config/models/user");
  const { backfillAuthVersions } = require("../scripts/backfill-auth-version");
  await mongoose.connect(TEST_MONGO_URI, { autoIndex: false, dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();

  try {
    const oldPassword = "OldPassword123";
    const newPassword = "NewPassword456";
    const resetToken = "integration-reset-token";
    const tokenHash = hashAccountActionToken(resetToken);
    const now = new Date();
    const legacySessionUserId = new mongoose.Types.ObjectId();
    const legacyBackfillUserId = new mongoose.Types.ObjectId();
    const passwordHash = await bcrypt.hash(oldPassword, 4);

    // Raw inserts bypass Mongoose defaults and reproduce users created before
    // authVersion existed in the schema.
    await User.collection.insertMany([
      {
        _id: legacySessionUserId,
        firstName: "Legacy",
        lastName: "Session",
        email: "legacy-session@example.invalid",
        passwordHash,
        emailVerified: true,
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: legacyBackfillUserId,
        firstName: "Legacy",
        lastName: "Backfill",
        email: "legacy-backfill@example.invalid",
        passwordHash,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const passport = createPassportHarness(User);
    const versionZeroSession = { id: String(legacySessionUserId), authVersion: 0 };
    const legacyUser = await deserialize(passport, versionZeroSession);
    assert.equal(String(legacyUser._id), String(legacySessionUserId));
    assert.equal(
      (await User.collection.findOne({ _id: legacySessionUserId })).authVersion,
      0
    );

    const dryRun = await backfillAuthVersions(User.collection);
    assert.deepEqual(dryRun, { mode: "dry-run", found: 1, modified: 0, remaining: 1 });
    const applied = await backfillAuthVersions(User.collection, { apply: true });
    assert.deepEqual(applied, { mode: "apply", found: 1, modified: 1, remaining: 0 });

    const events = [];
    const handler = createPasswordResetHandler({
      User,
      bcrypt,
      validatePasswordStrength,
      hashVerificationToken: hashAccountActionToken,
      logger: {
        info(message) {
          events.push(JSON.parse(message));
        },
        error() {},
      },
    });

    async function submitReset(email, token, password) {
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

      await handler(
        { body: { email, token, newPassword: password } },
        res
      );
      return res;
    }

    const response = await submitReset(
      "legacy-session@example.invalid",
      resetToken,
      newPassword
    );

    assert.equal(response.statusCode, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "password_reset_sessions_revoked");
    assert.equal(events[0].userId, String(legacySessionUserId));
    assert.equal(events[0].authVersion, 1);

    const reset = await User.findById(legacySessionUserId);
    assert.equal(reset.authVersion, 1);
    assert.equal(await bcrypt.compare(oldPassword, reset.passwordHash), false);
    assert.equal(await bcrypt.compare(newPassword, reset.passwordHash), true);

    // Both pre-reset sessions carry version zero and are rejected. A newly
    // issued version-one session succeeds, and the reset token is one-time use.
    assert.equal(await deserialize(passport, versionZeroSession), null);
    assert.equal(
      await deserialize(passport, { id: String(legacySessionUserId), authVersion: 0 }),
      null
    );
    assert.equal(
      String((await deserialize(passport, {
        id: String(legacySessionUserId),
        authVersion: 1,
      }))._id),
      String(legacySessionUserId)
    );
    // A consumed token cannot reset the password again.
    const reusedResponse = await submitReset(
      "legacy-session@example.invalid",
      resetToken,
      newPassword
    );

    assert.equal(reusedResponse.statusCode, 400);
    assert.deepEqual(reusedResponse.body, {
      error: "This password reset link is invalid or expired.",
    });
    assert.equal(events.length, 1);
    assert.equal(
      (await User.findById(legacySessionUserId)).authVersion,
      1
    );

    // Simulate a Google-only account with a token issued before the policy change.
    const googleOnly = await User.create({
      firstName: "Google",
      lastName: "Only",
      email: "google-only@example.invalid",
      passwordHash: null,
      authVersion: 0,
      authProviders: {
        google: { id: "integration-google-only" },
      },
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });

    const googleResponse = await submitReset(
      googleOnly.email,
      resetToken,
      newPassword
    );

    assert.equal(googleResponse.statusCode, 400);
    assert.deepEqual(googleResponse.body, reusedResponse.body);
    assert.equal(events.length, 1);

    const unchangedGoogle = await User.findById(googleOnly._id);
    assert.equal(unchangedGoogle.passwordHash, null);
    assert.equal(unchangedGoogle.authVersion, 0);
    assert.equal(unchangedGoogle.passwordResetTokenHash, tokenHash);
    assert.equal(
      unchangedGoogle.authProviders.google.id,
      "integration-google-only"
    );

    const linkedUser = await User.create({
      firstName: "Google",
      lastName: "Linked",
      email: "google-linked@example.invalid",
      passwordHash: await bcrypt.hash(oldPassword, 4),
      authVersion: 0,
      authProviders: {
        google: { id: "integration-google-linked" },
      },
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });

    const linkedIdentity = {
      id: String(linkedUser._id),
      authVersion: 0,
    };

    assert.ok(await deserialize(passport, linkedIdentity));

    const linkedResponse = await submitReset(
      linkedUser.email,
      resetToken,
      newPassword
    );

    assert.equal(linkedResponse.statusCode, 200);

    const updatedLinked = await User.findById(linkedUser._id);
    assert.equal(updatedLinked.authVersion, 1);
    assert.equal(
      await bcrypt.compare(newPassword, updatedLinked.passwordHash),
      true
    );
    assert.equal(
      await bcrypt.compare(oldPassword, updatedLinked.passwordHash),
      false
    );
    assert.equal(
      updatedLinked.authProviders.google.id,
      "integration-google-linked"
    );

    assert.equal(await deserialize(passport, linkedIdentity), null);
    assert.ok(await deserialize(passport, {
      id: String(linkedUser._id),
      authVersion: 1,
    }));

    assert.equal(events.length, 2);
    assert.equal(events[1].userId, String(linkedUser._id));
    assert.equal(events[1].authVersion, 1);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("password reset rejects both old cookies and permits a fresh login", {
  skip: !TEST_MONGO_URI,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.notEqual(TEST_MONGO_URI, process.env.MONGO_URI);

  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const User = require("../config/models/user");

  await mongoose.connect(TEST_MONGO_URI, {
    autoIndex: false,
    dbName: "stickapin_session_revocation_http_integration",
  });

  try {
    await mongoose.connection.dropDatabase();

    const email = "cookie-test@example.invalid";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword456!";
    const token = "http-reset-token";

    await User.create({
      firstName: "Cookie",
      lastName: "Test",
      email,
      emailVerified: true,
      passwordHash: await bcrypt.hash(oldPassword, 4),
      authVersion: 0,
      passwordResetTokenHash: hashAccountActionToken(token),
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });

    const events = [];
    const handler = createPasswordResetHandler({
      User,
      bcrypt,
      validatePasswordStrength,
      hashVerificationToken: hashAccountActionToken,
      logger: {
        info(message) {
          events.push(JSON.parse(message));
        },
        error() {},
      },
    });

    await withResetHttpServer(User, handler, async (baseUrl) => {
      async function post(path, body) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify(body),
        });
        await response.text();
        return response;
      }

      async function login(password) {
        const response = await post("/login", { email, password });
        assert.equal(response.status, 200);
        const cookie = response.headers.get("set-cookie");
        assert.ok(cookie);
        return cookie.split(";")[0];
      }

      async function protectedStatus(cookie) {
        const response = await fetch(`${baseUrl}/protected`, {
          headers: { cookie, connection: "close" },
        });
        await response.text();
        return response.status;
      }

      const cookieOne = await login(oldPassword);
      const cookieTwo = await login(oldPassword);

      assert.notEqual(cookieOne, cookieTwo);
      assert.equal(await protectedStatus(cookieOne), 200);
      assert.equal(await protectedStatus(cookieTwo), 200);

      const resetResponse = await post("/reset-password", {
        email,
        token,
        newPassword,
      });
      assert.equal(resetResponse.status, 200);

      assert.equal(await protectedStatus(cookieOne), 401);
      assert.equal(await protectedStatus(cookieTwo), 401);

      const oldLogin = await post("/login", {
        email,
        password: oldPassword,
      });
      assert.equal(oldLogin.status, 401);

      const freshCookie = await login(newPassword);
      assert.notEqual(freshCookie, cookieOne);
      assert.notEqual(freshCookie, cookieTwo);
      assert.equal(await protectedStatus(freshCookie), 200);

      assert.equal(events.length, 1);
      assert.equal(events[0].authVersion, 1);
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
