// View-locals + flash middleware. Pure move from server.js — behavior unchanged.
//
// Public API: { safeJsonLocals, flashMiddleware }.

// B1 (QA): XSS-safe JSON for inlining into <script type="application/json"> blocks.
// JSON.stringify does NOT escape "</script>" (or "<!--"), so a user-editable value
// containing "</script>" would close the tag early and inject markup. Escaping "<"
// and the JS line separators U+2028/U+2029 to their \u form keeps the JSON valid and
// identical when parsed, but it can never break out of the <script> element.
const UNSAFE_JSON_CHARS = new RegExp("[<\\u2028\\u2029]", "g");

function safeJsonLocals(req, res, next) {
  res.locals.safeJson = (value) =>
    JSON.stringify(value === undefined ? null : value).replace(
      UNSAFE_JSON_CHARS,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
    );
  next();
}

function flashMiddleware(req, _res, next) {
  if (req.session.flash) {
    req.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
}

module.exports = { safeJsonLocals, flashMiddleware };
