function createEnsureAuthenticated({ clearSessionCookie }) {
  return function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }

    const reject = () => {
      clearSessionCookie(res);
      return res.status(401).json({
        error: "Unauthorized - Please log in",
      });
    };

    if (!req.session) return reject();
    return req.session.destroy(() => reject());
  };
}

module.exports = { createEnsureAuthenticated };