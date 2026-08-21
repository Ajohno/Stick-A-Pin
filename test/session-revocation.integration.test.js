const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_MONGO_URI = process.env.TEST_MONGO_URI;

test("atomic password reset consumes its token and revokes every old version", {
  skip: !TEST_MONGO_URI,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production", "never run against production");
  assert.notEqual(TEST_MONGO_URI, process.env.MONGO_URI, "TEST_MONGO_URI must be isolated");
  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const User = require("../config/models/user");
  await mongoose.connect(TEST_MONGO_URI, { autoIndex: false });
  await User.collection.drop().catch((error) => {
    if (error.codeName !== "NamespaceNotFound") throw error;
  });
  try {
    const oldPassword = "OldPassword123";
    const newPassword = "NewPassword456";
    const tokenHash = "test-token-hash";
    const user = await User.create({
      firstName: "Test",
      lastName: "User",
      email: "session-test@example.invalid",
      passwordHash: await bcrypt.hash(oldPassword, 4),
      authVersion: 0,
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });
    const sessionOne = { id: user.id, authVersion: 0 };
    const sessionTwo = { id: user.id, authVersion: 0 };
    assert.ok(await User.findOne({ _id: sessionOne.id, authVersion: sessionOne.authVersion }));
    assert.ok(await User.findOne({ _id: sessionTwo.id, authVersion: sessionTwo.authVersion }));

    const reset = await User.findOneAndUpdate(
      { _id: user._id, passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { $gt: new Date() } },
      { $set: {
        passwordHash: await bcrypt.hash(newPassword, 4),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      }, $inc: { authVersion: 1 } },
      { new: true },
    );
    assert.equal(reset.authVersion, 1);
    assert.equal(await User.findOne({ _id: user._id, authVersion: 0 }), null);
    assert.equal(await bcrypt.compare(oldPassword, reset.passwordHash), false);
    assert.equal(await bcrypt.compare(newPassword, reset.passwordHash), true);
    assert.ok(await User.findOne({ _id: user._id, authVersion: 1 }));
    assert.equal(await User.findOneAndUpdate(
      { _id: user._id, passwordResetTokenHash: tokenHash },
      { $inc: { authVersion: 1 } },
    ), null);
  } finally {
    await User.collection.drop();
    await mongoose.disconnect();
  }
});
