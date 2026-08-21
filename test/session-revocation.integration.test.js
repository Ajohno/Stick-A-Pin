const test = require("node:test");
const assert = require("node:assert/strict");

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
    const tokenHash = "test-token-hash";
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

    const reset = await User.findOneAndUpdate(
      {
        _id: legacySessionUserId,
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          passwordHash: await bcrypt.hash(newPassword, 4),
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
        $inc: { authVersion: 1 },
      },
      { new: true }
    );
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
    assert.equal(
      await User.findOneAndUpdate(
        { _id: legacySessionUserId, passwordResetTokenHash: tokenHash },
        { $inc: { authVersion: 1 } }
      ),
      null
    );
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
