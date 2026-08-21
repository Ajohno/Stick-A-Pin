const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createAccountActionHandlers } = require("../config/account-action-routes");
const {
  decryptAccountActionPayload,
  encryptAccountActionPayload,
  hashAccountActionToken,
  processAccountActionPayload,
} = require("../config/account-action-jobs");

const GENERIC_RESPONSE = {
  status: 202,
  body: { message: "If the address can be used, check your email for the next step." },
};

function createHandlerHarness({
  processAccountActionJob = async () => "completed",
  schedule,
  logger = { error() {} },
} = {}) {
  const enqueued = [];
  const scheduled = [];
  const handlers = createAccountActionHandlers({
    enqueueAccountActionJob: async (kind, payload) => {
      const job = { id: String(enqueued.length + 1), kind, payload };
      enqueued.push(job);
      return job;
    },
    processAccountActionJob,
    scheduleBackgroundTask:
      schedule ||
      ((promise) => {
        const guarded = Promise.resolve(promise).catch(() => {});
        scheduled.push(guarded);
        return guarded;
      }),
    resolveBaseUrl: () => "https://stickapin.example",
    hashPassword: async () => "test-password-hash",
    logger,
  });
  return { handlers, enqueued, scheduled };
}

async function withAccountServer(harness, callback) {
  const app = express();
  app.use(express.json());
  app.post("/register", harness.handlers.register);
  app.post("/resend-verification", harness.handlers.resendVerification);
  app.post("/forgot-password", harness.handlers.forgotPassword);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("real account-action routes expose the same response for every account state", async () => {
  const harness = createHandlerHarness();
  await withAccountServer(harness, async (baseUrl) => {
    const routes = [
      {
        pathname: "/register",
        states: ["new", "verified", "unverified"],
        body: (state) => ({
          firstName: "Test",
          lastName: "User",
          email: `${state}@example.test`,
          password: "StrongPassword123",
        }),
      },
      {
        pathname: "/resend-verification",
        states: ["unknown", "verified", "unverified"],
        body: (state) => ({ email: `${state}@example.test` }),
      },
      {
        pathname: "/forgot-password",
        states: ["unknown", "verified", "unverified"],
        body: (state) => ({ email: `${state}@example.test` }),
      },
    ];

    for (const route of routes) {
      const responses = [];
      for (const state of route.states) {
        responses.push(await postJson(baseUrl, route.pathname, route.body(state)));
      }
      responses.forEach((response) => assert.deepEqual(response, GENERIC_RESPONSE));
    }
  });
  await Promise.all(harness.scheduled);
});

test("registration normalizes names before queueing and rejects whitespace-only names", async () => {
  const harness = createHandlerHarness();
  await withAccountServer(harness, async (baseUrl) => {
    const accepted = await postJson(baseUrl, "/register", {
      firstName: "  Ada ",
      lastName: " Lovelace  ",
      email: " ADA@EXAMPLE.TEST ",
      password: "StrongPassword123",
    });
    assert.deepEqual(accepted, GENERIC_RESPONSE);
    assert.deepEqual(harness.enqueued[0], {
      id: "1",
      kind: "register",
      payload: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.test",
        passwordHash: "test-password-hash",
        baseUrl: "https://stickapin.example",
      },
    });

    const rejected = await postJson(baseUrl, "/register", {
      firstName: "   ",
      lastName: "Lovelace",
      email: "known@example.test",
      password: "StrongPassword123",
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.body, { error: "Missing required fields" });
    assert.equal(harness.enqueued.length, 1);
  });
  await Promise.all(harness.scheduled);
});

test("the HTTP acknowledgement does not wait for account lookup or email delivery", async () => {
  let releaseWorker;
  const workerGate = new Promise((resolve) => {
    releaseWorker = resolve;
  });
  const harness = createHandlerHarness({
    processAccountActionJob: async () => workerGate,
  });

  await withAccountServer(harness, async (baseUrl) => {
    const request = postJson(baseUrl, "/forgot-password", {
      email: "person@example.test",
    });
    let timeoutId;
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("route waited for background work")),
          2_000
        );
      }),
    ]);
    clearTimeout(timeoutId);
    assert.deepEqual(response, GENERIC_RESPONSE);
    assert.equal(harness.scheduled.length, 1);
    releaseWorker();
  });
  await Promise.all(harness.scheduled);
});

