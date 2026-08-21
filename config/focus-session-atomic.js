const FOCUS_STATE_CONFLICT = Object.freeze({
  error: "Focus session state changed or is not valid for this action.",
});

const openFocusSessionFilter = (userId) => ({ userId, endedAt: null });

function buildStopPipeline(now, endedReason) {
  return [{
    $set: {
      totalPausedMs: {
        $add: [
          { $max: [0, { $ifNull: ["$totalPausedMs", 0] }] },
          { $cond: [
            { $eq: [{ $type: "$pausedAt" }, "date"] },
            { $max: [0, { $subtract: [now, "$pausedAt"] }] },
            0,
          ] },
        ],
      },
      endedAt: now,
      pausedAt: null,
      endedReason,
      updatedAt: now,
    },
  }, {
    $set: {
      durationMs: {
        $max: [0, { $subtract: [{ $subtract: [now, "$startedAt"] }, "$totalPausedMs"] }],
      },
    },
  }];
}

function buildResumePipeline(now) {
  return [{ $set: {
    totalPausedMs: {
      $add: [
        { $max: [0, { $ifNull: ["$totalPausedMs", 0] }] },
        { $max: [0, { $subtract: [now, "$pausedAt"] }] },
      ],
    },
    pausedAt: null,
    updatedAt: now,
  } }];
}

module.exports = {
  FOCUS_STATE_CONFLICT,
  openFocusSessionFilter,
  buildStopPipeline,
  buildResumePipeline,
};
