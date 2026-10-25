const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveAccountActionBaseUrl,
} = require("../config/account-action-base-url");

test("Preview links use the preview deployment instead of production", () => {
  const result = resolveAccountActionBaseUrl({
    VERCEL_ENV: "preview",
    VERCEL_URL: "stickapin-preview.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "www.stickapin.app",
  });

  assert.equal(result, "https://stickapin-preview.vercel.app");
});

test("Production links prefer the production domain", () => {
  const result = resolveAccountActionBaseUrl({
    VERCEL_ENV: "production",
    VERCEL_URL: "stickapin-deployment.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "www.stickapin.app",
  });

  assert.equal(result, "https://www.stickapin.app");
});

test("An explicit APP_BASE_URL overrides the deployment URLs", () => {
  const result = resolveAccountActionBaseUrl({
    APP_BASE_URL: "https://test.stickapin.app/",
    VERCEL_ENV: "preview",
    VERCEL_URL: "stickapin-preview.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "www.stickapin.app",
  });

  assert.equal(result, "https://test.stickapin.app");
});

test("Production falls back to its deployment URL", () => {
  const result = resolveAccountActionBaseUrl({
    VERCEL_ENV: "production",
    VERCEL_URL: "stickapin-deployment.vercel.app",
  });

  assert.equal(result, "https://stickapin-deployment.vercel.app");
});

test("Preview without a deployment URL does not fall back to production", () => {
  const result = resolveAccountActionBaseUrl({
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_PRODUCTION_URL: "www.stickapin.app",
  });

  assert.equal(result, "");
});

test("Missing deployment configuration returns an empty string", () => {
  assert.equal(resolveAccountActionBaseUrl({}), "");
});

test("A deployment URL with a scheme and trailing slash is normalized", () => {
  const result = resolveAccountActionBaseUrl({
    VERCEL_ENV: "preview",
    VERCEL_URL: "https://stickapin-preview.vercel.app/",
  });

  assert.equal(result, "https://stickapin-preview.vercel.app");
});