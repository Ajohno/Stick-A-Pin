#!/usr/bin/env node
const mongoose = require("mongoose");
const { calculateElapsedMs } = require("../public/js/duration-utils");

const INDEX_NAME = "uniq_open_focus_session_per_user";
const apply = process.argv.includes("--apply");
const createIndex = process.argv.includes("--create-index");

function validDate(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (apply && process.env.NODE_ENV === "production" && process.env.ALLOW_PRODUCTION_FOCUS_REPAIR !== "1") {
    throw new Error("Production repair requires ALLOW_PRODUCTION_FOCUS_REPAIR=1");
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const collection = mongoose.connection.collection("focussessions");
  const duplicates = await collection.aggregate([
    { $match: { endedAt: null } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $group: { _id: "$userId", sessions: { $push: "$$ROOT" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  const repairs = [];
  for (const group of duplicates) {
    const [kept, ...closed] = group.sessions;
    for (const session of closed) {
      const startedAt = validDate(session.startedAt, new Date(0));
      const nextStart = validDate(kept.startedAt, startedAt);
      const endedAt = nextStart >= startedAt ? nextStart : startedAt;
      let totalPausedMs = Math.max(0, Number(session.totalPausedMs) || 0);
      if (session.pausedAt) {
        const pausedAt = validDate(session.pausedAt, endedAt);
        totalPausedMs += Math.max(0, endedAt.getTime() - pausedAt.getTime());
      }
      const durationMs = calculateElapsedMs({ startedAt, pausedAt: endedAt, totalPausedMs }, endedAt);
      repairs.push({
        userId: String(group._id),
        keepSessionId: String(kept._id),
        closeSessionId: String(session._id),
        endedAt: endedAt.toISOString(),
        totalPausedMs,
        durationMs,
      });
    }
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", repairs }, null, 2));
  if (apply) {
    for (const repair of repairs) {
      await collection.updateOne(
        { _id: new mongoose.Types.ObjectId(repair.closeSessionId), endedAt: null },
        { $set: {
          endedAt: new Date(repair.endedAt),
          pausedAt: null,
          totalPausedMs: repair.totalPausedMs,
          durationMs: repair.durationMs,
          endedReason: "app_closed",
          updatedAt: new Date(),
        } },
      );
    }
  }

  const remaining = await collection.aggregate([
    { $match: { endedAt: null } },
    { $group: { _id: "$userId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (createIndex) {
    if (!apply) throw new Error("--create-index requires --apply");
    if (remaining.length) throw new Error("Duplicate open sessions remain; index was not created");
    await collection.createIndex(
      { userId: 1 },
      { name: INDEX_NAME, unique: true, partialFilterExpression: { endedAt: null } },
    );
    console.log(`Index ${INDEX_NAME} is present.`);
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
