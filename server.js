const express = require("express");
const fs = require("fs");
const mime = require("mime");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const connectDB = require("./config/database"); // Connects to MongoDB
const session = require("express-session"); // Handles sessions for logged-in users
const passport = require("passport"); // Middleware for authentication
const bcrypt = require("bcryptjs"); // Used to hash passwords
const User = require("./config/models/user"); // User model for the database
const Task = require("./config/models/task"); // Task model for the database
const FocusSession = require("./config/models/focusSession"); // FocusSession model for tracking focus sessions
const FeedbackReport = require("./config/models/feedbackReport"); // Feedback report model for durable rate limiting
const InboundEmail = require("./config/models/inboundEmail"); // Resend inbound email storage
const csrf = require("lusca").csrf; // CSRF protection middleware
const MongoStore = require("connect-mongo").default; // Store sessions in MongoDB


require("dotenv").config(); // Loads environment variables
require("./config/passport-config")(passport); // Configures Passport authentication

const app = express();
const port = process.env.PORT || 3000;
const REMEMBER_ME_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MINUTES = Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES || 60);
const PASSWORD_RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30);
const APP_BASE_URL = process.env.APP_BASE_URL;
const EMAIL_FROM = process.env.EMAIL_FROM || "Stick A Pin <no-reply@mail.stickapin.app>";
const FEEDBACK_INBOX_EMAIL = (process.env.FEEDBACK_INBOX_EMAIL || "support@stickapin.app").trim();
const FEEDBACK_FROM_EMAIL = process.env.FEEDBACK_FROM_EMAIL || EMAIL_FROM;
const FEEDBACK_HOURLY_LIMIT = Number(process.env.FEEDBACK_HOURLY_LIMIT || 5);
const FEEDBACK_MIN_SECONDS_BETWEEN_REPORTS = Number(process.env.FEEDBACK_MIN_SECONDS_BETWEEN_REPORTS || 60);
const FEEDBACK_REQUEST_BODY_LIMIT = process.env.FEEDBACK_REQUEST_BODY_LIMIT || "30mb";
const RESEND_WEBHOOK_SECRET = (process.env.RESEND_WEBHOOK_SECRET || "").trim();
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const DAILY_EMAIL_SCHEDULER_INTERVAL_MS = Number(process.env.DAILY_EMAIL_SCHEDULER_INTERVAL_MS || 60 * 1000);
let dailyEmailSchedulerStarted = false;
const IS_VERCEL_RUNTIME = String(process.env.VERCEL || "").trim() === "1";
const SHOULD_RUN_DAILY_REFLECTION_SCHEDULER =
  String(process.env.ENABLE_DAILY_REFLECTION_SCHEDULER || "").trim().toLowerCase() === "true";
const VALID_BOARD_TASK_SORT_OPTIONS = new Set(["created_date", "effort_level", "due_date"]);
const VALID_BOARD_DEFAULT_VIEW_OPTIONS = new Set(["board", "calendar"]);

function normalizeBoardTaskSort(rawValue) {
  const candidate = String(rawValue || "").trim();
  return VALID_BOARD_TASK_SORT_OPTIONS.has(candidate) ? candidate : "created_date";
}

function normalizeBoardDefaultView(rawValue) {
  const candidate = String(rawValue || "").trim();
  return VALID_BOARD_DEFAULT_VIEW_OPTIONS.has(candidate) ? candidate : "board";
}

function getDefaultViewPathForUser(user) {
  const defaultView = normalizeBoardDefaultView(user?.settings?.board?.defaultView);
  return defaultView === "calendar" ? "/calendar-page.html" : "/dashboard.html";
}

// Rate limiter for authenticated routes to protect expensive operations
const authenticatedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

let appdata = [];

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

// Connect to MongoDB
app.use(async (req, res, next) => {
  try {
    await connectDB();
    return next();
  } catch (error) {
    console.error("Database unavailable for request (first attempt)", error);

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await connectDB();
      return next();
    } catch (retryError) {
      console.error("Database unavailable for request (retry failed)", retryError);
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
  }
});

// Middleware -----------------------------------------------------------------------------------
const deleteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many account deletion attempts. Please try again later." },
});


// Ensure a user is logged in before accessing routes
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next(); // If the user is authenticated, continue to the route
    }
    res.status(401).json({ error: "Unauthorized - Please log in" });
}

