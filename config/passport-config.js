const LocalStrategy = require("passport-local").Strategy;
const bcrypt = require("bcryptjs");
const User = require("./models/user");

function normalizeEmail(value) {
  return String(value || "").toLowerCase().trim();
}

function splitName(profile = {}, fallbackEmail = "") {
  const given = profile?.name?.givenName || "";
  const family = profile?.name?.familyName || "";

  if (given || family) {
    return {
      firstName: String(given || "there").trim() || "there",
      lastName: String(family || "user").trim() || "user",
    };
  }

  const displayName = String(profile?.displayName || "").trim();
  if (displayName) {
    const parts = displayName.split(/\s+/).filter(Boolean);
    return {
      firstName: parts[0] || "there",
      lastName: parts.slice(1).join(" ") || "user",
    };
  }

  const local = String(fallbackEmail || "").split("@")[0];
  return {
    firstName: local || "there",
    lastName: "user",
  };
}


function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") return "";
  return value.trim();
}

function firstEnv(names = []) {
  for (const name of names) {
    const value = readEnv(name);
    if (value) return value;
  }

  return "";
}

function buildCallbackUrl(pathname) {
  const explicitBaseUrl = readEnv("APP_BASE_URL");
  const vercelUrl = readEnv("VERCEL_PROJECT_PRODUCTION_URL") || readEnv("VERCEL_URL");
  const baseUrl = explicitBaseUrl || (vercelUrl ? `https://${vercelUrl.replace(/^https?:\/\//, "")}` : "");

  if (!baseUrl) return "";

  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

async function recoverUserFromDuplicateProviderError({
  error,
  providerKey,
  providerId,
  providerEmail,
}) {
  if (!error || error.code !== 11000) return null;

  if (providerId) {
    const userByProviderId = await User.findOne({ [`authProviders.${providerKey}.id`]: providerId });
    if (userByProviderId) return userByProviderId;
  }

  if (providerEmail) {
    const userByEmail = await User.findOne({ email: providerEmail });
    if (userByEmail) return userByEmail;
  }

  return null;
}

module.exports = function (passport) {
  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password" },
      async (email, password, done) => {
        try {
          const normalizedEmail = normalizeEmail(email);
          const user = await User.findOne({ email: normalizedEmail });

          if (!user || !user.passwordHash) {
            return done(null, false, { message: "User not found" });
          }

          const isMatch = await bcrypt.compare(password, user.passwordHash);

          if (!isMatch) {
            return done(null, false, { message: "Incorrect password" });
          }

          if (user.emailVerified === false) {
            return done(null, false, {
              message: "Please verify your email before logging in",
            });
          }

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  const googleClientId = firstEnv(["GOOGLE_CLIENT_ID"]);
  const googleClientSecret = firstEnv(["GOOGLE_CLIENT_SECRET"]);
  const googleCallbackURL = firstEnv(["GOOGLE_CALLBACK_URL"]) || buildCallbackUrl("/auth/google/callback");

  if (googleClientId && googleClientSecret && googleCallbackURL) {
    const GoogleStrategy = require("passport-google-oauth20").Strategy;

    passport.use(
      new GoogleStrategy(
        {
          clientID: googleClientId,
          clientSecret: googleClientSecret,
          callbackURL: googleCallbackURL,
        },
        async (accessToken, refreshToken, profile, done) => {
          const providerId = String(profile?.id || "").trim();
          const providerEmail = normalizeEmail(
            profile?.emails?.find((entry) => entry?.value)?.value
          );

          try {
            const avatarUrl = profile?.photos?.[0]?.value || null;

            let user = providerId
              ? await User.findOne({ "authProviders.google.id": providerId })
              : null;

            if (!user && providerEmail) {
              user = await User.findOne({ email: providerEmail });
            }

            if (user) {
              user.authProviders = user.authProviders || {};
              user.authProviders.google = user.authProviders.google || {};

              if (providerId) user.authProviders.google.id = providerId;
              if (providerEmail) user.authProviders.google.email = providerEmail;
              if (!user.email && providerEmail) user.email = providerEmail;
              if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
              if (user.emailVerified === false) {
                user.emailVerified = true;
                user.emailVerifiedAt = user.emailVerifiedAt || new Date();
              }

              await user.save();
              return done(null, user);
            }

            if (!providerEmail) {
              return done(null, false, { message: "No email returned from Google account" });
            }

            const { firstName, lastName } = splitName(profile, providerEmail);
            const createdUser = await User.create({
              firstName,
              lastName,
              email: providerEmail,
              emailVerified: true,
              emailVerifiedAt: new Date(),
              avatarUrl,
              authProviders: {
                google: {
                  id: providerId || null,
                  email: providerEmail || null,
                },
              },
            });

            return done(null, createdUser);
          } catch (error) {
            const recoveredUser = await recoverUserFromDuplicateProviderError({
              error,
              providerKey: "google",
              providerId,
              providerEmail,
            });

            if (recoveredUser) {
              return done(null, recoveredUser);
            }

            return done(error);
          }
        }
      )
    );
  }

  const appleClientID = process.env.APPLE_CLIENT_ID;
  const appleTeamID = process.env.APPLE_TEAM_ID;
  const appleKeyID = process.env.APPLE_KEY_ID;
  const appleCallbackURL = process.env.APPLE_CALLBACK_URL;
  const applePrivateKeyRaw = process.env.APPLE_PRIVATE_KEY;

  if (appleClientID && appleTeamID && appleKeyID && appleCallbackURL && applePrivateKeyRaw) {
    const AppleStrategy = require("passport-apple");

    passport.use(
      new AppleStrategy(
        {
          clientID: appleClientID,
          teamID: appleTeamID,
          keyID: appleKeyID,
          callbackURL: appleCallbackURL,
          privateKeyString: applePrivateKeyRaw.replace(/\\n/g, "\n"),
          passReqToCallback: false,
        },
        async (accessToken, refreshToken, idToken, profile, done) => {
          const providerId = String(profile?.id || "").trim();
          const providerEmail = normalizeEmail(profile?.email);

          try {
            let user = providerId
              ? await User.findOne({ "authProviders.apple.id": providerId })
              : null;

            if (!user && providerEmail) {
              user = await User.findOne({ email: providerEmail });
            }

            if (user) {
              user.authProviders = user.authProviders || {};
              user.authProviders.apple = user.authProviders.apple || {};

              if (providerId) user.authProviders.apple.id = providerId;
              if (providerEmail) user.authProviders.apple.email = providerEmail;
              if (!user.email && providerEmail) user.email = providerEmail;
              if (user.emailVerified === false) {
                user.emailVerified = true;
                user.emailVerifiedAt = user.emailVerifiedAt || new Date();
              }

              await user.save();
              return done(null, user);
            }

            if (!providerEmail) {
              return done(null, false, { message: "No email returned from Apple account" });
            }

            const { firstName, lastName } = splitName(profile, providerEmail);
            const createdUser = await User.create({
              firstName,
              lastName,
              email: providerEmail,
              emailVerified: true,
              emailVerifiedAt: new Date(),
              authProviders: {
                apple: {
                  id: providerId || null,
                  email: providerEmail || null,
                },
              },
            });

            return done(null, createdUser);
          } catch (error) {
            const recoveredUser = await recoverUserFromDuplicateProviderError({
              error,
              providerKey: "apple",
              providerId,
              providerEmail,
            });

            if (recoveredUser) {
              return done(null, recoveredUser);
            }

            return done(error);
          }
        }
      )
    );
  }

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (err) {
      done(err);
    }
  });
};
