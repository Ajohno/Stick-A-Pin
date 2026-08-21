function toSessionIdentity(user) {
  const authVersion = user?.authVersion;
  if (!user?.id || !Number.isInteger(authVersion) || authVersion < 0) return null;
  return { id: String(user.id), authVersion };
}

function parseSessionIdentity(value) {
  const authVersion = value?.authVersion;
  if (!value?.id || !Number.isInteger(authVersion) || authVersion < 0) return null;
  return { id: String(value.id), authVersion };
}

/**
 * Match version-zero sessions to either an explicit zero or a legacy missing
 * field during rollout. Every higher version remains an exact comparison.
 */
function buildSessionUserFilter(identity) {
  const parsed = parseSessionIdentity(identity);
  if (!parsed) return null;
  if (parsed.authVersion === 0) {
    return {
      _id: parsed.id,
      $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }],
    };
  }
  return { _id: parsed.id, authVersion: parsed.authVersion };
}

module.exports = { toSessionIdentity, parseSessionIdentity, buildSessionUserFilter };