function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendVerificationEmail(email, firstName, token, baseUrl) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const verificationUrl = `${baseUrl}/verify-email?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: "Verify your Stick A Pin account",
      html: `
        <p>Hi ${firstName},</p>
        <p>Thanks for registering. Click the link below to verify your email address:</p>
        <p><a href="${verificationUrl}">Verify my email</a></p>
        <p>If you did not sign up, you can ignore this message.</p>
      `,
    }),
  });

  if (!response.ok) {
    const failure = await response.text();
    throw new Error(`Resend API request failed (${response.status}): ${failure}`);
  }
}

async function sendPasswordResetEmail(email, firstName, token, baseUrl) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const resetUrl = `${baseUrl}/reset-password.html?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: "Reset your Stick A Pin password",
      html: `
        <p>Hi ${firstName || "there"},</p>
        <p>We received a request to reset your password.</p>
        <p><a href="${resetUrl}">Reset password</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    }),
  });

  if (!response.ok) {
    const failure = await response.text();
    throw new Error(`Resend API request failed (${response.status}): ${failure}`);
  }
}

async function sendBugFeedbackEmail({ user, subject, message, attachments = [], requestMeta = {} }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const inboxAddress = extractEmailAddress(FEEDBACK_INBOX_EMAIL || EMAIL_FROM);
  if (!inboxAddress) {
    throw new Error("FEEDBACK_INBOX_EMAIL is not configured");
  }

  const safeSubject = String(subject || "").trim();
  const feedbackReportId = String(requestMeta.feedbackReportId || "").trim();
  const safeMessage = String(message || "").trim();
  const safeName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || "Unknown user";
  const safeEmail = String(user?.email || "").trim() || "unknown@unknown.local";
  const ip = String(requestMeta.ip || "unknown");
  const userAgent = String(requestMeta.userAgent || "unknown");
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const resendAttachments = safeAttachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
  }));
  const attachmentSummary = safeAttachments.length
    ? `
      <p><strong>Image attachments:</strong></p>
      <ul>
        ${safeAttachments
          .map((attachment) => {
            const attachmentSizeKb = Math.max(
              1,
              Math.round((Number(attachment?.sizeBytes) || 0) / 1024)
            );
            return `<li>${escapeHtml(attachment?.filename || "image")} (${escapeHtml(
              attachment?.contentType || "image/unknown"
            )}, ${attachmentSizeKb} KB)</li>`;
          })
          .join("")}
      </ul>
    `
    : "<p><strong>Image attachments:</strong> none</p>";

  const emailBodyHtml = `
    <p><strong>Feedback Report ID:</strong> ${escapeHtml(feedbackReportId || "unknown")}</p>
    <p><strong>Reporter:</strong> ${escapeHtml(safeName)} (${escapeHtml(safeEmail)})</p>
    <p><strong>Submitted:</strong> ${escapeHtml(new Date().toISOString())}</p>
    <p><strong>IP:</strong> ${escapeHtml(ip)}</p>
    <p><strong>User-Agent:</strong> ${escapeHtml(userAgent)}</p>
    ${attachmentSummary}
    <hr />
    <p><strong>Details</strong></p>
    <p>${escapeHtml(safeMessage).replace(/\n/g, "<br />")}</p>
  `;

  async function sendFeedbackEmail(fromAddress) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [inboxAddress],
        reply_to: safeEmail,
        subject: safeSubject,
        html: emailBodyHtml,
        attachments: resendAttachments,
      }),
    });

    if (response.ok) return;

    const failure = await response.text();
    throw new Error(`Resend API request failed (${response.status}): ${failure}`);
  }

  const primarySender = FEEDBACK_FROM_EMAIL;
  const fallbackSender = EMAIL_FROM;

  try {
    await sendFeedbackEmail(primarySender);
  } catch (error) {
    const shouldRetryWithFallback =
      primarySender !== fallbackSender &&
      String(error?.message || "").includes("not authorized to send emails from");

    if (!shouldRetryWithFallback) {
      throw error;
    }

    await sendFeedbackEmail(fallbackSender);
  }
}

function resolveBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/$/, "");
  }

  const vercelUrl = String(
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || ""
  ).trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }

  const forwardedProto = req?.headers?.["x-forwarded-proto"];
  const protocol = (forwardedProto ? forwardedProto.split(",")[0] : req?.protocol || "http").trim();
  const host = req?.get?.("host") || req?.headers?.host;

  if (host) {
    return `${protocol}://${host}`.replace(/\/$/, "");
  }

  return `http://localhost:${port}`;
}

function extractEmailAddress(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const angleMatch = text.match(/<([^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim();
  return text;
}

function extractFeedbackReportIdFromEmail({ subject = "", to = [] }) {
  const subjectText = String(subject || "");
  const subjectMatch = subjectText.match(/\[FR:([a-fA-F0-9]{24})\]/);
  if (subjectMatch?.[1]) return subjectMatch[1].toLowerCase();

  for (const recipient of Array.isArray(to) ? to : []) {
    const normalized = String(recipient || "").toLowerCase();
    const plusMatch = normalized.match(/\+fr_([a-f0-9]{24})@/);
    if (plusMatch?.[1]) return plusMatch[1];
  }

  return null;
}

function parseSvixSecret(secret) {
  const normalizedSecret = String(secret || "").trim();
  if (!normalizedSecret) return null;

  if (normalizedSecret.startsWith("whsec_")) {
    const encoded = normalizedSecret.slice("whsec_".length);
    return Buffer.from(encoded, "base64");
  }

  return Buffer.from(normalizedSecret, "utf8");
}

function getSvixSignatures(signatureHeader = "") {
  return String(signatureHeader || "")
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes(",")) {
        const [version, signature] = entry.split(",", 2);
        return { version, signature };
      }

      if (entry.includes("=")) {
        const [version, signature] = entry.split("=", 2);
        return { version, signature };
      }

      return { version: "", signature: entry };
    });
}

function verifyResendWebhookSignature({ payload, headers, webhookSecret }) {
  const id = String(headers?.["svix-id"] || "").trim();
  const timestamp = String(headers?.["svix-timestamp"] || "").trim();
  const signatureHeader = String(headers?.["svix-signature"] || "").trim();

  if (!id || !timestamp || !signatureHeader || !webhookSecret) {
    return false;
  }

  const secretBuffer = parseSvixSecret(webhookSecret);
  if (!secretBuffer) return false;

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", secretBuffer)
    .update(signedContent)
    .digest("base64");

  const expectedBuffer = Buffer.from(expected);
  const candidates = getSvixSignatures(signatureHeader)
    .filter((item) => item.version === "v1")
    .map((item) => Buffer.from(String(item.signature || "").trim()));

  return candidates.some((candidate) => {
    if (candidate.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(candidate, expectedBuffer);
  });
}

async function fetchReceivedEmailContent(emailId) {
  if (!process.env.RESEND_API_KEY || !emailId) {
    return { text: null, html: null, attachments: [] };
  }

  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const failure = await response.text();
    throw new Error(`Resend retrieve email failed (${response.status}): ${failure}`);
  }

  const payload = await response.json();
  return {
    text: payload?.text || null,
    html: payload?.html || null,
    attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
  };
}


