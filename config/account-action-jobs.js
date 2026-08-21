const crypto = require("crypto");
const AccountActionJob = require("./models/accountActionJob");
const User = require("./models/user");

const ACCOUNT_ACTION_KINDS = new Set([
  "register",
  "resend-verification",
  "forgot-password",
]);
const PAYLOAD_VERSION = 1;
const PAYLOAD_AAD = Buffer.from("stickapin-account-action-job:v1", "utf8");
const DEFAULT_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

class AccountActionJobError extends Error {
  constructor(code) {
    super(code);
    this.name = "AccountActionJobError";
    this.code = code;
  }
}

function requireSecret(secret) {
  const value = String(secret || "");
  if (!value) throw new AccountActionJobError("ACCOUNT_ACTION_KEY_UNAVAILABLE");
  return value;
}

/** Derive a purpose-specific 256-bit key without reusing the session key directly. */
function derivePayloadKey(secret) {
  return crypto
    .createHmac("sha256", requireSecret(secret))
    .update("stickapin/account-action-outbox/encryption-key/v1")
    .digest();
}

function encryptAccountActionPayload(payload, secret) {
  const initializationVector = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    derivePayloadKey(secret),
    initializationVector
  );
  cipher.setAAD(PAYLOAD_AAD);
  const encryptedPayload = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    encryptedPayload: encryptedPayload.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptAccountActionPayload(job, secret) {
  try {
    if (Number(job?.payloadVersion) !== PAYLOAD_VERSION) {
      throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_VERSION_UNSUPPORTED");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      derivePayloadKey(secret),
      Buffer.from(String(job.initializationVector || ""), "base64")
    );
    decipher.setAAD(PAYLOAD_AAD);
    decipher.setAuthTag(Buffer.from(String(job.authenticationTag || ""), "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(job.encryptedPayload || ""), "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext);

    if (!payload || payload.kind !== job.kind) {
      throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_INVALID");
    }
    return payload;
  } catch (error) {
    if (error instanceof AccountActionJobError) throw error;
    throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_INVALID");
  }
}

function hashAccountActionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateAccountActionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function assertWorkerPayload(payload, kind) {
  const email = String(payload?.email || "").trim();
  const baseUrl = String(payload?.baseUrl || "").trim();
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_INVALID");
  }

  if (!email || !["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_INVALID");
  }

  if (kind === "register") {
    const firstName = String(payload.firstName || "").trim();
    const lastName = String(payload.lastName || "").trim();
    const passwordHash = String(payload.passwordHash || "");
    if (!firstName || !lastName || !passwordHash) {
      throw new AccountActionJobError("ACCOUNT_ACTION_PAYLOAD_INVALID");
    }
  }
}

/**
 * Apply one queued action. All account-dependent branching happens here, after
 * the public request has already received the generic acknowledgement.
 */