test("a background scheduling failure preserves the durable 202 acknowledgement", async () => {
  const logMessages = [];
  const harness = createHandlerHarness({
    schedule() {
      throw new Error("simulated scheduler failure");
    },
    logger: { error: (message) => logMessages.push(message) },
  });
  await withAccountServer(harness, async (baseUrl) => {
    assert.deepEqual(
      await postJson(baseUrl, "/resend-verification", {
        email: "person@example.test",
      }),
      GENERIC_RESPONSE
    );
  });
  assert.equal(harness.enqueued.length, 1);
  assert.deepEqual(logMessages, ["Unable to schedule account action background processing"]);
});

function createFakeUserModel(state) {
  let user = state === "unknown"
    ? null
    : {
        _id: "user-id",
        firstName: "Test",
        lastName: "User",
        email: `${state}@example.test`,
        passwordHash: "existing-hash",
        emailVerified: state === "verified",
      };

  function matches(filter) {
    if (!user) return false;
    if (filter._id && String(filter._id) !== String(user._id)) return false;
    if (filter.email && filter.email !== user.email) return false;
    if (Object.hasOwn(filter, "emailVerified") && filter.emailVerified !== user.emailVerified) {
      return false;
    }
    return true;
  }

  return {
    async findOne(filter) {
      return matches(filter) ? user : null;
    },
    async create(values) {
      user = { _id: "created-user", ...values };
      return user;
    },
    async findOneAndUpdate(filter, update) {
      if (!matches(filter)) return null;
      Object.assign(user, update.$set || {});
      return user;
    },
    read() {
      return user;
    },
  };
}

test("the background worker handles the full account-state matrix", async () => {
  const matrix = [
    ["register", "unknown", true],
    ["register", "verified", false],
    ["register", "unverified", true],
    ["resend-verification", "unknown", false],
    ["resend-verification", "verified", false],
    ["resend-verification", "unverified", true],
    ["forgot-password", "unknown", false],
    ["forgot-password", "verified", true],
    ["forgot-password", "unverified", true],
  ];

  for (const [kind, state, shouldSend] of matrix) {
    const UserModel = createFakeUserModel(state);
    const deliveries = [];
    const email = state === "unknown" ? "unknown@example.test" : `${state}@example.test`;
    const result = await processAccountActionPayload({
      kind,
      payload: {
        email,
        firstName: "New",
        lastName: "User",
        passwordHash: "new-password-hash",
        baseUrl: "https://stickapin.example",
      },
      UserModel,
      sendVerificationEmail: async (...args) => deliveries.push(["verification", ...args]),
      sendPasswordResetEmail: async (...args) => deliveries.push(["reset", ...args]),
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      generateToken: () => "fixed-token",
    });

    assert.equal(result.emailSent, shouldSend, `${kind}/${state}`);
    assert.equal(deliveries.length, shouldSend ? 1 : 0, `${kind}/${state}`);
    if (shouldSend && kind !== "forgot-password") {
      assert.equal(
        UserModel.read().emailVerificationTokenHash,
        hashAccountActionToken("fixed-token")
      );
    }
    if (shouldSend && kind === "forgot-password") {
      assert.equal(
        UserModel.read().passwordResetTokenHash,
        hashAccountActionToken("fixed-token")
      );
    }
  }
});

test("durable job payloads are authenticated and encrypted at rest", () => {
  const secret = "test-session-secret";
  const payload = {
    kind: "register",
    email: "private@example.test",
    passwordHash: "private-password-hash",
  };
  const encrypted = encryptAccountActionPayload(payload, secret);
  const storedText = Object.values(encrypted).join(" ");
  assert.equal(storedText.includes(payload.email), false);
  assert.equal(storedText.includes(payload.passwordHash), false);
  assert.deepEqual(
    decryptAccountActionPayload(
      { kind: "register", payloadVersion: 1, ...encrypted },
      secret
    ),
    payload
  );
  assert.throws(
    () =>
      decryptAccountActionPayload(
        { kind: "register", payloadVersion: 1, ...encrypted },
        "wrong-secret"
      ),
    { code: "ACCOUNT_ACTION_PAYLOAD_INVALID" }
  );
});
