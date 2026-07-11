const mongoose = require('mongoose');

/**
 * Records one uninterrupted focus block for a task.
 * Sessions form an event log used by daily and weekly reflection analytics.
 */
const FocusSessionSchema = new mongoose.Schema({

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },

    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },

    // Persist the calculated duration at stop time so historical analytics stay
    // stable and do not need to recompute each session on every request.
    durationMs: { type: Number, default: 0 },


    // The stop reason distinguishes completed work from manual or lifecycle stops.
    endedReason: {
        type: String,
        enum: ["completed_task", "manual_stop", "timeout", "app_closed"],
        default: "manual_stop",
    },
},
    { timestamps: true }
);

// Indexes to optimize queries for user focus sessions, especially when filtering by time and task.
FocusSessionSchema.index({ userId: 1, startedAt: -1 });
FocusSessionSchema.index({ userId: 1, taskId: 1, startedAt: -1 });
FocusSessionSchema.index({ userId: 1, endedAt: 1 });

module.exports = mongoose.model("FocusSession", FocusSessionSchema);
