function createPasswordResetHandler({
  User,
  bcrypt,
  validatePasswordStrength,
  hashVerificationToken,
  logger = console,
}) {
  return async (req, res) => {
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

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const user = await User.findOneAndUpdate(
        {
          // This ensures that we only process password reset requests for users who have a password set (i.e., not OAuth-only users).
          email: normalizedEmail,
          passwordHash: { $type: "string", $ne: "" },
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { $gt: new Date() },
        },
        {
          $set: {
            passwordHash,
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
            passwordResetRequestedAt: null,
          },
          $inc: { authVersion: 1 },
        },
        { new: true, runValidators: true },
      );

      if (!user) {
        return res.status(400).json({ error: "This password reset link is invalid or expired." });
      }

      // Record the session revocation completed by the database update above.
      logger.info(JSON.stringify({
        event: "password_reset_sessions_revoked",
        timestamp: new Date().toISOString(),
        userId: String(user._id),
        reason: "password_reset",
        authVersion: user.authVersion,
      }));

      return res.json({ message: "Password reset successful. You can now log in." });
    } catch (error) {
      logger.error("Error resetting password");
      return res.status(500).json({ error: "Unable to reset password" });
    }
  };
}

module.exports = { createPasswordResetHandler };
