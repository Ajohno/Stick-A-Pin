const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FOCUS_STATE_CONFLICT,
  openFocusSessionFilter,
  buildStopPipeline,
  buildResumePipeline,
} = require("../config/focus-session-atomic");

test("all atomic transitions share a user-scoped open-session filter and conflict", () => {
  assert.deepEqual(openFocusSessionFilter("user-a"), { userId: "user-a", endedAt: null });
  assert.deepEqual(FOCUS_STATE_CONFLICT, {
    error: "Focus session state changed or is not valid for this action.",
  });
});

test("stop pipeline finalizes and clears pause in one conditional update", () => {
  const now = new Date("2026-01-01T00:45:00.000Z");
  const pipeline = buildStopPipeline(now, "manual_stop");
  assert.equal(pipeline[0].$set.endedAt, now);
  assert.equal(pipeline[0].$set.pausedAt, null);
  assert.equal(pipeline[0].$set.endedReason, "manual_stop");
  assert.ok(pipeline[0].$set.totalPausedMs.$add);
  assert.ok(pipeline[1].$set.durationMs.$max);
});

test("resume pipeline increments paused time and clears pausedAt together", () => {
  const now = new Date("2026-01-01T00:25:00.000Z");
  const pipeline = buildResumePipeline(now);
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].$set.pausedAt, null);
  assert.ok(pipeline[0].$set.totalPausedMs.$add);
});
