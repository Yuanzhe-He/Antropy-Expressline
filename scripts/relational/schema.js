// Re-export of the shared DDL (single source of truth — see
// src/lib/db/relational-repo). Kept so existing script imports keep working.
const repo = require("../../src/lib/db/relational-repo");

module.exports = {
  buildSchemaDDL: repo.buildSchemaDDL,
  buildDropDDL: repo.buildDropDDL,
  RELATIONAL_TABLES: repo.RELATIONAL_TABLES,
  q: repo.q,
};
