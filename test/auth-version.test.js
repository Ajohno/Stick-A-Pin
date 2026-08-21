const test = require("node:test");
const assert = require("node:assert/strict");
const configurePassport = require("../config/passport-config");
const {
  toSessionIdentity,
  parseSessionIdentity,
  buildSessionUserFilter,
} = require("../config/auth-version");

test("new local and OAuth logins serialize the current authentication version", () => {
  assert.deepEqual(toSessionIdentity({ id: "local", authVersion: 0 }), {
    id: "local", authVersion: 0,
  });
  assert.deepEqual(toSessionIdentity({ id: "oauth", authVersion: 4 }), {
    id: "oauth", authVersion: 4,
  });
});

test("legacy, missing, malformed, and negative session versions fail closed", () => {
  assert.equal(parseSessionIdentity("legacy-user-id"), null);
  assert.equal(parseSessionIdentity({ id: "user" }), null);
  assert.equal(parseSessionIdentity({ id: "user", authVersion: "bad" }), null);
  assert.equal(parseSessionIdentity({ id: "user", authVersion: -1 }), null);
  assert.deepEqual(parseSessionIdentity({ id: "user", authVersion: 2 }), {
    id: "user", authVersion: 2,
  });
});

test("version-zero lookup supports legacy missing fields without weakening later versions", () => {
  assert.deepEqual(buildSessionUserFilter({ id: "user", authVersion: 0 }), {
    _id: "user",
    $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }],
  });
  assert.deepEqual(buildSessionUserFilter({ id: "user", authVersion: 3 }), {
    _id: "user",
    authVersion: 3,
  });
  assert.equal(buildSessionUserFilter("legacy-user-id"), null);
});

function configuredDeserializer(UserModel) {
  const passport = {
    use() {},
    serializeUser(callback) {
      this.serializer = callback;
    },
    deserializeUser(callback) {
      this.deserializer = callback;
    },
  };
  configurePassport(passport, { UserModel });
  return passport.deserializer;
}

function deserialize(callback, identity) {
  return new Promise((resolve, reject) => {
    callback(identity, (error, user) => {
      if (error) reject(error);
      else resolve(user);
    });
  });
}

test("deserializing version zero persists the legacy default atomically", async () => {
  let received;
  const expectedUser = { id: "legacy", authVersion: 0 };
  const deserializer = configuredDeserializer({
    async findOneAndUpdate(filter, update, options) {
      received = { filter, update, options };
      return expectedUser;
    },
    async findOne() {
      assert.fail("version zero should use the compatibility update");
    },
  });

  assert.equal(
    await deserialize(deserializer, { id: "legacy", authVersion: 0 }),
    expectedUser
  );
  assert.deepEqual(received, {
    filter: {
      _id: "legacy",
      $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }],
    },
    update: { $set: { authVersion: 0 } },
    options: { new: true },
  });
});

test("deserializing a later version keeps an exact revocation check", async () => {
  let receivedFilter;
  const deserializer = configuredDeserializer({
    async findOneAndUpdate() {
      assert.fail("later versions must not use the rollout fallback");
    },
    async findOne(filter) {
      receivedFilter = filter;
      return null;
    },
  });

  assert.equal(await deserialize(deserializer, { id: "user", authVersion: 4 }), null);
  assert.deepEqual(receivedFilter, { _id: "user", authVersion: 4 });
  assert.equal(await deserialize(deserializer, "legacy-id-only-session"), false);
});
