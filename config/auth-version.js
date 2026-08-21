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

module.exports = { toSessionIdentity, parseSessionIdentity };
