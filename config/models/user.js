const mongoose = require("mongoose");

// The fields for a user in the database
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

    authProviders: {
      google: {
        id: { type: String, default: null },
        email: { type: String, default: null, lowercase: true, trim: true },
      },
      apple: {
        id: { type: String, default: null },
        email: { type: String, default: null, lowercase: true, trim: true },
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

    settings: {
      rememberMe: { type: Boolean, default: false },
      dailyEmail: { type: Boolean, default: true },
      dailyEmailTime: { type: String, default: "18:00" },
      dailyEmailLastSentOn: { type: String, default: null },
      weeklyEmail: { type: Boolean, default: true },
      timezone: { type: String, default: "America/Jamaica" },
    },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.index({ "authProviders.google.id": 1 }, { unique: true, sparse: true });
UserSchema.index({ "authProviders.apple.id": 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("User", UserSchema);