async function processAccountActionPayload({
  kind,
  payload,
  UserModel = User,
  sendVerificationEmail,
  sendPasswordResetEmail,
  now = () => new Date(),
  generateToken = generateAccountActionToken,
  verificationTtlMs = 60 * 60 * 1000,
  passwordResetTtlMs = 30 * 60 * 1000,
}) {
  assertWorkerPayload(payload, kind);
  const currentTime = now();

  if (kind === "register") {
    let user = await UserModel.findOne({ email: payload.email });
    let verificationToken = null;

    if (!user) {
      verificationToken = generateToken();
      try {
        user = await UserModel.create({
          firstName: payload.firstName,
          lastName: payload.lastName,
          email: payload.email,
          passwordHash: payload.passwordHash,
          emailVerified: false,
          emailVerificationTokenHash: hashAccountActionToken(verificationToken),
          emailVerificationExpiresAt: new Date(currentTime.getTime() + verificationTtlMs),
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        user = await UserModel.findOne({ email: payload.email });
        verificationToken = null;
      }
    }

    if (user?.emailVerified === false && !verificationToken) {
      verificationToken = generateToken();
      user = await UserModel.findOneAndUpdate(
        { _id: user._id, emailVerified: false },
        {
          $set: {
            emailVerificationTokenHash: hashAccountActionToken(verificationToken),
            emailVerificationExpiresAt: new Date(currentTime.getTime() + verificationTtlMs),
          },
        },
        { new: true }
      );
    }

    if (user?.emailVerified === false && verificationToken) {
      await sendVerificationEmail(
        user.email,
        user.firstName,
        verificationToken,
        payload.baseUrl
      );
      return { emailSent: true };
    }
    return { emailSent: false };
  }

  if (kind === "resend-verification") {
    const verificationToken = generateToken();
    const user = await UserModel.findOneAndUpdate(
      { email: payload.email, emailVerified: false },
      {
        $set: {
          emailVerificationTokenHash: hashAccountActionToken(verificationToken),
          emailVerificationExpiresAt: new Date(currentTime.getTime() + verificationTtlMs),
        },
      },
      { new: true }
    );
    if (user) {
      await sendVerificationEmail(
        user.email,
        user.firstName,
        verificationToken,
        payload.baseUrl
      );
      return { emailSent: true };
    }
    return { emailSent: false };
  }

  if (kind === "forgot-password") {
    const resetToken = generateToken();
    const user = await UserModel.findOneAndUpdate(
      { email: payload.email },
      {
        $set: {
          passwordResetTokenHash: hashAccountActionToken(resetToken),
          passwordResetExpiresAt: new Date(currentTime.getTime() + passwordResetTtlMs),
          passwordResetRequestedAt: currentTime,
        },
      },
      { new: true }
    );
    if (user) {
      await sendPasswordResetEmail(
        user.email,
        user.firstName,
        resetToken,
        payload.baseUrl
      );
      return { emailSent: true };
    }
    return { emailSent: false };
  }

  throw new AccountActionJobError("ACCOUNT_ACTION_KIND_UNSUPPORTED");
}

function createAccountActionJobService({
  JobModel = AccountActionJob,
  UserModel = User,
  secret = process.env.SESSION_SECRET,
  sendVerificationEmail,
  sendPasswordResetEmail,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  jobTtlMs = DEFAULT_JOB_TTL_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  verificationTtlMs = 60 * 60 * 1000,
  passwordResetTtlMs = 30 * 60 * 1000,
} = {}) {
  if (typeof sendVerificationEmail !== "function") {
    throw new TypeError("sendVerificationEmail is required");
  }
  if (typeof sendPasswordResetEmail !== "function") {
    throw new TypeError("sendPasswordResetEmail is required");
  }

  const resolvedJobTtlMs = positiveNumber(jobTtlMs, DEFAULT_JOB_TTL_MS);
  const resolvedLockTimeoutMs = positiveNumber(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const resolvedMaxAttempts = positiveNumber(maxAttempts, DEFAULT_MAX_ATTEMPTS);

  async function enqueue(kind, payload) {
    if (!ACCOUNT_ACTION_KINDS.has(kind)) {
      throw new AccountActionJobError("ACCOUNT_ACTION_KIND_UNSUPPORTED");
    }
    const currentTime = now();
    const encrypted = encryptAccountActionPayload({ ...payload, kind }, secret);
    const job = await JobModel.create({
      kind,
      payloadVersion: PAYLOAD_VERSION,
      ...encrypted,
      status: "pending",
      attempts: 0,
      availableAt: currentTime,
      expiresAt: new Date(currentTime.getTime() + resolvedJobTtlMs),
    });
    return { id: String(job._id || job.id) };
  }

  async function claim(id) {
    const currentTime = now();
    const filter = {
      expiresAt: { $gt: currentTime },
      attempts: { $lt: resolvedMaxAttempts },
      $or: [
        { status: "pending", availableAt: { $lte: currentTime } },
        {
          status: "processing",
          lockedAt: { $lte: new Date(currentTime.getTime() - resolvedLockTimeoutMs) },
        },
      ],
    };
    if (id) filter._id = id;

    const lockToken = randomUUID();
    return JobModel.findOneAndUpdate(
      filter,
      {
        $set: {
          status: "processing",
          lockedAt: currentTime,
          lockToken,
          lastErrorCode: null,
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { availableAt: 1, createdAt: 1 } }
    );
  }

  async function processClaimedJob(job) {
    try {
      const payload = decryptAccountActionPayload(job, secret);
      await processAccountActionPayload({
        kind: job.kind,
        payload,
        UserModel,
        sendVerificationEmail,
        sendPasswordResetEmail,
        now,
        verificationTtlMs,
        passwordResetTtlMs,
      });
      await JobModel.updateOne(
        { _id: job._id, status: "processing", lockToken: job.lockToken },
        {
          $set: {
            status: "completed",
            completedAt: now(),
            encryptedPayload: null,
            initializationVector: null,
            authenticationTag: null,
            lockedAt: null,
            lockToken: null,
            lastErrorCode: null,
          },
        }
      );
      return "completed";
    } catch (error) {
      const attempts = Number(job.attempts) || 1;
      const terminal = attempts >= resolvedMaxAttempts;
      const retryDelayMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempts - 1));
      const errorCode =
        error instanceof AccountActionJobError ? error.code : "ACCOUNT_ACTION_PROCESSING_FAILED";
      const update = terminal
        ? {
            $set: {
              status: "failed",
              completedAt: now(),
              encryptedPayload: null,
              initializationVector: null,
              authenticationTag: null,
              lockedAt: null,
              lockToken: null,
              lastErrorCode: errorCode,
            },
          }
        : {
            $set: {
              status: "pending",
              availableAt: new Date(now().getTime() + retryDelayMs),
              lockedAt: null,
              lockToken: null,
              lastErrorCode: errorCode,
            },
          };
      await JobModel.updateOne(
        { _id: job._id, status: "processing", lockToken: job.lockToken },
        update
      );
      return terminal ? "failed" : "retry-scheduled";
    }
  }

  async function processById(id) {
    const job = await claim(id);
    if (!job) return "not-ready";
    return processClaimedJob(job);
  }

  async function drain({ limit = 10 } = {}) {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
    if (typeof JobModel.deleteMany === "function") {
      await JobModel.deleteMany({ expiresAt: { $lte: now() } });
    }
    const summary = { processed: 0, completed: 0, retried: 0, failed: 0 };
    for (let index = 0; index < safeLimit; index += 1) {
      const job = await claim();
      if (!job) break;
      const result = await processClaimedJob(job);
      summary.processed += 1;
      if (result === "completed") summary.completed += 1;
      if (result === "retry-scheduled") summary.retried += 1;
      if (result === "failed") summary.failed += 1;
    }
    return summary;
  }

  return { enqueue, processById, drain };
}

module.exports = {
  ACCOUNT_ACTION_KINDS,
  AccountActionJobError,
  createAccountActionJobService,
  decryptAccountActionPayload,
  encryptAccountActionPayload,
  generateAccountActionToken,
  hashAccountActionToken,
  processAccountActionPayload,
};
