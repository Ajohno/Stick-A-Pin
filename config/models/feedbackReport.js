const mongoose = require("mongoose");

const FeedbackReportSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true }
);

FeedbackReportSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("FeedbackReport", FeedbackReportSchema);