function isValidTimeInput(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function formatDurationFromMs(durationMs) {
  const safeDurationMs = Math.max(0, Number(durationMs) || 0);
  const totalMinutes = Math.floor(safeDurationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateInTimezone(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch (error) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

function getCurrentTimeInTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch (error) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  }
}

async function runDailyReflectionSchedulerTick() {
  try {
    await connectDB();

    const now = new Date();
    const users = await User.find({
      "settings.dailyEmail": { $ne: false },
      emailVerified: { $ne: false },
    }).select("email firstName settings.dailyEmail settings.dailyEmailTime settings.dailyEmailLastSentOn settings.timezone");

    for (const user of users) {
      const timezone = String(user.settings?.timezone || "UTC").trim() || "UTC";
      const scheduledTime = isValidTimeInput(user.settings?.dailyEmailTime)
        ? user.settings.dailyEmailTime
        : "18:00";
      const currentTime = getCurrentTimeInTimezone(timezone);

      if (currentTime !== scheduledTime) {
        continue;
      }

      const todayInTimezone = formatDateInTimezone(now, timezone);
      if (user.settings?.dailyEmailLastSentOn === todayInTimezone) {
        continue;
      }

      try {
        const emailData = await buildDailyReflectionEmailData(user._id);
        await sendDailyReflectionEmail(user, emailData);

        await User.updateOne(
          { _id: user._id },
          { $set: { "settings.dailyEmailLastSentOn": todayInTimezone } }
        );
      } catch (emailError) {
        console.error(`Failed daily reflection send for user ${user._id}:`, emailError);
      }
    }
  } catch (error) {
    console.error("Daily reflection scheduler tick failed:", error);
  }
}

function startDailyReflectionScheduler() {
  if (dailyEmailSchedulerStarted) {
    return;
  }

  dailyEmailSchedulerStarted = true;
  runDailyReflectionSchedulerTick();
  setInterval(runDailyReflectionSchedulerTick, DAILY_EMAIL_SCHEDULER_INTERVAL_MS);
}

function getTodayBounds() {
  return getDayBounds(0);
}

function getDayBounds(daysAgo = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, Number(daysAgo) || 0));
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatSignedDelta(value) {
  const numeric = Number(value) || 0;
  if (numeric > 0) return `+${numeric}`;
  return String(numeric);
}

async function buildDailySummary(userId, daysAgo = 0, includeTaskNames = false) {
  const { start, end } = getDayBounds(daysAgo);

  const [completedTasks, sessions] = await Promise.all([
    Task.find({
      userId,
      status: "completed",
      completedAt: { $gte: start, $lt: end },
    }).sort({ completedAt: 1 }),
    FocusSession.find({
      userId,
      startedAt: { $gte: start, $lt: end },
      durationMs: { $gt: 0 },
    }).select("durationMs"),
  ]);

  const totalFocusMs = sessions.reduce((sum, session) => sum + (Number(session.durationMs) || 0), 0);

  return {
    dateLabel: start.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    completedCount: completedTasks.length,
    totalFocusMs,
    completedTaskNames: includeTaskNames
      ? completedTasks.map((task) => {
        const title = String(task.title || "").trim();
        return title || String(task.description || "").trim() || "Untitled task";
      })
      : [],
  };
}

async function buildDailyReflectionEmailData(userId) {
  const [today, yesterday] = await Promise.all([
    buildDailySummary(userId, 0, true),
    buildDailySummary(userId, 1, false),
  ]);

  return {
    ...today,
    trend: {
      completedVsYesterday: today.completedCount - yesterday.completedCount,
      focusVsYesterdayMs: today.totalFocusMs - yesterday.totalFocusMs,
      yesterdayLabel: yesterday.dateLabel,
    },
  };
}

async function sendDailyReflectionEmail(user, emailData) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const subject = "Your Daily Reflection";

  const tasksHtml = emailData.completedTaskNames.length > 0
    ? `<ul>${emailData.completedTaskNames.map((taskName) => `<li>${escapeHtml(taskName)}</li>`).join("")}</ul>`
    : "<p>No tasks were completed today.</p>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [user.email],
      subject,
      html: `
        <p>Hi ${escapeHtml(user.firstName || "there")},</p>
        <p>Here is your daily performance trend for ${escapeHtml(emailData.dateLabel)}.</p>
        <p><strong>Today you completed:</strong> ${escapeHtml(String(emailData.completedCount))} task(s)</p>
        <p><strong>Today you focused for:</strong> ${escapeHtml(formatDurationFromMs(emailData.totalFocusMs))}</p>
        <p><strong>Completed tasks today:</strong></p>
        ${tasksHtml}
        <hr />
        <p><strong>Trend vs ${escapeHtml(emailData.trend.yesterdayLabel)}:</strong></p>
        <ul>
          <li>Tasks completed: ${escapeHtml(formatSignedDelta(emailData.trend.completedVsYesterday))}</li>
          <li>Focus time: ${escapeHtml(formatSignedDelta(Math.round(emailData.trend.focusVsYesterdayMs / 60000)))} min</li>
        </ul>
      `,
    }),
  });

  if (!response.ok) {
    const failure = await response.text();
    throw new Error(`Resend API request failed (${response.status}): ${failure}`);
  }
}

// Session Handling
app.set("trust proxy", 1); // important on Vercel / proxies

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: "sessions",
    ttl: 14 * 24 * 60 * 60 // 14 days
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // https only in prod
    sameSite: "lax",
    maxAge: REMEMBER_ME_MS
  }
}));

// CSRF protection for routes using cookie-based sessions
const csrfProtection = csrf();
app.use((req, res, next) => {
  if (req.path === "/webhooks/resend/receiving") {
    return next();
  }

  return csrfProtection(req, res, next);
});

