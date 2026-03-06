const LocalStrategy = require("passport-local").Strategy;
const bcrypt = require("bcryptjs");
const User = require("./models/user"); // Import User model

module.exports = function (passport) {
    passport.use(
        new LocalStrategy({ usernameField: "email", passwordField: "password" }, 
            async (email, password, done) => {
            try {
                const normalizedEmail = (email || "").toLowerCase().trim();
                const user = await User.findOne({ email: normalizedEmail });

                if (!user) {
                    return done(null, false, { message: "User not found" });
                }

                const isMatch = await bcrypt.compare(password, user.passwordHash);

                if (!isMatch) {
                    return done(null, false, { message: "Incorrect password" });
                }

                if (!user.emailVerified) {
                    return done(null, false, { message: "Please verify your email before logging in" });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        })
    );

    // Serialize user to store user ID in session
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    // Deserialize user to retrieve user data from session
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await User.findById(id);
            done(null, user);
        } catch (err) {
            done(err);
        }
    });
};
