const mongoose = require("mongoose");

/**
 * Account identity, authentication state, and user-level application settings.
 * Password and verification/reset tokens are stored only as hashes; OAuth
 * provider identifiers are kept separately so login methods can share one user.
 */
const UserSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    passwordHash: { type: String, default: null },

    // Provider records allow a social login to be linked to the same email account.
    authProviders: {
      google: {
        id: { type: String, default: undefined },
        email: { type: String, default: undefined, lowercase: true, trim: true },
      },
    },

    avatarUrl: { type: String, default: null },

    emailVerified: { type: Boolean, default: true },
    emailVerificationTokenHash: { type: String, default: null },
    emailVerificationExpiresAt: { type: Date, default: null },
    emailVerifiedAt: { type: Date, default: null },

    passwordResetTokenHash: { type: String, default: null },
    passwordResetExpiresAt: { type: Date, default: null },
    passwordResetRequestedAt: { type: Date, default: null },

    // Nested defaults make newly introduced preferences safe for existing users.
    settings: {
      rememberMe: { type: Boolean, default: false },
      dailyEmail: { type: Boolean, default: true },
      dailyEmailTime: { type: String, default: "18:00" },
      dailyEmailLastSentOn: { type: String, default: null },
      weeklyEmail: { type: Boolean, default: true },
      timezone: { type: String, default: "America/Jamaica" },
      board: {
        defaultTaskSort: {
          type: String,
          enum: ["created_date", "effort_level", "due_date"],
          default: "created_date",
        },
        defaultView: {
          type: String,
          enum: ["board", "calendar"],
          default: "board",
        },
      },
    },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// The partial unique index ignores local-only accounts where no Google ID exists.
UserSchema.index(
  { "authProviders.google.id": 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { "authProviders.google.id": { $type: "string" } },
  }
);
module.exports = mongoose.model("User", UserSchema);
