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

    passwordHash: { type: String, required: true },

    emailVerified: { type: Boolean, default: true },
    emailVerificationTokenHash: { type: String, default: null },
    emailVerificationExpiresAt: { type: Date, default: null },
    emailVerifiedAt: { type: Date, default: null },

    settings: {
      rememberMe: { type: Boolean, default: false },
      dailyEmail: { type: Boolean, default: true },
      weeklyEmail: { type: Boolean, default: true },
      timezone: { type: String, default: "America/Jamaica" },
    },

    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
