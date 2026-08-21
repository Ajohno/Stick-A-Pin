(function exposeDurationUtils(root, factory) {
  const utils = factory();
  if (typeof module === "object" && module.exports) module.exports = utils;
  if (root) root.DurationUtils = utils;
})(typeof globalThis === "object" ? globalThis : this, function createDurationUtils() {
  function safeMilliseconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function timestamp(value) {
    if (value === null || value === undefined || value === "") return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function calculateElapsedMs(session, now = Date.now()) {
    if (!session || typeof session !== "object") return 0;
    if (session.endedAt) return safeMilliseconds(session.durationMs);

    const start = timestamp(session.startedAt);
    const end = timestamp(session.pausedAt) ?? timestamp(now);
    if (start === null || end === null) return 0;
    return Math.max(0, end - start - safeMilliseconds(session.totalPausedMs));
  }

  function sumDurationMs(sessions) {
    if (!Array.isArray(sessions)) return 0;
    return sessions.reduce((total, session) => {
      const duration = typeof session === "object"
        ? calculateElapsedMs(session)
        : safeMilliseconds(session);
      return total + duration;
    }, 0);
  }

  function formatDuration(durationMs) {
    const safe = safeMilliseconds(durationMs);
    if (safe === 0) return "0 min";
    if (safe < 1000) return "<1 sec";

    const totalSeconds = Math.floor(safe / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours) parts.push(`${hours} hr`);
    if (minutes) parts.push(`${minutes} min`);
    if (seconds) parts.push(`${seconds} sec`);
    return parts.join(" ");
  }

  function formatTimer(durationMs) {
    const totalSeconds = Math.floor(safeMilliseconds(durationMs) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return { calculateElapsedMs, sumDurationMs, formatDuration, formatTimer };
});
