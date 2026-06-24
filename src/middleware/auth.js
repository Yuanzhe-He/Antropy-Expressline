// Auth / session-user middleware. Login is currently disabled (README): every
// visitor is the public demo user. `attachUser` runs globally; `requireAuth` is
// the per-route guard used by the admin/workbench routes. Both are intentionally
// identical for now — kept as two names so re-enabling real auth later only
// touches requireAuth.
//
// Public API: { publicDemoUser, attachUser, requireAuth }. Pure move from
// server.js — behavior unchanged.

const publicDemoUser = Object.freeze({
  id: "public-demo",
  name: "Express Line",
  role: "admin",
  username: "public",
});

function attachUser(req, _res, next) {
  req.session.user = req.session.user || publicDemoUser;
  next();
}

function requireAuth(req, res, next) {
  req.session.user = req.session.user || publicDemoUser;
  return next();
}

module.exports = { publicDemoUser, attachUser, requireAuth };
