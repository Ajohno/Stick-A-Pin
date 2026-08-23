const { waitUntil } = require("@vercel/functions");

/**
 * Keep post-response work alive on Vercel and always attach a rejection handler.
 * Outside Vercel, the guarded promise remains attached to Node's event loop.
 */
function scheduleBackgroundTask(
  taskPromise,
  { failureMessage = "Background task failed", logger = console } = {}
) {
  const guardedPromise = Promise.resolve(taskPromise).catch(() => {
    logger.error(failureMessage);
  });

  if (String(process.env.VERCEL || "").trim() === "1") {
    try {
      waitUntil(guardedPromise);
    } catch (error) {
      // The durable job can still be recovered by the scheduled retry sweep.
      logger.error("Unable to register Vercel background task");
    }
  }

  return guardedPromise;
}

module.exports = { scheduleBackgroundTask };
