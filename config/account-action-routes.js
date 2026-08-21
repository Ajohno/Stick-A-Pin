const bcrypt = require("bcryptjs");
const { genericAccountActionResponse } = require("./account-action-response");

const isValidEmailAddress = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function validatePasswordStrength(password) {
  const value = String(password || "");
  return (
    value.length >= 12 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value)
  );
}

function sendGenericAccountActionResponse(res) {
  const response = genericAccountActionResponse();
  return res.status(response.status).json(response.body);
}

/**
 * Build the public account-action handlers with injectable queue dependencies.
 * Tests exercise these exact handlers over HTTP without importing the full app.
 */
function createAccountActionHandlers({
  enqueueAccountActionJob,
  processAccountActionJob,
  scheduleBackgroundTask,
  resolveBaseUrl,
  hashPassword = (password) => bcrypt.hash(password, 10),
  logger = console,
}) {
  if (typeof enqueueAccountActionJob !== "function") {
    throw new TypeError("enqueueAccountActionJob is required");
  }
  if (typeof processAccountActionJob !== "function") {
    throw new TypeError("processAccountActionJob is required");
  }
  if (typeof scheduleBackgroundTask !== "function") {
    throw new TypeError("scheduleBackgroundTask is required");
  }
  if (typeof resolveBaseUrl !== "function") {
    throw new TypeError("resolveBaseUrl is required");
  }

  async function enqueueAndAcknowledge(res, kind, payload) {
    const job = await enqueueAccountActionJob(kind, payload);
    const response = sendGenericAccountActionResponse(res);

    // The acknowledgement is written before account-dependent work begins.
    // waitUntil keeps this promise alive on Vercel; the persisted job remains
    // available for the cron retry sweep if the invocation is interrupted.
    const taskPromise = Promise.resolve().then(() => processAccountActionJob(job.id));
    try {
      scheduleBackgroundTask(taskPromise, {
        failureMessage: "Account action background processing failed",
      });
    } catch (error) {
      // The database record is durable and the cron sweep will recover it.
      taskPromise.catch(() => {});
      logger.error("Unable to schedule account action background processing");
    }
    return response;
  }

  async function register(req, res) {
    try {
      const firstName = String(req.body?.firstName || "").trim();
      const lastName = String(req.body?.lastName || "").trim();
      const email = String(req.body?.email || "").toLowerCase().trim();
      const password = String(req.body?.password || "");

      // Normalize names before any account-dependent work. In particular,
      // whitespace-only names must not take a different path for known emails.
      if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      if (!isValidEmailAddress(email)) {
        return res.status(400).json({ error: "A valid email address is required" });
      }
      if (!validatePasswordStrength(password)) {
        return res.status(400).json({
          error:
            "Password must be at least 12 characters and include uppercase, lowercase, and a number.",
        });
      }

      // Password hashing remains in the request path so every valid
      // registration performs the same intentionally expensive work.
      const passwordHash = await hashPassword(password);
      return enqueueAndAcknowledge(res, "register", {
        firstName,
        lastName,
        email,
        passwordHash,
        baseUrl: resolveBaseUrl(req),
      });
    } catch (error) {
      logger.error("Error processing registration");
      return res.status(500).json({ error: "Server error while registering user" });
    }
  }

  async function resendVerification(req, res) {
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      if (!isValidEmailAddress(email)) {
        return res.status(400).json({ error: "A valid email address is required" });
      }
      return enqueueAndAcknowledge(res, "resend-verification", {
        email,
        baseUrl: resolveBaseUrl(req),
      });
    } catch (error) {
      logger.error("Error processing verification request");
      return res.status(500).json({ error: "Unable to process verification request" });
    }
  }

  async function forgotPassword(req, res) {
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      if (!isValidEmailAddress(email)) {
        return res.status(400).json({ error: "A valid email address is required" });
      }
      return enqueueAndAcknowledge(res, "forgot-password", {
        email,
        baseUrl: resolveBaseUrl(req),
      });
    } catch (error) {
      logger.error("Error processing password reset request");
      return res.status(500).json({ error: "Unable to process password reset request" });
    }
  }

  return { register, resendVerification, forgotPassword };
}

module.exports = {
  createAccountActionHandlers,
  isValidEmailAddress,
  sendGenericAccountActionResponse,
  validatePasswordStrength,
};
