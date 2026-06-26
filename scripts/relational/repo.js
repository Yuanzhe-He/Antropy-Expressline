// Re-export of the shared relational repo so sandbox scripts and the app facade
// run the SAME code (single source of truth — see src/lib/db/relational-repo).
module.exports = require("../../src/lib/db/relational-repo");
