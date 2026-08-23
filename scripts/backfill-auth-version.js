#!/usr/bin/env node
const mongoose = require("mongoose");

const MISSING_AUTH_VERSION_FILTER = { authVersion: { $exists: false } };

async function backfillAuthVersions(collection, { apply = false } = {}) {
  const before = await collection.countDocuments(MISSING_AUTH_VERSION_FILTER);
  let modified = 0;

  if (apply && before > 0) {
    const result = await collection.updateMany(
      MISSING_AUTH_VERSION_FILTER,
      { $set: { authVersion: 0 } }
    );
    modified = result.modifiedCount;
  }

  const remaining = apply
    ? await collection.countDocuments(MISSING_AUTH_VERSION_FILTER)
    : before;
  return { mode: apply ? "apply" : "dry-run", found: before, modified, remaining };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (
    apply &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_AUTH_VERSION_BACKFILL !== "1"
  ) {
    throw new Error(
      "Production backfill requires ALLOW_PRODUCTION_AUTH_VERSION_BACKFILL=1"
    );
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const result = await backfillAuthVersions(mongoose.connection.collection("users"), {
    apply,
  });
  console.log(JSON.stringify(result, null, 2));

  if (apply && result.remaining !== 0) {
    throw new Error("Some users still have no authVersion");
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { MISSING_AUTH_VERSION_FILTER, backfillAuthVersions };
