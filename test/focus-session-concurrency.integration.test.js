const test = require("node:test");
const assert = require("node:assert/strict");

const TEST_MONGO_URI = process.env.TEST_MONGO_URI;

test("focus-session transitions remain atomic under concurrent writes", {
  skip: !TEST_MONGO_URI,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production", "never run against production");
  assert.notEqual(TEST_MONGO_URI, process.env.MONGO_URI, "TEST_MONGO_URI must be isolated");

  const mongoose = require("mongoose");
  const FocusSession = require("../config/models/focusSession");
  const { buildResumePipeline, buildStopPipeline } = require("../config/focus-session-atomic");
  await mongoose.connect(TEST_MONGO_URI, { autoIndex: false });
  await FocusSession.collection.drop().catch((error) => {
    if (error.codeName !== "NamespaceNotFound") throw error;
  });
  await FocusSession.collection.createIndex(
    { userId: 1 },
    { name: "uniq_open_focus_session_per_user", unique: true, partialFilterExpression: { endedAt: null } },
  );

  try {
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    const task = new mongoose.Types.ObjectId();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const create = () => FocusSession.create({ userId: userA, taskId: task, startedAt: start });
    const starts = await Promise.allSettled([create(), create()]);
    assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(starts.find((result) => result.status === "rejected").reason.code, 11000);
    assert.equal(await FocusSession.countDocuments({ userId: userA, endedAt: null }), 1);

    const pausedAt = new Date("2026-01-01T00:10:00.000Z");
    await FocusSession.updateOne({ userId: userA, endedAt: null }, { $set: { pausedAt } });
    const resumeAt = new Date("2026-01-01T00:25:00.000Z");
    const resume = () => FocusSession.findOneAndUpdate(
      { userId: userA, endedAt: null, pausedAt: { $type: "date" } },
      buildResumePipeline(resumeAt),
      { new: true },
    );
    const resumes = await Promise.all([resume(), resume()]);
    assert.equal(resumes.filter(Boolean).length, 1);
    const resumed = await FocusSession.findOne({ userId: userA, endedAt: null });
    assert.equal(resumed.totalPausedMs, 15 * 60_000);

    const stopAt = new Date("2026-01-01T00:45:00.000Z");
    const pause = FocusSession.findOneAndUpdate(
      { userId: userA, endedAt: null, pausedAt: null },
      { $set: { pausedAt: stopAt } },
      { new: true },
    );
    const stop = FocusSession.findOneAndUpdate(
      { userId: userA, endedAt: null },
      buildStopPipeline(stopAt, "manual_stop"),
      { new: true },
    );
    await Promise.all([pause, stop]);
    const completed = await FocusSession.findById(resumed._id);
    assert.ok(completed.endedAt);
    assert.equal(completed.pausedAt, null);
    assert.equal(completed.totalPausedMs, 15 * 60_000);
    const finalizedDuration = completed.durationMs;
    assert.equal(await FocusSession.findOneAndUpdate(
      { userId: userA, endedAt: null },
      buildStopPipeline(new Date("2026-01-01T01:00:00.000Z"), "manual_stop"),
      { new: true },
    ), null);
    assert.equal((await FocusSession.findById(resumed._id)).durationMs, finalizedDuration);

    await FocusSession.create({ userId: userB, taskId: task, startedAt: start });
    assert.equal(await FocusSession.findOne({ userId: userA, _id: { $ne: completed._id }, endedAt: null }), null);
    assert.equal(await FocusSession.findOneAndUpdate(
      { userId: userA, _id: (await FocusSession.findOne({ userId: userB }))._id, endedAt: null },
      { $set: { pausedAt: new Date() } },
    ), null);
  } finally {
    await FocusSession.collection.drop();
    await mongoose.disconnect();
  }
});