app.use(passport.initialize());
app.use(passport.session()); // Enables persistent login sessions

const resendWebhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 60, // limit each IP to 60 requests per windowMs for this endpoint
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/webhooks/resend/receiving", resendWebhookLimiter, express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = req.body ? req.body.toString("utf8") : "{}";

    if (!verifyResendWebhookSignature({
      payload,
      headers: req.headers,
      webhookSecret: RESEND_WEBHOOK_SECRET,
    })) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const event = JSON.parse(payload);
    if (event?.type !== "email.received") {
      return res.json({ received: true, ignored: true });
    }

    const eventData = event?.data || {};
    const emailId = String(eventData.email_id || "").trim();
    if (!emailId) {
      return res.status(400).json({ error: "Missing email_id in webhook payload" });
    }

    const content = await fetchReceivedEmailContent(emailId).catch((error) => {
      console.error("Unable to fetch full received email content from Resend:", error);
      return { text: null, html: null, attachments: [] };
    });
    const feedbackReportId = extractFeedbackReportIdFromEmail({
      subject: eventData.subject,
      to: Array.isArray(eventData.to) ? eventData.to : [],
    });

    await InboundEmail.updateOne(
      { eventId: String(eventData.id || event.id || emailId) },
      {
        $set: {
          eventId: String(eventData.id || event.id || emailId),
          emailId,
          messageId: eventData.message_id || null,
          from: eventData.from || null,
          to: Array.isArray(eventData.to) ? eventData.to : [],
          cc: Array.isArray(eventData.cc) ? eventData.cc : [],
          bcc: Array.isArray(eventData.bcc) ? eventData.bcc : [],
          feedbackReportId: feedbackReportId || null,
          subject: eventData.subject || null,
          createdAtProvider: eventData.created_at ? new Date(eventData.created_at) : null,
          text: content.text,
          html: content.html,
          attachments: content.attachments,
          rawEvent: event,
        },
      },
      { upsert: true }
    );

    return res.json({ received: true });
  } catch (error) {
    console.error("Error handling Resend receiving webhook:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

// Endpoint for clients to retrieve a CSRF token
app.get("/csrf-token", (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.use(express.json({ limit: FEEDBACK_REQUEST_BODY_LIMIT })); // Middleware to parse JSON request body
app.use(express.urlencoded({ extended: false, limit: FEEDBACK_REQUEST_BODY_LIMIT })); // Parses form data

// Serve static files from the "public" directory
app.use(express.static("public"));

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Attachment payload is too large. Please upload smaller images or fewer attachments.",
    });
  }
  return next(error);
});

// ROUTES -----------------------------------------------------------------------------------

// Rate limiter for email verification-related routes
const emailVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per window for verification actions
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for authentication / OAuth-related routes
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 authentication requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

const localAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // tighten brute-force window for local auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
});

const feedbackSubmissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each user+IP to 5 feedback emails per hour
  standardHeaders: true,
  legacyHeaders: false,
});

function isStrategyEnabled(name) {
  try {
    return Boolean(passport._strategy(name));
  } catch (error) {
    return false;
  }
}

function redirectAuthFailure(req, res) {
  return res.redirect("/login.html?error=sso_failed");
}

function getCanonicalGoogleAuthOrigin() {
  const callbackUrl = String(process.env.GOOGLE_CALLBACK_URL || "").trim();
  if (!callbackUrl) return "";

  try {
    const parsed = new URL(callbackUrl);
    return parsed.protocol && parsed.host ? `${parsed.protocol}//${parsed.host}` : "";
  } catch (error) {
    return "";
  }
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return `${protocol}://${host}`;
}


app.get("/auth/google", authRateLimiter, (req, res, next) => {
  if (!isStrategyEnabled("google")) {
    return res.redirect("/login.html?error=google_unavailable");
  }

  const canonicalOrigin = getCanonicalGoogleAuthOrigin();
  const requestOrigin = getRequestOrigin(req);
  if (canonicalOrigin && requestOrigin && canonicalOrigin !== requestOrigin) {
    return res.redirect(`${canonicalOrigin}/auth/google`);
  }

  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback", authRateLimiter, (req, res) => {
  if (!isStrategyEnabled("google")) {
    return redirectAuthFailure(req, res);
  }

  passport.authenticate("google", { failureRedirect: "/login.html?error=sso_failed" })(req, res, (authErr) => {
    if (authErr) {
      console.error("Google OAuth callback failed:", authErr);
      return redirectAuthFailure(req, res);
    }
    return res.redirect(getDefaultViewPathForUser(req.user));
  });
});

// Register Route
function validatePasswordStrength(password) {
  const value = String(password || "");
  const minLength = value.length >= 12;
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasNumber = /\d/.test(value);

  return minLength && hasUpper && hasLower && hasNumber;
}

app.post("/register", localAuthLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) return res.status(400).json({ error: "Email already exists" });

    if (!validatePasswordStrength(password)) {
      return res.status(400).json({
        error: "Password must be at least 12 characters and include uppercase, lowercase, and a number.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const verificationToken = generateVerificationToken();
    const verificationTokenHash = hashVerificationToken(verificationToken);
    const emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000);

    await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      passwordHash,
      emailVerified: false,
      emailVerificationTokenHash: verificationTokenHash,
      emailVerificationExpiresAt,
    });

    try {
      await sendVerificationEmail(normalizedEmail, firstName.trim(), verificationToken, resolveBaseUrl(req));
      return res.status(201).json({ message: "Registration successful. Check your email to verify your account." });
    } catch (emailError) {
      console.error("Verification email delivery failed after registration:", emailError);
      return res.status(201).json({
        message: "Registration successful, but we could not send the verification email yet. Please use resend verification from the verification page.",
        emailDeliveryFailed: true,
      });
    }
  } catch (error) {
    console.error("Error registering user:", error);

    if (error && error.code === 11000) {
      const duplicateFields = Object.keys(error.keyPattern || {});
      const duplicateField = duplicateFields[0] || Object.keys(error.keyValue || {})[0] || "field";

      if (duplicateField === "email") {
        return res.status(400).json({ error: "Email already exists" });
      }

      return res.status(400).json({ error: `A duplicate value exists for ${duplicateField}` });
    }

    if (error && error.name === "ValidationError") {
      return res.status(400).json({ error: "Invalid registration data" });
    }

    return res.status(500).json({ error: "Server error while registering user" });
  }
});

