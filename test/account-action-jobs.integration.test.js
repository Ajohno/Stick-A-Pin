const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_MONGO_URI = process.env.TEST_MONGO_URI;
const TEST_DB_NAME = "stickapin_account_action_jobs_integration";

test("durable account-action jobs are encrypted, retryable, and claimed once", {
  skip: !TEST_MONGO_URI,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production", "never run against production");
  assert.notEqual(TEST_MONGO_URI, process.env.MONGO_URI, "TEST_MONGO_URI must be isolated");
  assert.match(TEST_DB_NAME, /^stickapin_.*_integration$/);

  const mongoose = require("mongoose");
  const AccountActionJob = require("../config/models/accountActionJob");
  const User = require("../config/models/user");
  const { createAccountActionJobService } = require("../config/account-action-jobs");
  const {
    setupAccountActionJobIndexes,
  } = require("../scripts/setup-account-action-jobs");

  await mongoose.connect(TEST_MONGO_URI, { autoIndex: false, dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();

  try {
    const indexResult = await setupAccountActionJobIndexes(AccountActionJob.collection, {
      apply: true,
    });
    assert.deepEqual(indexResult.missingAfter, []);

    let resetDeliveryAttempts = 0;
    let verificationDeliveries = 0;
    const service = createAccountActionJobService({
      JobModel: AccountActionJob,
      UserModel: User,
      secret: "integration-session-secret",
      sendVerificationEmail: async () => {
        verificationDeliveries += 1;
      },
      sendPasswordResetEmail: async () => {
        resetDeliveryAttempts += 1;
        if (resetDeliveryAttempts === 1) throw new Error("simulated provider failure");
      },
    });

    const unknown = await service.enqueue("forgot-password", {
      email: "unknown@example.invalid",
      baseUrl: "https://stickapin.example",
    });
    const unknownStored = await AccountActionJob.findById(unknown.id).lean();
    assert.equal(JSON.stringify(unknownStored).includes("unknown@example.invalid"), false);
    assert.equal(await service.processById(unknown.id), "completed");
    const unknownCompleted = await AccountActionJob.findById(unknown.id).lean();
    assert.equal(unknownCompleted.status, "completed");
    assert.equal(unknownCompleted.encryptedPayload, null);
    assert.equal(resetDeliveryAttempts, 0);

    const resetUser = await User.create({
      firstName: "Reset",
      lastName: "User",
      email: "reset@example.invalid",
      passwordHash: "test-hash",
      emailVerified: true,
    });
    const reset = await service.enqueue("forgot-password", {
      email: resetUser.email,
      baseUrl: "https://stickapin.example",
    });
    assert.equal(await service.processById(reset.id), "retry-scheduled");
    let retryJob = await AccountActionJob.findById(reset.id).lean();
    assert.equal(retryJob.status, "pending");
    assert.equal(retryJob.attempts, 1);
    assert.equal(retryJob.lastErrorCode, "ACCOUNT_ACTION_PROCESSING_FAILED");
    assert.ok(retryJob.encryptedPayload);

    await AccountActionJob.updateOne(
      { _id: reset.id },
      { $set: { availableAt: new Date(0) } }
    );
    assert.equal(await service.processById(reset.id), "completed");
    retryJob = await AccountActionJob.findById(reset.id).lean();
    assert.equal(retryJob.status, "completed");
    assert.equal(retryJob.encryptedPayload, null);
    assert.equal(resetDeliveryAttempts, 2);
    assert.ok((await User.findById(resetUser._id)).passwordResetTokenHash);

    const verificationUser = await User.create({
      firstName: "Verify",
      lastName: "User",
      email: "verify@example.invalid",
      passwordHash: "test-hash",
      emailVerified: false,
    });
    const verification = await service.enqueue("resend-verification", {
      email: verificationUser.email,
      baseUrl: "https://stickapin.example",
    });
    const concurrentResults = await Promise.all([
      service.processById(verification.id),
      service.processById(verification.id),
    ]);
    assert.deepEqual(concurrentResults.sort(), ["completed", "not-ready"]);
    assert.equal(verificationDeliveries, 1);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
