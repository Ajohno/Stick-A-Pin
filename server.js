const express = require("express");
const fs = require("fs");
const mime = require("mime");
const path = require("path");
const crypto = require("crypto");
const connectDB = require("./config/database"); // Connects to MongoDB
const session = require("express-session"); // Handles sessions for logged-in users
const passport = require("passport"); // Middleware for authentication
const bcrypt = require("bcryptjs"); // Used to hash passwords
const User = require("./config/models/user"); // User model for the database
const Task = require("./config/models/task"); // Task model for the database
const FocusSession = require("./config/models/focusSession"); // FocusSession model for tracking focus sessions
const rateLimit = require("express-rate-limit"); // Rate limiting middleware
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
    console.error("Database unavailable for request", error);
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
});

// Middleware -----------------------------------------------------------------------------------

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

function resolveBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/$/, "");
  }

  const forwardedProto = req?.headers?.["x-forwarded-proto"];
  const protocol = (forwardedProto ? forwardedProto.split(",")[0] : req?.protocol || "http").trim();
  const host = req?.get?.("host") || req?.headers?.host;

  if (host) {
    return `${protocol}://${host}`.replace(/\/$/, "");
  }

  return `http://localhost:${port}`;
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

function getTodayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function buildDailyReflectionEmailData(userId) {
  const { start, end } = getTodayBounds();

  const [completedToday, tasksCreatedToday, sessionsToday] = await Promise.all([
    Task.find({
      userId,
      status: "completed",
      completedAt: { $gte: start, $lt: end },
    }).sort({ completedAt: 1 }),
    Task.countDocuments({
      userId,
      createdAt: { $gte: start, $lt: end },
    }),
    FocusSession.find({
      userId,
      startedAt: { $gte: start, $lt: end },
      durationMs: { $gt: 0 },
    }).select("durationMs"),
  ]);

  const totalFocusMs = sessionsToday.reduce((sum, session) => sum + (Number(session.durationMs) || 0), 0);
  const completionRate = tasksCreatedToday > 0
    ? Math.round((completedToday.length / tasksCreatedToday) * 100)
    : 0;

  const completedTaskNames = completedToday.map((task) => {
    const title = String(task.title || "").trim();
    return title || String(task.description || "").trim() || "Untitled task";
  });

  return {
    completedTaskNames,
    totalFocusMs,
    completionRate,
    dateLabel: start.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
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
        <p>Here is your daily reflection for ${escapeHtml(emailData.dateLabel)}.</p>
        <p><strong>Completed tasks:</strong></p>
        ${tasksHtml}
        <p><strong>Total focus time:</strong> ${escapeHtml(formatDurationFromMs(emailData.totalFocusMs))}</p>
        <p><strong>Task completion rate:</strong> ${escapeHtml(String(emailData.completionRate))}%</p>
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


app.use(passport.initialize());
app.use(passport.session()); // Enables persistent login sessions

app.use(express.json()); // Middleware to parse JSON request body
app.use(express.urlencoded({ extended: false })); // Parses form data

// Serve static files from the "public" directory
app.use(express.static("public"));

// ROUTES -----------------------------------------------------------------------------------

// Rate limiter for email verification-related routes
const emailVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per window for verification actions
  standardHeaders: true,
  legacyHeaders: false,
});

// Register Route
app.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) return res.status(400).json({ error: "Email already exists" });

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

app.post("/forgot-password", passwordResetLimiter, async (req, res) => {
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
app.post("/login", (req, res, next) => {
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
          user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email },
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






app.get("/settings/daily-email", ensureAuthenticated, async (req, res) => {
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

app.put("/settings/daily-email", ensureAuthenticated, async (req, res) => {
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

app.post("/settings/daily-email/test", ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email firstName");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const emailData = await buildDailyReflectionEmailData(req.user.id);
    await sendDailyReflectionEmail(user, emailData);

    return res.json({ message: "Daily reflection test email sent" });
  } catch (error) {
    console.error("Error sending daily reflection test email:", error);
    return res.status(500).json({ error: "Unable to send daily reflection test email" });
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

if (require.main === module) {
    // Only execute when this file is run directly (local dev)

    // Start the Express server
    app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    });
}

// Always export for Vercel
module.exports = app;
