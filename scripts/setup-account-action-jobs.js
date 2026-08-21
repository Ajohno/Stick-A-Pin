#!/usr/bin/env node
const mongoose = require("mongoose");

const REQUIRED_INDEXES = [
  {
    key: { status: 1, availableAt: 1, createdAt: 1 },
    options: { name: "account_action_jobs_ready" },
  },
  {
    key: { expiresAt: 1 },
    options: {
      name: "account_action_jobs_expiry",
      expireAfterSeconds: 0,
    },
  },
];

async function readIndexNames(collection) {
  try {
    return (await collection.indexes()).map((index) => index.name);
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

async function setupAccountActionJobIndexes(collection, { apply = false } = {}) {
  const existingBefore = await readIndexNames(collection);
  const missingBefore = REQUIRED_INDEXES
    .map(({ options }) => options.name)
    .filter((name) => !existingBefore.includes(name));

  if (apply) {
    for (const { key, options } of REQUIRED_INDEXES) {
      await collection.createIndex(key, options);
    }
  }

  const existingAfter = apply ? await readIndexNames(collection) : existingBefore;
  const missingAfter = REQUIRED_INDEXES
    .map(({ options }) => options.name)
    .filter((name) => !existingAfter.includes(name));
  return {
    mode: apply ? "apply" : "dry-run",
    missingBefore,
    missingAfter,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  if (
    apply &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_ACCOUNT_ACTION_INDEX_SETUP !== "1"
  ) {
    throw new Error(
      "Production index setup requires ALLOW_PRODUCTION_ACCOUNT_ACTION_INDEX_SETUP=1"
    );
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const result = await setupAccountActionJobIndexes(
    mongoose.connection.collection("accountactionjobs"),
    { apply }
  );
  console.log(JSON.stringify(result, null, 2));
  if (apply && result.missingAfter.length > 0) {
    throw new Error("Required account-action job indexes are still missing");
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

module.exports = { REQUIRED_INDEXES, setupAccountActionJobIndexes };
