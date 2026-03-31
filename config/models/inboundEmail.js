const mongoose = require("mongoose");

const InboundEmailSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, trim: true },
    emailId: { type: String, required: true, trim: true, index: true },
    messageId: { type: String, default: null, trim: true },
    from: { type: String, default: null, trim: true },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },
    subject: { type: String, default: null },
    createdAtProvider: { type: Date, default: null },
    text: { type: String, default: null },
    html: { type: String, default: null },
    attachments: { type: Array, default: [] },
    rawEvent: { type: Object, default: {} },
  },
  { timestamps: true }
);

InboundEmailSchema.index({ createdAt: -1 });

module.exports = mongoose.model("InboundEmail", InboundEmailSchema);
