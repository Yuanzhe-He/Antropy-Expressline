// Inland admin routes: origins / destinations (+ precise points) / rate-entries
// + the route-cache refresh / manual override. Pure move from server.js — route
// bodies are byte-for-byte the originals. markRouteStale + refreshOneInlandRoute
// (the inland route-cache closures) move with the routes. server.js helpers
// arrive via ctx; lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveModule } = require("../lib/store");
const { resolveLink } = require("../lib/inland-link-resolver");
const {
  decodePolyline,
  computeViaCities,
  getRoutingProvider,
} = require("../lib/inland-routes");
const { EXTRA_VEHICLE_KEYS } = require("../lib/inland-vehicles");

function register(app, ctx) {
  const { loadShippingData, getModuleData, redirectWithFlash, baseView } = ctx;

  // --- Inland admin ---
  const INLAND_ADMIN_TARGET = "/admin/inland/shipping-lines";

  app.post("/admin/inland/resolve-link", requireAuth, async (req, res) => {
    const result = await resolveLink(req.body.link || "");
    if (result.error) {
      return res.status(422).json({ error: result.error });
    }
    return res.json({
      lat: result.lat,
      lng: result.lng,
      name: result.name,
      normalizedLink: result.normalizedLink,
      warning: result.warning,
    });
  });

  function markRouteStale(inland, destinationId) {
    (inland.routeCache || []).forEach((rc) => {
      if (rc.destinationId === destinationId) {
        rc.stale = true;
      }
    });
  }

  async function refreshOneInlandRoute(inland, origin, target) {
    // S4: route via the configured provider (OSRM default; Google when keyed).
    // via-city snapping stays here so it is provider-agnostic.
    const provider = getRoutingProvider();
    const route = await provider.fetchRoute(origin, { lat: target.lat, lng: target.lng });
    const viaCities = computeViaCities(decodePolyline(route.encodedPolyline));
    const entry = {
      id: `rc-${target.destinationId}-${target.targetType}${target.targetId ? `-${target.targetId}` : ""}`,
      originId: origin.id,
      destinationId: target.destinationId,
      targetType: target.targetType,
      targetId: target.targetId,
      encodedPolyline: route.encodedPolyline,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      viaCities,
      engine: route.engine,
      fetchedAt: new Date().toISOString(),
      stale: false,
      hasFerry: route.hasFerry,
    };
    inland.routeCache = inland.routeCache || [];
    const existing = inland.routeCache.find(
      (rc) =>
        rc.destinationId === target.destinationId &&
        rc.targetType === target.targetType &&
        (rc.targetId || null) === (target.targetId || null)
    );
    if (existing) {
      Object.assign(existing, entry, { id: existing.id });
    } else {
      inland.routeCache.push(entry);
    }
  }

  app.post("/admin/inland/routes/refresh", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const origin = (inland.origins && inland.origins[0]) || null;
    if (!origin) {
      return redirectWithFlash(req, res, "error", req.t("inland.routeRefreshFailed"), INLAND_ADMIN_TARGET);
    }

    const onlyId = String(req.body.destinationId || "").trim();
    const targets = [];
    for (const dest of inland.destinations || []) {
      if (dest.lat == null || dest.lng == null) continue;
      if (onlyId && dest.id !== onlyId) continue;
      const cache = (inland.routeCache || []).find(
        (rc) => rc.destinationId === dest.id && rc.targetType === "destination"
      );
      if (!onlyId && cache && !cache.stale) continue; // "all" only fills missing/stale
      targets.push({ destinationId: dest.id, targetType: "destination", targetId: null, lat: dest.lat, lng: dest.lng });
      for (const point of dest.precisePoints || []) {
        if (point.lat != null && point.lng != null) {
          targets.push({ destinationId: dest.id, targetType: "precisePoint", targetId: point.id, lat: point.lat, lng: point.lng });
        }
      }
    }

    let ok = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await refreshOneInlandRoute(inland, origin, target);
        ok += 1;
      } catch (_error) {
        failed += 1;
      }
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(
      req,
      res,
      failed ? "error" : "success",
      req.t("inland.routeRefreshed", { ok, failed }),
      INLAND_ADMIN_TARGET
    );
  });

  // S4 manual override: operator-entered km / minutes / via-cities for a route.
  app.post("/admin/inland/routes/:destId/override", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destId = String(req.params.destId || "").trim();
    const rc = (inland.routeCache || []).find(
      (r) => r.destinationId === destId && r.targetType === "destination"
    );
    if (!rc) {
      return redirectWithFlash(req, res, "error", req.t("inland.routeNone"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
    }
    const toNum = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = Number(s.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    rc.manualOverride = {
      distanceKm: toNum(req.body.ovr_km),
      durationMin: toNum(req.body.ovr_min),
      viaCities: String(req.body.ovr_via || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.routeOverrideSaved"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
  });

  app.post("/admin/inland/routes/:destId/clear-override", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destId = String(req.params.destId || "").trim();
    const rc = (inland.routeCache || []).find(
      (r) => r.destinationId === destId && r.targetType === "destination"
    );
    if (rc) rc.manualOverride = null;
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.routeOverrideCleared"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
  });

  // O5 (20260617): admin-managed origins. New origins start with NO rate entries
  // (empty shell). The seed origin (Manzanillo) and its rates are untouched.
  app.post("/admin/inland/origins/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    let name = String(req.body.name || "").trim();
    const link = String(req.body.link || "").trim();
    let lat = req.body.lat ? Number(req.body.lat) : null;
    let lng = req.body.lng ? Number(req.body.lng) : null;
    if (link) {
      const resolved = await resolveLink(link);
      if (resolved.error) {
        return redirectWithFlash(req, res, "error", req.t("inland.linkFailed", { error: resolved.error }), `${INLAND_ADMIN_TARGET}#inland-origins`);
      }
      lat = resolved.lat;
      lng = resolved.lng;
      if (!name && resolved.name) name = resolved.name;
    }
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), `${INLAND_ADMIN_TARGET}#inland-origins`);
    }
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `origin-${Date.now()}`;
    let oid = baseId;
    let oi = 2;
    inland.origins = inland.origins || [];
    while (inland.origins.some((o) => o.id === oid)) {
      oid = `${baseId}-${oi++}`;
    }
    inland.origins.push({ id: oid, name, lat, lng });
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originAdded", { name }), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/origins/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    for (const origin of inland.origins || []) {
      const name = req.body[`origin_name_${origin.id}`];
      if (name !== undefined) origin.name = String(name).trim() || origin.name;
      const lat = req.body[`origin_lat_${origin.id}`];
      if (lat !== undefined) origin.lat = String(lat).trim() === "" ? null : Number(lat);
      const lng = req.body[`origin_lng_${origin.id}`];
      if (lng !== undefined) origin.lng = String(lng).trim() === "" ? null : Number(lng);
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originsSaved"), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/origins/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const origins = inland.origins || [];
    const hasRates = (inland.rateEntries || []).some((r) => r.originId === req.params.id);
    if (origins.length <= 1 || hasRates) {
      // keep at least one origin; never orphan rate entries
      return redirectWithFlash(req, res, "error", req.t("inland.originDeleteBlocked"), `${INLAND_ADMIN_TARGET}#inland-origins`);
    }
    inland.origins = origins.filter((o) => o.id !== req.params.id);
    inland.routeCache = (inland.routeCache || []).filter((rc) => rc.originId !== req.params.id);
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originDeleted"), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/destinations/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const name = String(req.body.name || "").trim();
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), INLAND_ADMIN_TARGET);
    }
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `dest-${Date.now()}`;
    let id = baseId;
    let n = 2;
    while ((inland.destinations || []).some((d) => d.id === id)) {
      id = `${baseId}-${n++}`;
    }
    inland.destinations = inland.destinations || [];
    inland.destinations.push({
      id,
      name,
      state: String(req.body.state || "").trim(),
      lat: req.body.lat ? Number(req.body.lat) : null,
      lng: req.body.lng ? Number(req.body.lng) : null,
      coordSource: "manual",
      needsReview: false,
      precisePoints: [],
      enabled: true,
      note: "",
    });
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.destAdded", { name }), `${INLAND_ADMIN_TARGET}#dest-${id}`);
  });

  app.post("/admin/inland/destinations/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    for (const dest of inland.destinations || []) {
      if (req.body[`dest_present_${dest.id}`] === undefined) continue;
      const name = req.body[`dest_name_${dest.id}`];
      if (name !== undefined) dest.name = String(name).trim() || dest.name;
      // O6.5: optional bilingual display names.
      const nameZh = req.body[`dest_nameZh_${dest.id}`];
      if (nameZh !== undefined) dest.nameZh = String(nameZh).trim();
      const nameEs = req.body[`dest_nameEs_${dest.id}`];
      if (nameEs !== undefined) dest.nameEs = String(nameEs).trim();
      const state = req.body[`dest_state_${dest.id}`];
      if (state !== undefined) dest.state = String(state).trim();
      const note = req.body[`dest_note_${dest.id}`];
      if (note !== undefined) dest.note = String(note);
      // S3 case photos: store the raw textarea (one URL/line); normalizeShippingData
      // (normalizeImageUrls) on save keeps only http(s), dedupes, caps.
      const images = req.body[`dest_images_${dest.id}`];
      if (images !== undefined) dest.imageUrls = String(images);
      dest.enabled = req.body[`dest_enabled_${dest.id}`] !== undefined;

      const link = String(req.body[`dest_coordlink_${dest.id}`] || "").trim();
      if (link) {
        const resolved = await resolveLink(link);
        if (!resolved.error) {
          dest.lat = resolved.lat;
          dest.lng = resolved.lng;
          dest.coordSource = /^https?:/i.test(link) ? "gmaps-link" : "manual";
          dest.needsReview = false;
          markRouteStale(inland, dest.id);
        }
      } else {
        const lat = req.body[`dest_lat_${dest.id}`];
        const lng = req.body[`dest_lng_${dest.id}`];
        if (lat !== undefined && lng !== undefined && lat !== "" && lng !== "") {
          const nextLat = Number(lat);
          const nextLng = Number(lng);
          if (nextLat !== dest.lat || nextLng !== dest.lng) {
            dest.lat = nextLat;
            dest.lng = nextLng;
            dest.coordSource = "manual";
            markRouteStale(inland, dest.id);
          }
        }
      }
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.saved"), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/destinations/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    inland.destinations = inland.destinations.filter((d) => d.id !== req.params.id);
    inland.rateEntries = (inland.rateEntries || []).filter((e) => e.destinationId !== req.params.id);
    inland.routeCache = (inland.routeCache || []).filter((rc) => rc.destinationId !== req.params.id);
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.destDeleted", { name: dest.name }), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/destinations/:id/precise-points/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    const link = String(req.body.link || "").trim();
    let lat = req.body.lat ? Number(req.body.lat) : null;
    let lng = req.body.lng ? Number(req.body.lng) : null;
    let name = String(req.body.name || "").trim();
    let source = "manual";
    if (link) {
      const resolved = await resolveLink(link);
      if (resolved.error) {
        return redirectWithFlash(req, res, "error", req.t("inland.linkFailed", { error: resolved.error }), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
      }
      lat = resolved.lat;
      lng = resolved.lng;
      if (!name && resolved.name) name = resolved.name;
      source = /^https?:/i.test(link) ? "gmaps-link" : "manual";
    }
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
    }
    dest.precisePoints = dest.precisePoints || [];
    const flatRaw = req.body.flatPrice;
    const newPoint = {
      id: `pp-${dest.id}-${Date.now().toString(36)}`,
      name,
      lat,
      lng,
      // S1: optional flat all-in price (一口价). Empty -> null -> inherit city rate.
      flatPrice: flatRaw !== undefined && String(flatRaw).trim() !== "" ? Number(flatRaw) : null,
      note: String(req.body.note || ""),
      source,
      link: /^https?:/i.test(link) ? link : "",
    };
    dest.precisePoints.push(newPoint);
    // O6.1 (20260617): auto-fetch this precise point's route so the map can draw
    // a line to the exact point immediately (was: only the destination-level route
    // existed until a manual "refresh routes"). Non-fatal — provider failures just
    // leave the route to be filled by a later refresh.
    const origin = (inland.origins && inland.origins[0]) || null;
    if (origin && newPoint.lat != null && newPoint.lng != null) {
      try {
        await refreshOneInlandRoute(inland, origin, {
          destinationId: dest.id,
          targetType: "precisePoint",
          targetId: newPoint.id,
          lat: newPoint.lat,
          lng: newPoint.lng,
        });
      } catch (_error) {
        // leave route uncached; admin can refresh later
      }
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseAdded", { name }), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  app.post("/admin/inland/destinations/:id/precise-points/:pointId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    dest.precisePoints = (dest.precisePoints || []).filter((p) => p.id !== req.params.pointId);
    inland.routeCache = (inland.routeCache || []).filter(
      (rc) => !(rc.destinationId === dest.id && rc.targetType === "precisePoint" && rc.targetId === req.params.pointId)
    );
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseDeleted"), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  // S1: edit a precise point's flat price (一口价). Empty clears it (inherit city rate).
  app.post("/admin/inland/destinations/:id/precise-points/:pointId/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    const point = dest && (dest.precisePoints || []).find((p) => p.id === req.params.pointId);
    if (!dest || !point) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    // B3 (QA): edit name / coords / flat price (was flatPrice-only). A pasted
    // Maps link or new coords re-fetches the point's route.
    if (req.body.name !== undefined && String(req.body.name).trim()) {
      point.name = String(req.body.name).trim();
    }
    const prevLat = point.lat;
    const prevLng = point.lng;
    const link = String(req.body.link || "").trim();
    if (link) {
      const resolved = await resolveLink(link);
      if (resolved.error) {
        return redirectWithFlash(req, res, "error", req.t("inland.linkFailed", { error: resolved.error }), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
      }
      point.lat = resolved.lat;
      point.lng = resolved.lng;
      point.source = /^https?:/i.test(link) ? "gmaps-link" : "manual";
      point.link = /^https?:/i.test(link) ? link : point.link;
    } else {
      if (req.body.lat !== undefined && String(req.body.lat).trim() !== "") point.lat = Number(req.body.lat);
      if (req.body.lng !== undefined && String(req.body.lng).trim() !== "") point.lng = Number(req.body.lng);
    }
    const raw = req.body.flatPrice;
    point.flatPrice = raw !== undefined && String(raw).trim() !== "" ? Number(raw) : null;
    // re-fetch this point's route when coordinates changed
    const coordsChanged = point.lat !== prevLat || point.lng !== prevLng;
    const origin = (inland.origins && inland.origins[0]) || null;
    if (coordsChanged && origin && point.lat != null && point.lng != null) {
      try {
        await refreshOneInlandRoute(inland, origin, {
          destinationId: dest.id,
          targetType: "precisePoint",
          targetId: point.id,
          lat: point.lat,
          lng: point.lng,
        });
      } catch (_error) {
        // non-fatal; admin can refresh routes later
      }
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseSaved") || "OK", `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  app.post("/admin/inland/rate-entries/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destinationId = String(req.body.destinationId || "").trim();
    if (!(inland.destinations || []).some((d) => d.id === destinationId)) {
      return redirectWithFlash(req, res, "error", req.t("inland.destRequired"), INLAND_ADMIN_TARGET);
    }
    inland.rateEntries = inland.rateEntries || [];
    inland.rateEntries.push({
      id: `re-${destinationId}-${Date.now().toString(36)}`,
      originId: (inland.origins && inland.origins[0] && inland.origins[0].id) || "manzanillo",
      destinationId,
      proveedor: "",
      sencillo: null,
      full: null,
      currency: "MXN",
      cliente: "",
      codigoCw: "",
      commodity: "",
      enabled: true,
      note: "",
      extras: {},
    });
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.rateAdded"), `${INLAND_ADMIN_TARGET}#dest-${destinationId}`);
  });

  app.post("/admin/inland/rate-entries/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const toAmount = (value) => {
      if (value === undefined || value === null || String(value).trim() === "") return null;
      const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    for (const entry of inland.rateEntries || []) {
      if (req.body[`re_present_${entry.id}`] === undefined) continue;
      const p = req.body[`re_proveedor_${entry.id}`];
      if (p !== undefined) entry.proveedor = String(p).trim();
      if (req.body[`re_sencillo_${entry.id}`] !== undefined) entry.sencillo = toAmount(req.body[`re_sencillo_${entry.id}`]);
      if (req.body[`re_full_${entry.id}`] !== undefined) entry.full = toAmount(req.body[`re_full_${entry.id}`]);
      if (
        req.body[`re_burreoS_${entry.id}`] !== undefined ||
        req.body[`re_burreoF_${entry.id}`] !== undefined
      ) {
        const bS = toAmount(req.body[`re_burreoS_${entry.id}`]);
        const bF = toAmount(req.body[`re_burreoF_${entry.id}`]);
        entry.burreo = bS === null && bF === null ? null : { sencillo: bS, full: bF };
      }
      // S2: the 4 extra vehicle tiers (sencillo/full handled above as legacy fields).
      entry.vehiclePrices = entry.vehiclePrices || {};
      for (const vType of EXTRA_VEHICLE_KEYS) {
        const field = `re_veh_${vType}_${entry.id}`;
        if (req.body[field] !== undefined) {
          entry.vehiclePrices[vType] = toAmount(req.body[field]);
        }
      }
      const cli = req.body[`re_cliente_${entry.id}`];
      if (cli !== undefined) entry.cliente = String(cli).trim();
      const cw = req.body[`re_codigocw_${entry.id}`];
      if (cw !== undefined) entry.codigoCw = String(cw).trim();
      const com = req.body[`re_commodity_${entry.id}`];
      if (com !== undefined) entry.commodity = String(com).trim();
      const note = req.body[`re_note_${entry.id}`];
      if (note !== undefined) entry.note = String(note);
      entry.enabled = req.body[`re_enabled_${entry.id}`] !== undefined;
    }
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.saved"), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/rate-entries/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const entry = (inland.rateEntries || []).find((e) => e.id === req.params.id);
    inland.rateEntries = (inland.rateEntries || []).filter((e) => e.id !== req.params.id);
    shippingData.modules.inland = inland;
    await saveModule("inland", shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("inland.rateDeleted"),
      entry ? `${INLAND_ADMIN_TARGET}#dest-${entry.destinationId}` : INLAND_ADMIN_TARGET
    );
  });
}

module.exports = { register };
