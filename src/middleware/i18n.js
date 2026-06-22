// Language-negotiation middleware: resolve the request language from
// query/body/session (falling back to the default), then attach req.language +
// req.t (the translator). Pure move from server.js — behavior unchanged.
//
// Public API: { languageMiddleware }.

const { buildTranslator, normalizeLanguage } = require("../lib/i18n");

function languageMiddleware(req, _res, next) {
  const requestedLanguage =
    req.query.lang ||
    req.body?.lang ||
    req.session.language ||
    normalizeLanguage();
  req.language = normalizeLanguage(requestedLanguage);
  req.session.language = req.language;
  req.t = buildTranslator(req.language);
  next();
}

module.exports = { languageMiddleware };
