// Core public routes: root redirect, language preference, login/logout. Pure
// move from server.js — route bodies are byte-for-byte the originals. Lib + view
// helpers are imported directly.
//
// Public API: register(app).

const { DEFAULT_MODULE_KEY } = require("../lib/modules");
const { normalizeLanguage } = require("../lib/i18n");
const { getUsers } = require("../lib/store");
const { baseView, getSafeReturnTo } = require("../lib/views");

function register(app) {
  app.get("/", (req, res) => {
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/preferences/language", (req, res) => {
    req.session.language = normalizeLanguage(req.body.language, req.language);
    return res.redirect(getSafeReturnTo(req.body.returnTo));
  });

  app.get("/login", (req, res) => {
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const userData = await getUsers();
    const user = userData.users.find(
      (entry) => entry.username === username && entry.password === password
    );

    if (!user) {
      return res.status(401).render(
        "login",
        baseView(req, {
          pageTitle: req.t("login.title"),
          flash: { type: "error", message: req.t("login.invalid") },
          languageReturnTo: "/login",
        })
      );
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      role: user.role,
      username: user.username,
    };
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
    });
  });
}

module.exports = { register };