app.get("/verify-email", emailVerificationLimiter, async (req, res) => {
  try {
    const email = (req.query.email || "").toString().toLowerCase().trim();
    const token = (req.query.token || "").toString().trim();

    if (!email || !token) {
      return res.status(400).send("Invalid verification link.");
    }

    const tokenHash = hashVerificationToken(token);

    const user = await User.findOne({
      email,
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).send("This verification link is invalid or expired.");
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
    user.emailVerifiedAt = new Date();
    await user.save();

    return res.redirect("/verification-success.html");
  } catch (error) {
    console.error("Error verifying email:", error);
    return res.status(500).send("Server error while verifying email.");
  }
});

app.post("/resend-verification", emailVerificationLimiter, async (req, res) => {
  try {
    const normalizedEmail = (req.body.email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.json({ message: "If that account exists, a verification email has been sent." });
    }

    if (user.emailVerified !== false) {
      return res.json({ message: "Your email is already verified." });
    }

    const verificationToken = generateVerificationToken();
    user.emailVerificationTokenHash = hashVerificationToken(verificationToken);
    user.emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000);
    await user.save();

    await sendVerificationEmail(user.email, user.firstName, verificationToken, resolveBaseUrl(req));

    return res.json({ message: "Verification email sent." });
  } catch (error) {
    console.error("Error resending verification email:", error);
    return res.status(500).json({ error: "Unable to resend verification email" });
  }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 password reset attempts per window
});

const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // tighter limiter to prevent forgot-password email abuse
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const normalizedEmail = String(req.body?.email || "").toLowerCase().trim();
    return `${req.ip}:${normalizedEmail}`;
  },
});

app.post("/forgot-password", forgotPasswordEmailLimiter, async (req, res) => {
  try {
    const normalizedEmail = (req.body.email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.json({ message: "If that account exists, a password reset email has been sent." });
    }

    const resetToken = generateVerificationToken();
    user.passwordResetTokenHash = hashVerificationToken(resetToken);
    user.passwordResetExpiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
    user.passwordResetRequestedAt = new Date();
    await user.save();

    await sendPasswordResetEmail(user.email, user.firstName, resetToken, resolveBaseUrl(req));

    return res.json({ message: "If that account exists, a password reset email has been sent." });
  } catch (error) {
    console.error("Error requesting password reset:", error);
    return res.status(500).json({ error: "Unable to process password reset request" });
  }
});

app.post("/reset-password", passwordResetLimiter, async (req, res) => {
  try {
    const normalizedEmail = (req.body.email || "").toLowerCase().trim();
    const token = (req.body.token || "").toString().trim();
    const newPassword = (req.body.newPassword || "").toString();

    if (!normalizedEmail || !token || !newPassword) {
      return res.status(400).json({ error: "Email, token, and new password are required" });
    }

    if (!validatePasswordStrength(newPassword)) {
      return res.status(400).json({
        error: "Password must be at least 12 characters and include uppercase, lowercase, and a number.",
      });
    }

    const tokenHash = hashVerificationToken(token);

    const user = await User.findOne({
      email: normalizedEmail,
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: "This password reset link is invalid or expired." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    user.passwordResetRequestedAt = null;
    await user.save();

    return res.json({ message: "Password reset successful. You can now log in." });
  } catch (error) {
    console.error("Error resetting password:", error);
    return res.status(500).json({ error: "Unable to reset password" });
  }
});


// Login Route
app.post("/login", localAuthLimiter, (req, res, next) => {
  const { rememberMe } = req.body;

  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || "Login failed" });

    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) return next(regenerateErr);

      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);

        if (rememberMe) {
          req.session.cookie.maxAge = REMEMBER_ME_MS;
        } else {
          // Keep a bounded persistent cookie to improve Safari/PWA reliability.
          req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
        }

        return res.json({
          message: "Logged in successfully",
          preferredDefaultPath: getDefaultViewPathForUser(user),
          user: {
            id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            settings: {
              board: {
                default_task_sort: normalizeBoardTaskSort(user.settings?.board?.defaultTaskSort),
                default_view: normalizeBoardDefaultView(user.settings?.board?.defaultView),
              },
            },
          },
        });
      });
    });
  })(req, res, next);
});


// Logout Route
app.post("/logout", (req, res) => {
    req.logout((err) => {
        if (err) {
            return res.status(500).json({ error: "Error logging out" });
        }
        req.session.destroy(() => {
          res.clearCookie("connect.sid");
          res.json({ message: "Logged out successfully" });
        });
    });
});
app.delete("/account", deleteAccountLimiter, ensureAuthenticated, async (req, res) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: "Invalid user session" });
  }

  try {
    const feedbackReports = await FeedbackReport.find({ userId }).select("_id");
    const feedbackReportIds = feedbackReports.map((report) => report._id);

    await Promise.all([
      Task.deleteMany({ userId }),
      FocusSession.deleteMany({ userId }),
      FeedbackReport.deleteMany({ userId }),
      feedbackReportIds.length
        ? InboundEmail.deleteMany({ feedbackReportId: { $in: feedbackReportIds } })
        : Promise.resolve(),
      User.deleteOne({ _id: userId }),
    ]);

    req.logout((logoutError) => {
      if (logoutError) {
        console.error("Error during account deletion logout:", logoutError);
      }

      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        return res.json({ message: "Account deleted successfully" });
      });
    });
  } catch (error) {
    console.error("Delete account failed:", error);
    return res.status(500).json({ error: "Unable to delete account right now" });
  }
});

