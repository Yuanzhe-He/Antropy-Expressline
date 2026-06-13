const BUSINESS_MODULES = Object.freeze([
  {
    key: "handover",
    implemented: true,
  },
  {
    key: "customs",
    implemented: true,
  },
  {
    key: "inland",
    implemented: true,
  },
]);

const DEFAULT_MODULE_KEY = BUSINESS_MODULES[0].key;

function getBusinessModule(moduleKey) {
  return BUSINESS_MODULES.find((module) => module.key === moduleKey) || null;
}

function normalizeModuleKey(moduleKey, fallback = DEFAULT_MODULE_KEY) {
  return getBusinessModule(moduleKey)?.key || fallback;
}

module.exports = {
  BUSINESS_MODULES,
  DEFAULT_MODULE_KEY,
  getBusinessModule,
  normalizeModuleKey,
};
