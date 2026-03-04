const mongoose = require('mongoose');

// Records a single uninterrupted focus block on a task.
// This event log will help to power daily an dweekly reflections.
const FocusSessionSchema = new mongoose.Schema({

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },

    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },

    // This is stored at stop time so the analytics are cheap and stable
    durationMs: { type: Number, default: 0 },


    // The reason for stopping the focus session. This is used to power reflections and analytics.
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