// Serve index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});



function parseDateOnlyInput(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  // Store as local midday to avoid timezone day-shift edge cases.
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseIsoDateTimeInput(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toFocusSessionResponse(session) {
  const rawTask = session?.taskId;
  const taskId = rawTask && typeof rawTask === "object" && rawTask._id
    ? rawTask._id
    : rawTask;
  const taskDescription = rawTask && typeof rawTask === "object" && rawTask.description
    ? rawTask.description
    : null;

  return {
    _id: session._id,
    taskId,
    taskDescription,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs || 0,
    endedReason: session.endedReason
  };
}

// Handles the submit button
app.post("/tasks", ensureAuthenticated, async (req, res) => {
  const { description, dueDate, effortLevel } = req.body;
  let parsedDueDate = null;
  if (typeof dueDate === "string" && dueDate.trim() !== "") {
    parsedDueDate = parseDateOnlyInput(dueDate);
    if (!parsedDueDate) {
      return res.status(400).json({ error: "Invalid due date" });
    }
  }

  await Task.create({
    userId: req.user.id,
    description: description.trim(),
    dueDate: parsedDueDate,
    effortLevel: parseInt(effortLevel, 10) || 3,
    status: "active",
  });

  const userTasks = await Task.find({ userId: req.user.id });
  return res.json(userTasks);
});


// Gets tasks for the logged-in user
app.get("/tasks", ensureAuthenticated, async (req, res) => {
    try {
        const userTasks = await Task.find({ userId: req.user.id });
        res.status(200).json(userTasks);
    } catch (err) {
        console.error("Error Fetching Tasks:", err);
        res.status(500).json({ error: "Server error while retrieving tasks" });
    }
});

// Route to update tasks in the MongoDB database
app.put("/tasks/:taskId", ensureAuthenticated, async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.taskId, userId: req.user.id });
    if (!task) return res.status(404).json({ error: "Task not found" });

    // allow updates
    if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
      const nextDescription = String(req.body.description || "").trim();
      if (!nextDescription) {
        return res.status(400).json({ error: "Description cannot be empty" });
      }
      task.description = nextDescription;
    }

    // if (Object.prototype.hasOwnProperty.call(req.body, "status")) {
    //   task.status = req.body.status;
    // }

    
    if (Object.prototype.hasOwnProperty.call(req.body, "status")) {
      const nextStatus = req.body.status;
      if (!["active", "completed"].includes(nextStatus)) {
        return res.status(400).json({ error: "Invalid status value" });
      }
      
      if (task.status !== nextStatus) {
        task.status = nextStatus;
        if (nextStatus === "completed") {
          task.completedAt = new Date();
        } else if (nextStatus === "active") {
          task.completedAt = null;
        }
      }
    }


    if (Object.prototype.hasOwnProperty.call(req.body, "dueDate")) {
      if (req.body.dueDate === null || req.body.dueDate === "") {
        task.dueDate = null;
      } else {
        const parsedDueDate = parseDateOnlyInput(req.body.dueDate);
        if (!parsedDueDate) {
          return res.status(400).json({ error: "Invalid due date" });
        }
        task.dueDate = parsedDueDate;
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "effortLevel")) {
      const parsedEffortLevel = parseInt(req.body.effortLevel, 10);
      if (!Number.isInteger(parsedEffortLevel) || parsedEffortLevel < 1 || parsedEffortLevel > 5) {
        return res.status(400).json({ error: "Effort level must be a number from 1 to 5" });
      }
      task.effortLevel = parsedEffortLevel;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "isBigThree")) {
      if (typeof req.body.isBigThree !== "boolean") {
        return res.status(400).json({ error: "isBigThree must be a boolean value" });
      }

      const nextIsBigThree = req.body.isBigThree;
      if (nextIsBigThree && !task.isBigThree) {
        const existingBigThreeCount = await Task.countDocuments({
          userId: req.user.id,
          isBigThree: true,
          _id: { $ne: task._id }
        });

        if (existingBigThreeCount >= 3) {
          return res.status(400).json({ error: "You can only have 3 Big 3 tasks at once." });
        }
      }

      task.isBigThree = nextIsBigThree;
    }

    await task.save();
    return res.json(task);
  } catch (err) {
    console.error("Error updating task:", err);
    return res.status(500).json({ error: "Server error while updating task" });
  }
});

// Route to delete a task
app.delete("/tasks/:taskId", ensureAuthenticated, async (req, res) => {
  try {
    const deleted = await Task.findOneAndDelete({
      _id: req.params.taskId,
      userId: req.user.id, // important: only delete your own tasks
    });

    if (!deleted) {
      return res.status(404).json({ error: "Task not found" });
    }

    return res.json({ message: "Task deleted successfully" });
    fetchTasks(); // Refresh the task list on the client side
  } catch (err) {
    console.error("Error deleting task:", err);
    return res.status(500).json({ error: "Server error while deleting task" });
  }
});

