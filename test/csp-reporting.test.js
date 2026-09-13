const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const vm = require("node:vm");
const helmet = require("helmet");
const fs = require("node:fs");
const {
  normalizeCspReport,
  createCspReportHandler,
} = require("../config/csp-reporting");

test("legacy CSP reports exclude sensitive URLs and unselected fields", () => {
  const result = normalizeCspReport({
    "effective-directive": "script-src-elem",
    "document-uri":
      "https://stickapin.example/reset-password?email=private@example.test&token=secret",
    "blocked-uri":
      "https://username:password@blocked.example/private.js?key=secret#fragment",
    "script-sample": "private script content",
    "original-policy": "private policy content",
    disposition: "enforce",
  });

  assert.deepEqual(result, {
    directive: "script-src-elem",
    documentOrigin: "https://stickapin.example",
    blockedOrigin: "https://blocked.example",
    disposition: "enforce",
  });
});

test("modern CSP report fields produce the same safe summary", () => {
  assert.deepEqual(normalizeCspReport({
    effectiveDirective: "script-src-attr",
    documentURL: "https://stickapin.example/dashboard?token=secret",
    blockedURL: "inline",
    disposition: "enforce",
    sample: "private script content",
  }), {
    directive: "script-src-attr",
    documentOrigin: "https://stickapin.example",
    blockedOrigin: "inline",
    disposition: "enforce",
  });
});

test("embedded data and blob identifiers are excluded", () => {
  for (const [blockedURL, expected] of [
    ["data:text/javascript,private-content", "data:"],
    ["blob:https://stickapin.example/private-id", "blob:"],
  ]) {
    const result = normalizeCspReport({
      effectiveDirective: "script-src-elem",
      blockedURL,
    });

    assert.equal(result.blockedOrigin, expected);
    assert.equal(result.documentOrigin, "unknown");
    assert.equal(result.disposition, "unknown");
  }
});

test("malformed reports are rejected", () => {
  for (const report of [
    null,
    [],
    "invalid",
    {},
    { effectiveDirective: "script-src\nforged-log-entry" },
    { effectiveDirective: "a".repeat(65) },
  ]) {
    assert.equal(normalizeCspReport(report), null);
  }
});

test("legacy CSP endpoint returns 204 and logs only a safe summary", async (t) => {
  const logs = [];
  const app = express();

  app.post(
    "/csp-report",
    express.json({ type: "application/csp-report", limit: "16kb" }),
    createCspReportHandler({
      logger: { info: (message) => logs.push(message) },
    })
  );

  const server = app.listen(0, "127.0.0.1");

  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  await once(server, "listening");

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/csp-report`,
    {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "effective-directive": "script-src-elem",
          "document-uri":
            "https://stickapin.example/reset-password?token=secret",
          "blocked-uri": "inline",
          "script-sample": "private script content",
          disposition: "enforce",
        },
      }),
    }
  );

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(logs.length, 1);

  const event = JSON.parse(logs[0]);
  assert.equal(typeof event.timestamp, "string");
  assert.ok(Number.isFinite(Date.parse(event.timestamp)));

  const { timestamp, ...summary } = event;

  assert.deepEqual(summary, {
    event: "csp_violation",
    directive: "script-src-elem",
    documentOrigin: "https://stickapin.example",
    blockedOrigin: "inline",
    disposition: "enforce",
  });
});

test("modern CSP batches log safe reports and reject invalid batches completely", async (t) => {
  const logs = [];
  const app = express();

  app.post(
    "/csp-report",
    express.json({ type: "application/reports+json", limit: "16kb" }),
    createCspReportHandler({
      logger: { info: (message) => logs.push(message) },
    })
  );

  const server = app.listen(0, "127.0.0.1");

  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  await once(server, "listening");

  const endpoint =
    `http://127.0.0.1:${server.address().port}/csp-report`;

  const send = (body) => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/reports+json" },
    body: JSON.stringify(body),
  });

  const validReport = {
    type: "csp-violation",
    url: "https://stickapin.example/private?token=secret",
    body: {
      effectiveDirective: "script-src-attr",
      documentURL: "https://stickapin.example/dashboard?token=secret",
      blockedURL: "inline",
      disposition: "enforce",
      sample: "private script content",
    },
  };

  const accepted = await send([validReport]);

  assert.equal(accepted.status, 204);
  assert.equal(await accepted.text(), "");
  assert.equal(logs.length, 1);

  const { timestamp, ...summary } = JSON.parse(logs[0]);

  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.deepEqual(summary, {
    event: "csp_violation",
    directive: "script-src-attr",
    documentOrigin: "https://stickapin.example",
    blockedOrigin: "inline",
    disposition: "enforce",
  });

  logs.length = 0;

  const rejected = await send([
    validReport,
    {
      type: "csp-violation",
      body: { effectiveDirective: "invalid\nforged-entry" },
    },
  ]);

  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    error: "Invalid report payload",
  });
  assert.equal(logs.length, 0);
});

