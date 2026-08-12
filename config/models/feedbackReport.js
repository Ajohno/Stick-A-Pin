/**
 * Durable record of an authenticated bug report submitted through StickAPin.
 * Attachment metadata is stored here; file content is delivered through email.
 */
const mongoose = require("mongoose");

const FeedbackReportSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    attachmentCount: { type: Number, default: 0, min: 0, max: 3 },
    attachmentBytes: { type: Number, default: 0, min: 0 },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true }
);

// Supports per-user history and durable submission-rate checks in newest-first order.
FeedbackReportSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("FeedbackReport", FeedbackReportSchema);
