const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateElapsedMs,
  sumDurationMs,
  formatDuration,
  formatTimer,
} = require("../public/js/duration-utils");
const { finalizeFocusSession } = require("../config/focus-session-time");

test("formatDuration applies one precise policy at boundaries", () => {
  const cases = [
    [0, "0 min"], [-1, "0 min"], [NaN, "0 min"], [Infinity, "0 min"],
    [1, "<1 sec"], [999, "<1 sec"], [1000, "1 sec"],
    [29_999, "29 sec"], [30_000, "30 sec"], [59_999, "59 sec"],
    [60_000, "1 min"], [75_000, "1 min 15 sec"], [90_000, "1 min 30 sec"],
    [3_600_000, "1 hr"], [3_901_000, "1 hr 5 min 1 sec"],
  ];
  cases.forEach(([input, expected]) => assert.equal(formatDuration(input), expected));
  assert.equal(formatTimer(3_661_000), "61:01");
});

test("sessions are totaled in exact milliseconds before formatting", () => {
  const total = sumDurationMs([
    { endedAt: new Date(1), durationMs: 30_500 },
    { endedAt: new Date(1), durationMs: 44_500 },
  ]);
  assert.equal(total, 75_000);
  assert.equal(formatDuration(total), "1 min 15 sec");
});

test("calculateElapsedMs handles running, paused, legacy, malformed and finalized sessions", () => {
  const minute = 60_000;
  assert.equal(calculateElapsedMs({ startedAt: 0 }, 10 * minute), 10 * minute);
  assert.equal(calculateElapsedMs({ startedAt: 0, totalPausedMs: 15 * minute }, 45 * minute), 30 * minute);
  assert.equal(calculateElapsedMs({ startedAt: 0, totalPausedMs: 20 * minute }, 50 * minute), 30 * minute);
  assert.equal(calculateElapsedMs({ startedAt: 0, pausedAt: 10 * minute, totalPausedMs: 0 }, 45 * minute), 10 * minute);
  assert.equal(calculateElapsedMs({ startedAt: "bad" }, 10 * minute), 0);
  assert.equal(calculateElapsedMs({ startedAt: 20, pausedAt: 10 }, 30), 0);
  assert.equal(calculateElapsedMs({ startedAt: 0, endedAt: 100, durationMs: 42 }), 42);
});

test("finalizing a running session excludes completed pauses", () => {
  const session = { startedAt: new Date(0), totalPausedMs: 15 * 60_000, pausedAt: null };
  finalizeFocusSession(session, new Date(45 * 60_000), "manual_stop");
  assert.equal(session.durationMs, 30 * 60_000);
});

test("stopping while paused closes the pause and excludes it", () => {
  const session = {
    startedAt: new Date(0),
    pausedAt: new Date(10 * 60_000),
    totalPausedMs: 0,
  };
  finalizeFocusSession(session, new Date(45 * 60_000), "completed_task");
  assert.equal(session.totalPausedMs, 35 * 60_000);
  assert.equal(session.durationMs, 10 * 60_000);
  assert.equal(session.pausedAt, null);
  assert.equal(session.endedReason, "completed_task");
});

test("pause 10, resume 25, stop 45 yields 30 active minutes", () => {
  const session = { startedAt: new Date(0), pausedAt: null, totalPausedMs: 15 * 60_000 };
  finalizeFocusSession(session, new Date(45 * 60_000));
  assert.equal(session.durationMs, 30 * 60_000);
});
