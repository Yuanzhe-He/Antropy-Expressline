// Inland (Transporte) seed catalog.
//
// Source of truth for the destination catalog (Appendix B of the task plan) and
// the raw CSV DESTINO -> canonical destination id mapping (incl. split rules).
// Shared by store.js (data-model seed) and scripts/seed-inland-from-csv.js.
//
// Coordinates are city / industrial-zone representative points and are editable
// in the admin; `needsReview` flags destinations whose representative point is a
// broad area and should be refined with precise receiving points.

const INLAND_ORIGINS = Object.freeze([
  { id: "manzanillo", name: "Manzanillo", lat: 19.0522, lng: -104.3158 },
]);

// id, name, state, lat, lng, needsReview
const INLAND_DESTINATION_CATALOG = Object.freeze([
  { id: "apodaca", name: "Apodaca", state: "NL", lat: 25.7817, lng: -100.1882 },
  { id: "monterrey", name: "Monterrey", state: "NL", lat: 25.6866, lng: -100.3161 },
  { id: "guadalupe-nl", name: "Guadalupe (NL)", state: "NL", lat: 25.677, lng: -100.259 },
  { id: "salinas-victoria", name: "Salinas Victoria", state: "NL", lat: 25.965, lng: -100.295 },
  { id: "saltillo", name: "Saltillo", state: "COAH", lat: 25.4383, lng: -101.0053 },
  { id: "ramos-arizpe", name: "Ramos Arizpe", state: "COAH", lat: 25.54, lng: -100.947 },
  { id: "torreon", name: "Torreón", state: "COAH", lat: 25.5428, lng: -103.4068 },
  { id: "queretaro", name: "Querétaro", state: "QRO", lat: 20.5888, lng: -100.3899 },
  { id: "san-juan-del-rio", name: "San Juan del Río", state: "QRO", lat: 20.389, lng: -99.996 },
  { id: "san-miguel-de-allende", name: "San Miguel de Allende", state: "GTO", lat: 20.914, lng: -100.743 },
  { id: "celaya", name: "Celaya", state: "GTO", lat: 20.523, lng: -100.8157 },
  { id: "leon", name: "León", state: "GTO", lat: 21.122, lng: -101.686 },
  { id: "silao", name: "Silao", state: "GTO", lat: 20.948, lng: -101.427 },
  { id: "irapuato", name: "Irapuato", state: "GTO", lat: 20.6767, lng: -101.3563 },
  { id: "san-luis-potosi", name: "San Luis Potosí", state: "SLP", lat: 22.1565, lng: -100.9855 },
  { id: "aguascalientes", name: "Aguascalientes", state: "AGS", lat: 21.8853, lng: -102.2916 },
  { id: "lagos-de-moreno", name: "Lagos de Moreno", state: "JAL", lat: 21.3563, lng: -101.9296 },
  { id: "guadalajara", name: "Guadalajara", state: "JAL", lat: 20.6597, lng: -103.3496 },
  { id: "zapopan", name: "Zapopan", state: "JAL", lat: 20.7214, lng: -103.3918 },
  { id: "tlajomulco", name: "Tlajomulco de Zúñiga", state: "JAL", lat: 20.4736, lng: -103.443 },
  { id: "ocotlan", name: "Ocotlán", state: "JAL", lat: 20.355, lng: -102.774 },
  { id: "ixtlahuacan-de-los-membrillos", name: "Ixtlahuacán de los Membrillos", state: "JAL", lat: 20.347, lng: -103.193 },
  { id: "cdmx", name: "CDMX", state: "CDMX", lat: 19.4326, lng: -99.1332 },
  { id: "edomex", name: "Edomex", state: "EDOMEX", lat: 19.2826, lng: -99.6557, coordSource: "seed-catalog-confirmed" },
  { id: "pantaco", name: "Pantaco (Terminal, CDMX)", state: "CDMX", lat: 19.4878, lng: -99.1893 },
  { id: "tlalpan", name: "Tlalpan (CDMX)", state: "CDMX", lat: 19.288, lng: -99.165 },
  { id: "ecatepec", name: "Ecatepec", state: "EDOMEX", lat: 19.601, lng: -99.052 },
  { id: "cuautitlan-izcalli", name: "Cuautitlán Izcalli", state: "EDOMEX", lat: 19.647, lng: -99.212 },
  { id: "tepotzotlan", name: "Tepotzotlán", state: "EDOMEX", lat: 19.716, lng: -99.224 },
  { id: "tepeji-del-rio", name: "Tepeji del Río", state: "HGO", lat: 19.904, lng: -99.341 },
  { id: "chalco", name: "Chalco", state: "EDOMEX", lat: 19.2647, lng: -98.8975 },
  { id: "morelos", name: "Morelos (Cuernavaca/CIVAC)", state: "MOR", lat: 18.835, lng: -99.178, coordSource: "seed-catalog-confirmed" },
  { id: "puebla", name: "Puebla", state: "PUE", lat: 19.0414, lng: -98.2063 },
  { id: "tlaxcala", name: "Tlaxcala", state: "TLAX", lat: 19.3139, lng: -98.2404 },
  { id: "nuevo-laredo", name: "Nuevo Laredo", state: "TAMPS", lat: 27.4763, lng: -99.5164 },
  { id: "reynosa", name: "Reynosa", state: "TAMPS", lat: 26.0508, lng: -98.2979 },
  { id: "ciudad-acuna", name: "Ciudad Acuña", state: "COAH", lat: 29.324, lng: -100.952 },
  { id: "chihuahua", name: "Chihuahua", state: "CHIH", lat: 28.632, lng: -106.0691 },
  { id: "hermosillo", name: "Hermosillo", state: "SON", lat: 29.073, lng: -110.9559 },
  { id: "tijuana", name: "Tijuana", state: "BC", lat: 32.5149, lng: -117.0382 },
  { id: "la-paz", name: "La Paz (BCS)", state: "BCS", lat: 24.1426, lng: -110.3128 },
  { id: "merida", name: "Mérida", state: "YUC", lat: 20.9674, lng: -89.5926 },
  { id: "villahermosa", name: "Villahermosa", state: "TAB", lat: 17.9895, lng: -92.9475 },
]);

