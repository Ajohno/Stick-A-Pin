const crypto = require("crypto");

function isAuthorizedCronRequest(authorizationHeader, configuredSecret) {
  const secret = String(configuredSecret || "").trim();
  const authorization = String(authorizationHeader || "");
  const expected = `Bearer ${secret}`;
  if (!secret || authorization.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

module.exports = { isAuthorizedCronRequest };
