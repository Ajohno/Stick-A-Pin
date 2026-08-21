const { calculateElapsedMs } = require("../public/js/duration-utils");

function safePauseDuration(pausedAt, now) {
  const paused = new Date(pausedAt).getTime();
  const ended = new Date(now).getTime();
  return Number.isFinite(paused) && Number.isFinite(ended)
    ? Math.max(0, ended - paused)
    : 0;
}

function finalizeFocusSession(session, endedAt = new Date(), endedReason = "manual_stop") {
  if (session.pausedAt) {
    session.totalPausedMs = Math.max(0, Number(session.totalPausedMs) || 0)
      + safePauseDuration(session.pausedAt, endedAt);
    session.pausedAt = null;
  }
  session.endedAt = endedAt;
  session.durationMs = calculateElapsedMs({
    startedAt: session.startedAt,
    pausedAt: endedAt,
    totalPausedMs: session.totalPausedMs,
  }, endedAt);
  session.endedReason = endedReason;
  return session;
}

module.exports = { finalizeFocusSession, safePauseDuration };