// Normalize a raw CSV DESTINO value to a stable lookup key:
// uppercase, collapse whitespace, and drop spaces around slashes so that
// "LEON/SILAO /IRAPUATO" and "JALISCO/GUADALAJARA/ ZAPOPAN" match.
function normalizeDestinoKey(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

// Raw CSV DESTINO (normalized) -> canonical destination ids. A single raw value
// may expand to several destinations (split rules).
const INLAND_DESTINO_MAP = Object.freeze({
  APODACA: ["apodaca"],
  MONTERREY: ["monterrey"],
  "GUADALUPE NUEVO LEON": ["guadalupe-nl"],
  "SALINAS VICTORIA": ["salinas-victoria"],
  SALTILLO: ["saltillo"],
  "RAMOS ARIZPE": ["ramos-arizpe"],
  TORREON: ["torreon"],
  QUERETARO: ["queretaro"],
  "SAN JUAN DEL RIO": ["san-juan-del-rio"],
  "SAN MIGUEL DE ALLENDE": ["san-miguel-de-allende"],
  CELAYA: ["celaya"],
  "LEON/SILAO/IRAPUATO": ["leon", "silao", "irapuato"],
  "SAN LUIS POTOSI": ["san-luis-potosi"],
  AGUASCALIENTES: ["aguascalientes"],
  "LAGOS DE MORENO JALISCO": ["lagos-de-moreno"],
  GUADALAJARA: ["guadalajara"],
  ZAPOPAN: ["zapopan"],
  "JALISCO/GUADALAJARA/ZAPOPAN": ["guadalajara", "zapopan"],
  "JALISCO TLAJOMULCO": ["tlajomulco"],
  "JALISCO OCOTLAN": ["ocotlan"],
  "JALISCO IZTLADE LOS MEMBRILLOS": ["ixtlahuacan-de-los-membrillos"],
  "CDMX EDOMEX": ["cdmx", "edomex"],
  PANTACO: ["pantaco"],
  TLALPAN: ["tlalpan"],
  ECATEPEC: ["ecatepec"],
  "CUATITLAN IZACALI": ["cuautitlan-izcalli"],
  TEPOTZOTLAN: ["tepotzotlan"],
  "TEPEJI DEL RIO": ["tepeji-del-rio"],
  CHALCO: ["chalco"],
  MORELOS: ["morelos"],
  PUEBLA: ["puebla"],
  TLAXCALA: ["tlaxcala"],
  "NUEVO LAREDO": ["nuevo-laredo"],
  REYNOSA: ["reynosa"],
  "CIUDAD ACUÑA COAH": ["ciudad-acuna"],
  CHIHUAHUA: ["chihuahua"],
  HERMOSILLO: ["hermosillo"],
  TIJUANA: ["tijuana"],
  "LA PAZ": ["la-paz"],
  MERIDA: ["merida"],
  "VILLA HERMOSA": ["villahermosa"],
});

const DEFAULT_INLAND_ORIGIN_ID = INLAND_ORIGINS[0].id;

function resolveDestinoIds(raw) {
  return INLAND_DESTINO_MAP[normalizeDestinoKey(raw)] || [];
}

module.exports = {
  INLAND_ORIGINS,
  INLAND_DESTINATION_CATALOG,
  INLAND_DESTINO_MAP,
  DEFAULT_INLAND_ORIGIN_ID,
  normalizeDestinoKey,
  resolveDestinoIds,
};
