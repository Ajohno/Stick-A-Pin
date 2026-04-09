const mongoose = require("mongoose");
require("dotenv").config(); // Load environment variables

let connectionPromise = null;
let indexesChecked = false;

async function cleanupLegacyUserIndexes(db) {
    try {
        const usersCollection = db.collection("users");
        const indexes = await usersCollection.indexes();
        const hasLegacyUsernameIndex = indexes.some((index) => index.name === "username_1");
        const hasLegacyAppleProviderIndex = indexes.some(
            (index) => index.name === "authProviders.apple.id_1"
        );

        if (hasLegacyUsernameIndex) {
            await usersCollection.dropIndex("username_1");
            console.log("🧹 Removed legacy users.username_1 index");
        }

        if (hasLegacyAppleProviderIndex) {
            await usersCollection.dropIndex("authProviders.apple.id_1");
            console.log("🧹 Removed legacy users.authProviders.apple.id_1 index");
        }

        await usersCollection.updateMany(
            { "authProviders.apple": { $exists: true } },
            { $unset: { "authProviders.apple": "" } }
        );
    } catch (error) {
        // Ignore missing collection/index races, surface everything else
        const ignorable = ["NamespaceNotFound", "IndexNotFound"];
        if (!ignorable.includes(error?.codeName)) {
            throw error;
        }
    }
}

// Connect to the database
const connectDB = async () => {
    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI environment variable is required");
    }

    // readyState: 1 = connected
    if (mongoose.connection.readyState === 1) {
        return mongoose.connection;
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = mongoose
        .connect(process.env.MONGO_URI)
        .then(async (connection) => {
            console.log("✅ MongoDB Connected Successfully!");

            if (!indexesChecked) {
                await cleanupLegacyUserIndexes(connection.connection.db);
                indexesChecked = true;
            }

            return connection;
        })
        .catch((err) => {
            console.error("❌ MongoDB Connection Failed:", err);
            throw err;
        })
        .finally(() => {
            // Clear so a later request can retry if this attempt failed
            connectionPromise = null;
        });

    return connectionPromise;
};

module.exports = connectDB;