// Start a focus session for a task
app.post("/focus-sessions/start", ensureAuthenticated, async (req, res) => {
  try {
    const taskId = String(req.body.taskId || "").trim();
    if (!taskId) {
      return res.status(400).json({ error: "taskId is required" });
    }
    if (!/^[a-f\d]{24}$/i.test(taskId)) {
      return res.status(400).json({ error: "Invalid taskId format" });
    }

    const task = await Task.findOne({ _id: taskId, userId: req.user.id });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    if (task.status !== "active") {
      return res.status(400).json({ error: "Only active tasks can be focused." });
    }

    const now = new Date();

    // Ensure one running session per user.
    const openSession = await FocusSession.findOne({
      userId: req.user.id,
      endedAt: null
    }).sort({ startedAt: -1 });

    if (openSession) {
      openSession.endedAt = now;
      openSession.durationMs = Math.max(0, now.getTime() - new Date(openSession.startedAt).getTime());
      openSession.endedReason = "manual_stop";
      await openSession.save();
    }

    const created = await FocusSession.create({
      userId: req.user.id,
      taskId: task._id,
      startedAt: now
    });

    const session = await FocusSession.findById(created._id).populate({
      path: "taskId",
      select: "description"
    });

    return res.status(201).json(toFocusSessionResponse(session));
  } catch (err) {
    console.error("Error starting focus session:", err);
    return res.status(500).json({ error: "Server error while starting focus session" });
  }
});

// Stop the active focus session
app.post("/focus-sessions/stop", ensureAuthenticated, async (req, res) => {
  try {
    const validReasons = new Set(["completed_task", "manual_stop", "timeout", "app_closed"]);
    const requestedReason = String(req.body.reason || "manual_stop");
    const endedReason = validReasons.has(requestedReason) ? requestedReason : "manual_stop";

    const openSession = await FocusSession.findOne({
      userId: req.user.id,
      endedAt: null
    }).sort({ startedAt: -1 });

    if (!openSession) {
      return res.status(404).json({ error: "No active focus session to stop." });
    }

    const endedAt = new Date();
    openSession.endedAt = endedAt;
    openSession.durationMs = Math.max(0, endedAt.getTime() - new Date(openSession.startedAt).getTime());
    openSession.endedReason = endedReason;
    await openSession.save();

    const session = await FocusSession.findById(openSession._id).populate({
      path: "taskId",
      select: "description"
    });

    return res.json(toFocusSessionResponse(session));
  } catch (err) {
    console.error("Error stopping focus session:", err);
    return res.status(500).json({ error: "Server error while stopping focus session" });
  }
});

// Query focus sessions by date range (used by reflections)
app.get("/focus-sessions", ensureAuthenticated, async (req, res) => {
  try {
    const from = parseIsoDateTimeInput(req.query.from);
    const to = parseIsoDateTimeInput(req.query.to);

    if (req.query.from && !from) {
      return res.status(400).json({ error: "Invalid from date" });
    }
    if (req.query.to && !to) {
      return res.status(400).json({ error: "Invalid to date" });
    }
    if (from && to && from >= to) {
      return res.status(400).json({ error: "from must be earlier than to" });
    }

    const query = { userId: req.user.id };
    if (from || to) {
      query.startedAt = {};
      if (from) query.startedAt.$gte = from;
      if (to) query.startedAt.$lt = to;
    }

    const sessions = await FocusSession.find(query)
      .sort({ startedAt: -1 })
      .populate({ path: "taskId", select: "description" });

    return res.json(sessions.map((session) => toFocusSessionResponse(session)));
  } catch (err) {
    console.error("Error retrieving focus sessions:", err);
    return res.status(500).json({ error: "Server error while retrieving focus sessions" });
  }
});






app.get("/settings/daily-email", authenticatedLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("settings.dailyEmail settings.dailyEmailTime");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      dailyEmail: user.settings?.dailyEmail !== false,
      dailyEmailTime: isValidTimeInput(user.settings?.dailyEmailTime)
        ? user.settings.dailyEmailTime
        : "18:00",
    });
  } catch (error) {
    console.error("Error loading daily email settings:", error);
    return res.status(500).json({ error: "Unable to load daily email settings" });
  }
});

app.put("/settings/daily-email", authenticatedLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const dailyEmail = Boolean(req.body.dailyEmail);
    const requestedTime = String(req.body.dailyEmailTime || "").trim();
    const dailyEmailTime = isValidTimeInput(requestedTime) ? requestedTime : "18:00";

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          "settings.dailyEmail": dailyEmail,
          "settings.dailyEmailTime": dailyEmailTime,
        },
      },
      { new: true, runValidators: true }
    ).select("settings.dailyEmail settings.dailyEmailTime");

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      message: "Daily email settings updated",
      dailyEmail: updatedUser.settings?.dailyEmail !== false,
      dailyEmailTime: updatedUser.settings?.dailyEmailTime || "18:00",
    });
  } catch (error) {
    console.error("Error saving daily email settings:", error);
    return res.status(500).json({ error: "Unable to save daily email settings" });
  }
});

app.post("/settings/daily-email/test", authenticatedLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email firstName settings.dailyEmail");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.settings?.dailyEmail === false) {
      return res.status(403).json({
        error: 'Unable to send daily reflection. Turn on "Daily Reflection" in settings to receive daily reflection emails.',
      });
    }

    const emailData = await buildDailyReflectionEmailData(req.user.id);
    await sendDailyReflectionEmail(user, emailData);

    return res.json({ message: "Daily reflection test email sent" });
  } catch (error) {
    console.error("Error sending daily reflection test email:", error);
    return res.status(500).json({ error: "Unable to send daily reflection test email" });
  }
});