test("Helmet emits an enforced CSP with the reporting endpoint", async (t) => {
  const source = fs.readFileSync("server.js", "utf8");
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const normalizedStart = normalizedSource.indexOf("app.use(\n  helmet(");
  const end = normalizedSource.indexOf("const port =", normalizedStart);

  assert.ok(normalizedStart >= 0, "Helmet configuration must exist");
  assert.ok(end > normalizedStart, "Helmet configuration boundary must exist");

  const app = express();

  // Run the actual Helmet configuration without starting the database or app.
  vm.runInNewContext(
    normalizedSource.slice(normalizedStart, end),
    {
      app,
      helmet,
      process: { env: { NODE_ENV: "production" } },
    }
  );

  app.get("/", (req, res) => res.send("OK"));

  const server = app.listen(0, "127.0.0.1");

  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  await once(server, "listening");

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/`
  );

  assert.equal(response.status, 200);
  await response.text();

  const policy = response.headers.get("content-security-policy");
  assert.ok(policy, "An enforced CSP header must be present");

  const directives = policy.split(";").map((value) => value.trim());

  assert.ok(directives.includes("report-uri /csp-report"));
  assert.ok(directives.includes("script-src 'self'"));
  assert.ok(directives.includes("script-src-attr 'none'"));
  assert.equal(
    response.headers.get("content-security-policy-report-only"),
    null
  );
});

test("server CSP endpoint rejects invalid requests without logging payloads", async (t) => {
  const source = fs.readFileSync("server.js", "utf8");
  const start = source.indexOf("const cspReportLimiter =");
  const end = source.indexOf("app.use(requireDatabase);", start);

  assert.ok(start >= 0, "CSP endpoint configuration must exist");
  assert.ok(end > start, "CSP endpoint must precede database middleware");

  const logs = [];
  const app = express();

  // Exercise the actual server parser, limiter, and route registration.
  vm.runInNewContext(source.slice(start, end), {
    app,
    express,
    rateLimit: require("express-rate-limit"),
    createCspReportHandler: () => createCspReportHandler({
      logger: { info: (message) => logs.push(message) },
    }),
  });

  const server = app.listen(0, "127.0.0.1");

  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  await once(server, "listening");

  const endpoint =
    `http://127.0.0.1:${server.address().port}/csp-report`;

  const cases = [
    {
      type: "application/csp-report",
      body: '{"secret":"private-token",',
      status: 400,
      error: "Invalid report payload",
    },
    {
      type: "application/csp-report",
      body: JSON.stringify({ secret: "x".repeat(17 * 1024) }),
      status: 413,
      error: "Invalid report payload",
    },
    {
      type: "text/plain",
      body: "private-token",
      status: 415,
      error: "Unsupported report type",
    },
    {
      type: "application/reports+json",
      body: JSON.stringify(Array.from({ length: 11 }, () => ({
        type: "csp-violation",
        body: { effectiveDirective: "script-src" },
      }))),
      status: 413,
      error: "Too many reports",
    },
  ];

  for (const item of cases) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": item.type },
      body: item.body,
    });

    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), { error: item.error });
  }

  assert.deepEqual(logs, []);
});