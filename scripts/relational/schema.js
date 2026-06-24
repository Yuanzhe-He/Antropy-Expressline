// Re-export of the shared DDL (single source of truth — see
// src/lib/store/relational-repo). Kept so existing script imports keep working.
const repo = require("../../src/lib/store/relational-repo");

module.exports = {
  buildSchemaDDL: repo.buildSchemaDDL,
  buildDropDDL: repo.buildDropDDL,
  RELATIONAL_TABLES: repo.RELATIONAL_TABLES,
  q: repo.q,
};