app.post("/feedback/report-bug", authenticatedLimiter, ensureAuthenticated, feedbackSubmissionLimiter, async (req, res) => {
  try {
    const subject = String(req.body?.subject || "").trim();
    const message = String(req.body?.message || "").trim();
    const incomingAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const MAX_ATTACHMENTS = 3;
    const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

    if (subject.length < 5 || subject.length > 120) {
      return res.status(400).json({ error: "Bug summary must be between 5 and 120 characters." });
    }

    if (message.length < 10 || message.length > 2000) {
      return res.status(400).json({ error: "Bug details must be between 10 and 2000 characters." });
    }

    if (incomingAttachments.length > MAX_ATTACHMENTS) {
      return res.status(400).json({ error: "You can attach up to 3 images per bug report." });
    }

    const attachments = [];
    let totalAttachmentBytes = 0;
    const feedbackReportId = new FeedbackReport()._id;

    for (const attachment of incomingAttachments) {
      const filename = String(attachment?.filename || "").trim();
      const contentType = String(attachment?.contentType || "").trim().toLowerCase();
      const base64Data = String(attachment?.base64Data || "").trim();

      if (!filename || !contentType || !base64Data) {
        return res.status(400).json({ error: "Each attachment must include a file name, type, and image data." });
      }

      if (!contentType.startsWith("image/")) {
        return res.status(400).json({ error: "Only image attachments are supported in bug reports." });
      }

      const fileBuffer = Buffer.from(base64Data, "base64");
      if (!fileBuffer.length) {
        return res.status(400).json({ error: `Attachment "${filename}" is empty or invalid.` });
      }

      if (fileBuffer.length > MAX_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: `Attachment "${filename}" exceeds the 5 MB file size limit.` });
      }

      totalAttachmentBytes += fileBuffer.length;
      attachments.push({
        filename,
        contentType,
        sizeBytes: fileBuffer.length,
        content: base64Data,
      });
    }

    const user = await User.findById(req.user.id).select("firstName lastName email");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const cooldownWindowMs = FEEDBACK_MIN_SECONDS_BETWEEN_REPORTS * 1000;

    const [recentHourlyCount, lastFeedbackReport] = await Promise.all([
      FeedbackReport.countDocuments({
        userId: user._id,
        createdAt: { $gte: oneHourAgo },
      }),
      FeedbackReport.findOne({ userId: user._id }).sort({ createdAt: -1 }).select("createdAt"),
    ]);

    if (recentHourlyCount >= FEEDBACK_HOURLY_LIMIT) {
      return res.status(429).json({
        error: `Too many bug reports. Please try again later.`,
      });
    }

    if (lastFeedbackReport?.createdAt) {
      const elapsedMs = now.getTime() - new Date(lastFeedbackReport.createdAt).getTime();
      if (elapsedMs < cooldownWindowMs) {
        const waitSeconds = Math.ceil((cooldownWindowMs - elapsedMs) / 1000);
        return res.status(429).json({
          error: `Please wait ${waitSeconds} second(s) before sending another bug report.`,
        });
      }
    }

    await sendBugFeedbackEmail({
      user,
      subject,
      message,
      attachments,
      requestMeta: {
        ip: req.ip,
        userAgent: req.get("user-agent"),
        feedbackReportId: feedbackReportId.toString(),
      },
    });

    await FeedbackReport.create({
      _id: feedbackReportId,
      userId: user._id,
      subject,
      message,
      attachmentCount: attachments.length,
      attachmentBytes: totalAttachmentBytes,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      message: "Bug report sent",
      fromEmail: user.email,
    });
  } catch (error) {
    console.error("Error sending bug feedback email:", error);
    return res.status(500).json({ error: error?.message || "Unable to send bug report right now." });
  }
});

app.get("/settings/board-preferences", authenticatedLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("settings.board.defaultTaskSort settings.board.defaultView");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      board: {
        default_task_sort: normalizeBoardTaskSort(user.settings?.board?.defaultTaskSort),
        default_view: normalizeBoardDefaultView(user.settings?.board?.defaultView),
      },
    });
  } catch (error) {
    console.error("Error loading board preferences:", error);
    return res.status(500).json({ error: "Unable to load board preferences" });
  }
});

app.put("/settings/board-preferences", authenticatedLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const defaultTaskSort = normalizeBoardTaskSort(req.body?.board?.default_task_sort);
    const defaultView = normalizeBoardDefaultView(req.body?.board?.default_view);

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          "settings.board.defaultTaskSort": defaultTaskSort,
          "settings.board.defaultView": defaultView,
        },
      },
      { new: true, runValidators: true }
    ).select("settings.board.defaultTaskSort settings.board.defaultView");

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      message: "Board preferences updated",
      board: {
        default_task_sort: normalizeBoardTaskSort(updatedUser.settings?.board?.defaultTaskSort),
        default_view: normalizeBoardDefaultView(updatedUser.settings?.board?.defaultView),
      },
    });
  } catch (error) {
    console.error("Error saving board preferences:", error);
    return res.status(500).json({ error: "Unable to save board preferences" });
  }
});


// Route to check user authentication status
app.get("/auth-status", (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });

  return res.json({
    loggedIn: true,
    user: {
      id: req.user._id,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      email: req.user.email,
      settings: {
        board: {
          default_task_sort: normalizeBoardTaskSort(req.user.settings?.board?.defaultTaskSort),
          default_view: normalizeBoardDefaultView(req.user.settings?.board?.defaultView),
        },
      },
    },
  });
});


// Serve other static files dynamically
app.get("/:file", (req, res) => {
    const filename = path.join(__dirname, "public", req.params.file);
    if (fs.existsSync(filename)) {
        res.type(mime.getType(filename));
        res.sendFile(filename);
    } else {
        res.status(404).send("404 Error: File Not Found");
    }
});

if (SHOULD_RUN_DAILY_REFLECTION_SCHEDULER || (!IS_VERCEL_RUNTIME && require.main === module)) {
  startDailyReflectionScheduler();
} else {
  console.log("Daily reflection scheduler disabled for this environment.");
}

if (require.main === module) {
    // Only execute when this file is run directly (local dev)

    // Start the Express server
    app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    });
}

// Always export for Vercel
module.exports = app;
