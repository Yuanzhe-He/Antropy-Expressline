"use strict";

/**
 * CONTENTO Manzanillo empty-container return yards (patios de vacío).
 *
 * Source: CONTENTO supplier price sheet ("Presentación de Servicios para Yisel
 * Guzmán", effective 2026-06-01) — a COST quote CONTENTO gives Express Line, not
 * a customer-facing price. These feed `modules.customs.yards[].dropoffCharges`,
 * which `calculate.js` consumes on the COST side only (never auto-added to the
 * customer quote in `quote.js`). See round16 architecture note.
 *
 * Método B (Chandler, round15): seed the stations + prices now, leave
 * `shippingLineIds` EMPTY. José will later provide the naviera↔patio mapping.
 *
 * IMPORTANT (data provenance): the original CONTENTO PDF was NOT present in the
 * repo when this seed was authored, so only two maniobra prices are confirmed
 * (Servimaniobras 3800, Contecon R.F. 4100) and the standard wash fee (550 MXN).
 * Every other station's maniobra price is a PLACEHOLDER (0) flagged in its note
 * and must be reconciled against the real PDF before the yards are wired to a
 * shipping line. Until `shippingLineIds` is filled, these yards are inert (no
 * line selects them, so 0-priced maniobra cannot mis-cost anything).
 *
 * All amounts are MXN +IVA (taxRate 0.16). Maniobra is a flat per-container fee;
 * we store it uniformly across every container type (the admin yard editor and
 * the cost calculator both key off per-type groupRates — there is no flat
 * `amount` input for yard charges), so José can later differentiate by size.
 */

const STANDARD_WASH_MXN = 550;

// name      : display name (as it appears on the CONTENTO sheet)
// slug       : id suffix
// maniobra   : confirmed maniobra de vacío price in MXN, or null if pending PDF
// lineHint   : shipping-line clue embedded in the patio name (kept as a NOTE only;
//              shippingLineIds stays empty until José confirms — método B)
const CONTENTO_MANZANILLO_STATIONS = [
  { name: "Servimaniobras", slug: "servimaniobras", maniobra: 3800, lineHint: null },
  { name: "Contecon (R.F.)", slug: "contecon-rf", maniobra: 4100, lineHint: null },
  { name: "Fali", slug: "fali", maniobra: null, lineHint: null },
  { name: "SICE", slug: "sice", maniobra: null, lineHint: null },
  { name: "Hadron Logistics", slug: "hadron-logistics", maniobra: null, lineHint: null },
  { name: "Emilu", slug: "emilu", maniobra: null, lineHint: null },
  { name: "Hazesa", slug: "hazesa", maniobra: null, lineHint: null },
  { name: "Aflex", slug: "aflex", maniobra: null, lineHint: null },
  { name: "Container Care (TIMSA)", slug: "container-care-timsa", maniobra: null, lineHint: "TIMSA" },
  { name: "SLTC", slug: "sltc", maniobra: null, lineHint: null },
  { name: "Mepacsa", slug: "mepacsa", maniobra: null, lineHint: null },
  { name: "Express Port Manzanillo", slug: "express-port-manzanillo", maniobra: null, lineHint: null },
  { name: "Hazesa (KMCT)", slug: "hazesa-kmct", maniobra: null, lineHint: "KMCT" },
  { name: "SSA", slug: "ssa", maniobra: null, lineHint: null },
  { name: "Ocupa", slug: "ocupa", maniobra: null, lineHint: null },
  { name: "Impala Terminals México", slug: "impala-terminals-mexico", maniobra: null, lineHint: null },
  { name: "ISL Transportes", slug: "isl-transportes", maniobra: null, lineHint: null },
  { name: "Consignataria Oceánica (Sinotrans)", slug: "consignataria-oceanica-sinotrans", maniobra: null, lineHint: "Sinotrans" },
  { name: "Damco (Maersk)", slug: "damco-maersk", maniobra: null, lineHint: "Maersk" },
  { name: "Alman", slug: "alman", maniobra: null, lineHint: null },
  { name: "Shanghai (Agunza TC-Lines)", slug: "shanghai-agunza-tc-lines", maniobra: null, lineHint: "Agunza / TC-Lines" },
  { name: "Impala Containers Yard", slug: "impala-containers-yard", maniobra: null, lineHint: null },
  { name: "Alsecont", slug: "alsecont", maniobra: null, lineHint: null },
  { name: "CIMA", slug: "cima", maniobra: null, lineHint: null },
  { name: "PTD", slug: "ptd", maniobra: null, lineHint: null },
  { name: "TEP", slug: "tep", maniobra: null, lineHint: null },
];

function buildUniformGroupRates(containerTypes, rate, currency) {
  const groupRates = {};
  for (const type of containerTypes || []) {
    groupRates[type.key] = {
      label: type.label,
      qtyHint: 1,
      currency,
      rate,
    };
  }
  return groupRates;
}

function buildStationNote(station) {
  const parts = [
    "Fuente: CONTENTO (cotización a Yisel Guzmán, 2026-06-01).",
    "Naviera↔patio pendiente: José confirmará la relación (método B).",
  ];
  if (station.maniobra == null) {
    parts.push("Maniobra pendiente de confirmar contra PDF CONTENTO.");
  }
  if (station.lineHint) {
    parts.push(`Pista de naviera en el nombre: ${station.lineHint}.`);
  }
  return parts.join(" ");
}

/**
 * Build the CONTENTO Manzanillo yard list in persisted (pre-normalize) shape.
 * groupRates are keyed by the given containerTypes' keys; the store normalizer
 * re-keys/zero-fills against the live container taxonomy on load (back-compat).
 */
function buildContentoManzanilloYards(containerTypes, currency = "MXN") {
  return CONTENTO_MANZANILLO_STATIONS.map((station) => {
    const id = `yard-mzo-contento-${station.slug}`;
    return {
      id,
      name: station.name,
      note: buildStationNote(station),
      portIds: ["manzanillo"],
      // Método B: keep empty until José gives the naviera↔patio mapping.
      shippingLineIds: [],
      dropoffCharges: [
        {
          id: `${id}-maniobra`,
          concept: "Maniobra de vacío (devolución)",
          note:
            station.maniobra == null
              ? "Precio pendiente: confirmar maniobra contra el PDF de CONTENTO."
              : null,
          taxRate: 0.16,
          groupRates: buildUniformGroupRates(
            containerTypes,
            station.maniobra == null ? 0 : station.maniobra,
            currency
          ),
        },
        {
          id: `${id}-limpieza`,
          concept: "Limpieza de contenedor (estándar)",
          note:
            "Estándar 550 MXN; reefer 750; open top (enlonado) 1150; especial/relavado: bajo cotización. Todo +IVA.",
          taxRate: 0.16,
          groupRates: buildUniformGroupRates(containerTypes, STANDARD_WASH_MXN, currency),
        },
      ],
      // CONTENTO patios only handle empty-container return (no customs service).
      customsCharges: [],
    };
  });
}

module.exports = {
  CONTENTO_MANZANILLO_STATIONS,
  STANDARD_WASH_MXN,
  buildContentoManzanilloYards,
};
