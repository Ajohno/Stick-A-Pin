/**
 * Select the base URL for verification and password-reset emails.
 * Uses deployment configuration rather than request Host headers.
 */
function resolveAccountActionBaseUrl(env) {
  if (env.APP_BASE_URL) {
    return env.APP_BASE_URL.replace(/\/$/, "");
  }

  const vercelUrl = String(
    env.VERCEL_ENV === "preview"
      ? env.VERCEL_URL || ""
      : env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || ""
  ).trim();

  if (!vercelUrl) return "";

  return `https://${vercelUrl
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")}`;
}

module.exports = { resolveAccountActionBaseUrl };