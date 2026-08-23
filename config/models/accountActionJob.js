const mongoose = require("mongoose");

/**
 * Durable account-action work queued by public authentication endpoints.
 *
 * Payloads are encrypted before they reach this collection. Keeping the public
 * request path to one uniform insert prevents account-state and email-provider
 * latency from revealing whether an address is registered.
 */
const AccountActionJobSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["register", "resend-verification", "forgot-password"],
      required: true,
    },
    payloadVersion: { type: Number, required: true, default: 1 },
    encryptedPayload: { type: String, default: null },
    initializationVector: { type: String, default: null },
    authenticationTag: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    availableAt: { type: Date, required: true, default: Date.now },
    lockedAt: { type: Date, default: null },
    lockToken: { type: String, default: null },
    completedAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

AccountActionJobSchema.index(
  { status: 1, availableAt: 1, createdAt: 1 },
  { name: "account_action_jobs_ready" }
);
AccountActionJobSchema.index(
  { expiresAt: 1 },
  { name: "account_action_jobs_expiry", expireAfterSeconds: 0 }
);

module.exports = mongoose.model("AccountActionJob", AccountActionJobSchema);
