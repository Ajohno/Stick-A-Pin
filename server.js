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
const MongoStore = require("connect-mongo").default; // Store sessions in MongoDB


require("dotenv").config(); // Loads environment variables
require("./config/passport-config")(passport); // Configures Passport authentication

const app = express();
const port = process.env.PORT || 3000;
const REMEMBER_ME_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MINUTES = Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES || 60);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${port}`;
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

async function sendVerificationEmail(email, firstName, token) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const verificationUrl = `${APP_BASE_URL}/verify-email?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

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

    await sendVerificationEmail(normalizedEmail, firstName.trim(), verificationToken);

    return res.status(201).json({ message: "Registration successful. Check your email to verify your account." });
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

app.get("/verify-email", async (req, res) => {
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

    return res.status(200).send("Email verified successfully. You can now log in.");
  } catch (error) {
    console.error("Error verifying email:", error);
    return res.status(500).send("Server error while verifying email.");
  }
});

app.post("/resend-verification", async (req, res) => {
  try {
    const normalizedEmail = (req.body.email || "").toLowerCase().trim();
    if (!normalizedEmail) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.json({ message: "If that account exists, a verification email has been sent." });
    }

    if (user.emailVerified) {
      return res.json({ message: "Your email is already verified." });
    }

    const verificationToken = generateVerificationToken();
    user.emailVerificationTokenHash = hashVerificationToken(verificationToken);
    user.emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000);
    await user.save();

    await sendVerificationEmail(user.email, user.firstName, verificationToken);

    return res.json({ message: "Verification email sent." });
  } catch (error) {
    console.error("Error resending verification email:", error);
    return res.status(500).json({ error: "Unable to resend verification email" });
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
