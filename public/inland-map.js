/* Inland (Transporte) map workbench: real route geometry + instant client-side
   quoting. No third-party deps beyond MapLibre GL (loaded globally). */
(function inlandMap() {
  const mapEl = document.querySelector("[data-inland-map]");
  if (!mapEl || typeof maplibregl === "undefined") {
    return;
  }

  const readJson = (id, fallback) => {
    const node = document.getElementById(id);
    if (!node) return fallback;
    try {
      return JSON.parse(node.textContent);
    } catch (_error) {
      return fallback;
    }
  };

  const data = readJson("inland-map-data", { origin: null, destinations: [], routes: [] });
  const initial = readJson("inland-initial", { formData: {}, hasResult: false });
  const i18n = readJson("inland-i18n", {});

  const STYLES = {
    light: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
  };
  const ACCENT = "#e23b3b";
  const currentTheme = () =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";

  // --- polyline decode (precision 5) ---
  function decodePolyline(encoded) {
    if (!encoded) return [];
    const factor = 1e5;
    const coords = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      lat += result & 1 ? ~(result >> 1) : result >> 1;
      result = 0;
      shift = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      lng += result & 1 ? ~(result >> 1) : result >> 1;
      coords.push([lng / factor, lat / factor]); // GeoJSON [lng, lat]
    }
    return coords;
  }

  const destById = new Map(data.destinations.map((d) => [d.id, d]));
  const routeByKey = new Map();
  data.routes.forEach((r) => {
    routeByKey.set(`${r.destinationId}|${r.targetType}|${r.targetId || ""}`, r);
  });
  const routeForDestination = (id) => routeByKey.get(`${id}|destination|`) || null;

  const fmtMoney = (value) =>
    Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // --- GeoJSON builders ---
  function routesGeoJson() {
    const features = [];
    data.routes
      .filter((r) => r.targetType === "destination" && r.encodedPolyline)
      .forEach((r) => {
        const coords = decodePolyline(r.encodedPolyline);
        if (coords.length < 2) return;
        features.push({
          type: "Feature",
          properties: { destinationId: r.destinationId, stale: r.stale ? 1 : 0 },
          geometry: { type: "LineString", coordinates: coords },
        });
      });
    return { type: "FeatureCollection", features };
  }

  function fallbackArc(dest) {
    // Great-circle-ish dashed arc when no cached route geometry exists.
    if (!data.origin || dest.lat == null || dest.lng == null) return null;
    const a = [data.origin.lng, data.origin.lat];
    const b = [dest.lng, dest.lat];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.12];
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * mid[0] + t * t * b[0];
      const y = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * mid[1] + t * t * b[1];
      pts.push([x, y]);
    }
    return { type: "Feature", properties: { destinationId: dest.id }, geometry: { type: "LineString", coordinates: pts } };
  }

  function destinationsGeoJson() {
    return {
      type: "FeatureCollection",
      features: data.destinations
        .filter((d) => d.enabled && d.lat != null && d.lng != null)
        .map((d) => ({
          type: "Feature",
          properties: {
            id: d.id,
            name: d.name,
            label: d.maxSencillo != null ? `${d.name} · $${Math.round(d.maxSencillo / 1000)}k` : d.name,
          },
          geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        })),
    };
  }

  // O6.4: precise points of the currently-selected destination, as map markers.
  function preciseGeoJson() {
    const dest = destById.get(selectedId);
    const points = (dest && dest.precisePoints) || [];
    return {
      type: "FeatureCollection",
      features: points
        .filter((p) => p.lat != null && p.lng != null)
        .map((p) => ({
          type: "Feature",
          properties: { id: p.id, name: p.name },
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        })),
    };
  }
  function updatePreciseLayer() {
    const src = map.getSource("inland-precise");
    if (src) src.setData(preciseGeoJson());
  }

  // --- map init ---
  const map = new maplibregl.Map({
    container: mapEl,
    style: STYLES[currentTheme()],
    center: data.origin ? [data.origin.lng + 6, data.origin.lat + 4] : [-102, 23],
    zoom: 4.2,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  let selectedId = "";
  let originMarker = null;

  function addLayers() {
    if (!map.getSource("inland-routes")) {
      map.addSource("inland-routes", { type: "geojson", data: routesGeoJson() });
    }
    if (!map.getSource("inland-selected")) {
      map.addSource("inland-selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("inland-destinations")) {
      map.addSource("inland-destinations", { type: "geojson", data: destinationsGeoJson() });
    }
    // O6.4: precise points of the selected destination, as clickable markers.
    if (!map.getSource("inland-precise")) {
      map.addSource("inland-precise", { type: "geojson", data: preciseGeoJson() });
    }

    if (!map.getLayer("inland-route-casing")) {
      map.addLayer({
        id: "inland-route-casing",
        type: "line",
        source: "inland-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": currentTheme() === "light" ? "#ffffff" : "#000000",
          "line-width": 5,
          "line-opacity": 0.5,
        },
      });
    }
    if (!map.getLayer("inland-route-line")) {
      map.addLayer({
        id: "inland-route-line",
        type: "line",
        source: "inland-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["case", ["==", ["get", "stale"], 1], "#8a8a8a", "#7aa2ff"],
          "line-width": 2.2,
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer("inland-selected-line")) {
      map.addLayer({
        id: "inland-selected-line",
        type: "line",
        source: "inland-selected",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 4,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getLayer("inland-dest-dot")) {
      map.addLayer({
        id: "inland-dest-dot",
        type: "circle",
        source: "inland-destinations",
        paint: {
          "circle-radius": ["case", ["==", ["get", "id"], selectedId], 7, 4.5],
          "circle-color": ["case", ["==", ["get", "id"], selectedId], ACCENT, "#cfd6e4"],
          "circle-stroke-color": currentTheme() === "light" ? "#1d2333" : "#0b0d12",
          "circle-stroke-width": 1.5,
        },
      });
    }
    // O6.4: precise-point markers (orange), clickable; selected one is larger.
    if (!map.getLayer("inland-precise-dot")) {
      map.addLayer({
        id: "inland-precise-dot",
        type: "circle",
        source: "inland-precise",
        paint: {
          "circle-radius": ["case", ["==", ["get", "id"], ["literal", ""]], 5, 6],
          "circle-color": "#f4a23b",
          "circle-stroke-color": currentTheme() === "light" ? "#1d2333" : "#0b0d12",
          "circle-stroke-width": 1.5,
        },
      });
    }
    if (!map.getLayer("inland-precise-label")) {
      map.addLayer({
        id: "inland-precise-label",
        type: "symbol",
        source: "inland-precise",
        layout: {
          "text-field": ["get", "name"],
          "text-size": 10,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#f4a23b",
          "text-halo-color": currentTheme() === "light" ? "#ffffff" : "#0b0d12",
          "text-halo-width": 1.2,
        },
      });
    }
    if (!map.getLayer("inland-dest-label")) {
      map.addLayer({
        id: "inland-dest-label",
        type: "symbol",
        source: "inland-destinations",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": currentTheme() === "light" ? "#1d2333" : "#e7ecf5",
          "text-halo-color": currentTheme() === "light" ? "#ffffff" : "#0b0d12",
          "text-halo-width": 1.4,
        },
      });
    }

    if (selectedId) {
      applySelectionLayer();
    }
    fitAll();
  }

  function setOriginMarker() {
    if (!data.origin || data.origin.lat == null) return;
    if (originMarker) originMarker.remove();
    const el = document.createElement("div");
    el.className = "inland-origin-pulse";
    originMarker = new maplibregl.Marker({ element: el })
      .setLngLat([data.origin.lng, data.origin.lat])
      .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setText(data.origin.name))
      .addTo(map);
  }

  function fitAll() {
    const pts = data.destinations.filter((d) => d.enabled && d.lat != null).map((d) => [d.lng, d.lat]);
    if (data.origin) pts.push([data.origin.lng, data.origin.lat]);
    if (pts.length < 2) return;
    const bounds = pts.reduce(
      (acc, p) => acc.extend(p),
      new maplibregl.LngLatBounds(pts[0], pts[0])
    );
    map.fitBounds(bounds, { padding: 60, duration: 0 });
  }

  function applySelectionLayer() {
    const dest = destById.get(selectedId);
    // O6.2: when a precise point is selected, draw ITS route (and fall back to its
    // exact coords), not the city-level destination route.
    const preciseId = (panel.preciseInput && panel.preciseInput.value) || "";
    const precisePoint = preciseId
      ? (dest?.precisePoints || []).find((p) => p.id === preciseId)
      : null;
    let feature = null;
    const cached = preciseId
      ? routeByKey.get(`${selectedId}|precisePoint|${preciseId}`)
      : routeForDestination(selectedId);
    if (cached && cached.encodedPolyline) {
      const coords = decodePolyline(cached.encodedPolyline);
      if (coords.length >= 2) {
        feature = { type: "Feature", properties: { destinationId: selectedId }, geometry: { type: "LineString", coordinates: coords } };
      }
    }
    if (!feature) {
      const arcTarget =
        precisePoint && precisePoint.lat != null ? precisePoint : dest;
      if (arcTarget) {
        feature = fallbackArc(arcTarget);
      }
    }
    const src = map.getSource("inland-selected");
    if (src) src.setData({ type: "FeatureCollection", features: feature ? [feature] : [] });

    // dim base routes, emphasize dots
    if (map.getLayer("inland-route-line")) {
      map.setPaintProperty("inland-route-line", "line-opacity", selectedId ? 0.25 : 0.85);
    }
    if (map.getLayer("inland-route-casing")) {
      map.setPaintProperty("inland-route-casing", "line-opacity", selectedId ? 0.2 : 0.5);
    }
    if (map.getLayer("inland-dest-dot")) {
      map.setPaintProperty("inland-dest-dot", "circle-radius", ["case", ["==", ["get", "id"], selectedId], 7, 4.5]);
      map.setPaintProperty("inland-dest-dot", "circle-color", ["case", ["==", ["get", "id"], selectedId], ACCENT, "#cfd6e4"]);
    }

    if (feature && feature.geometry.coordinates.length >= 2) {
      const coords = feature.geometry.coordinates;
      const bounds = coords.reduce(
        (acc, c) => acc.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      map.fitBounds(bounds, { padding: 70, duration: 700 });
    }
  }

  // --- dash flow animation on the selected line ---
  let dashStep = 0;
  function animateDash() {
    if (map.getLayer("inland-selected-line") && selectedId) {
      dashStep = (dashStep + 1) % 8;
      const seq = [
        [0, 4, 3], [1, 4, 2], [2, 4, 1], [3, 4, 0],
        [0, 1, 3, 3], [0, 2, 3, 2], [0, 3, 3, 1], [0, 4, 3, 0],
      ];
      map.setPaintProperty("inland-selected-line", "line-dasharray", seq[dashStep]);
    }
    setTimeout(() => requestAnimationFrame(animateDash), 90);
  }

  // --- quote panel ---
  const panel = {
    form: document.querySelector("[data-inland-form]"),
    destSelect: document.querySelector("[data-inland-destination]"),
    serviceInput: document.querySelector("[data-inland-service-input]"),
    qtyInput: document.querySelector("[data-inland-quantity]"),
    ivaInput: document.querySelector("[data-inland-iva-input]"),
    preciseInput: document.querySelector("[data-inland-precise-input]"),
    burreoWrap: document.querySelector("[data-inland-burreo-wrap]"),
    burreoCheck: document.querySelector("[data-inland-burreo-check]"),
    burreoInput: document.querySelector("[data-inland-burreo-input]"),
    burreoHint: document.querySelector("[data-inland-burreo-hint]"),
    burreoLine: document.querySelector("[data-inland-burreo-line]"),
    burreoLineLabel: document.querySelector("[data-inland-burreo-line-label]"),
    burreoAmount: document.querySelector("[data-inland-burreo-amount]"),
    result: document.querySelector("[data-inland-result]"),
    empty: document.querySelector("[data-inland-empty]"),
    routeMeta: document.querySelector("[data-inland-route-meta]"),
    totalLabel: document.querySelector("[data-inland-total-label]"),
    total: document.querySelector("[data-inland-total]"),
    formula: document.querySelector("[data-inland-formula]"),
    maxProviderLabel: document.querySelector("[data-inland-maxprovider-label]"),
    maxProvider: document.querySelector("[data-inland-maxprovider]"),
    allQuotesCard: document.querySelector("[data-inland-allquotes-card]"),
    allQuotesLabel: document.querySelector("[data-inland-allquotes-label]"),
    allQuotes: document.querySelector("[data-inland-allquotes]"),
    precise: document.querySelector("[data-inland-precise]"),
    preciseLabel: document.querySelector("[data-inland-precise-label]"),
    preciseChips: document.querySelector("[data-inland-precise-chips]"),
    photos: document.querySelector("[data-inland-photos]"),
    photosLabel: document.querySelector("[data-inland-photos-label]"),
    photoRow: document.querySelector("[data-inland-photo-row]"),
  };

  function currentService() {
    return (panel.serviceInput && panel.serviceInput.value) || "sencillo";
  }
  function currentTaxRatio() {
    const v = panel.ivaInput.value;
    return v === "0" ? 0 : 0.16;
  }
  function currentQty() {
    return Math.max(0, parseInt(panel.qtyInput.value, 10) || 0);
  }

  function renderQuote() {
    const dest = destById.get(selectedId);
    if (!dest) {
      panel.result.hidden = true;
      panel.empty.hidden = false;
      return;
    }
    panel.empty.hidden = true;
    panel.result.hidden = false;

    const service = currentService();
    // S1 (batch3): a selected precise point with a flatPrice overrides the
    // per-vehicle city rate with a single all-in price (覆盖车型档).
    const preciseId = panel.preciseInput ? panel.preciseInput.value : "";
    const precisePoint = preciseId
      ? (dest.precisePoints || []).find((p) => p.id === preciseId)
      : null;
    const flat =
      precisePoint && precisePoint.flatPrice != null && precisePoint.flatPrice !== ""
        ? Number(precisePoint.flatPrice)
        : null;
    // S2: price per selected vehicle tier (maxByVehicle covers all tiers).
    const vinfo = (dest.maxByVehicle && dest.maxByVehicle[service]) || null;
    const maxRate = flat != null ? flat : vinfo ? vinfo.rate : null;
    const provider = flat != null ? i18n.flatPriceProvider || "Flat" : vinfo ? vinfo.provider : null;
    const qty = currentQty();
    const tax = currentTaxRatio();

    // R2 burreo (short-haul) add-on: only sencillo/full carry a drayage rate.
    // A flat one-price point is all-in, so no burreo add-on applies.
    const burreoRate =
      service === "sencillo"
        ? dest.maxBurreoSencillo
        : service === "full"
          ? dest.maxBurreoFull
          : null;
    const hasBurreo = flat == null && burreoRate != null && Number(burreoRate) > 0;
    if (panel.burreoWrap) {
      panel.burreoWrap.hidden = !hasBurreo;
    }
    if (panel.burreoHint) {
      panel.burreoHint.textContent = hasBurreo ? `(+${fmtMoney(burreoRate)} ${i18n.mxn})` : "";
    }
    const includeBurreo = hasBurreo && panel.burreoCheck && panel.burreoCheck.checked;

    // route meta
    const route = routeForDestination(selectedId);
    let metaHtml = "";
    if (route) {
      const via = (route.viaCities || []).join(" → ");
      const hours = route.durationMin ? `≈${Math.round(route.durationMin / 60)} ${i18n.hours}` : "";
      metaHtml = `${via ? `<span>${i18n.via}: ${via}</span>` : ""}` +
        `<span>${route.distanceKm} ${i18n.km}${hours ? ` · ${hours}` : ""}</span>` +
        `${route.hasFerry ? `<span class="inland-flag">${i18n.hasFerry}</span>` : ""}` +
        `${route.stale ? `<span class="inland-flag">${i18n.routeStale}</span>` : ""}`;
    } else {
      metaHtml = `<span class="inland-flag">${i18n.routeNotCached}</span>`;
    }
    if (dest.needsReview) {
      metaHtml += `<span class="inland-flag">${i18n.needsReview}</span>`;
    }
    panel.routeMeta.innerHTML = metaHtml;

    panel.totalLabel.textContent = `${i18n.total} · ${tax === 0 ? i18n.pretax : i18n.aftertax}`;

    if (maxRate == null) {
      // No rate for this vehicle tier yet -> leave BLANK (José: "没有价格就先空着").
      panel.total.textContent = "—";
      panel.formula.textContent = "";
      panel.maxProviderLabel.textContent = "";
      panel.maxProvider.textContent = "";
      if (panel.burreoLine) panel.burreoLine.hidden = true;
    } else {
      const burreoAdd = includeBurreo ? Number(burreoRate) * qty : 0;
      const pretax = maxRate * qty + burreoAdd;
      const total = tax === 0 ? pretax : pretax * (1 + tax);
      panel.total.textContent = `${fmtMoney(total)} ${i18n.mxn}`;
      const baseF = `${fmtMoney(maxRate)} × ${qty}`;
      const burreoF = burreoAdd > 0 ? ` + ${fmtMoney(burreoRate)} × ${qty}` : "";
      panel.formula.textContent =
        tax === 0
          ? `${baseF}${burreoF} = ${fmtMoney(total)} ${i18n.mxn}`
          : `(${baseF}${burreoF}) × 1.16 = ${fmtMoney(total)} ${i18n.mxn}`;
      panel.maxProviderLabel.textContent = `${i18n.maxProvider}:`;
      panel.maxProvider.textContent = provider || "—";
      if (panel.burreoLine) {
        panel.burreoLine.hidden = burreoAdd <= 0;
        if (burreoAdd > 0) {
          panel.burreoLineLabel.textContent = `${i18n.burreo}:`;
          panel.burreoAmount.textContent = `${fmtMoney(burreoAdd)} ${i18n.mxn}`;
        }
      }
    }

    renderAllQuotes(dest);
    renderPrecise(dest);
    renderPhotos(dest);
  }

  // S3 case photos: thumbnails (URL-only; escaped href/src; new tab on click).
  function renderPhotos(dest) {
    if (!panel.photos) {
      return;
    }
    const urls = (dest.imageUrls || []).filter((u) => /^https?:\/\//i.test(u));
    if (!urls.length) {
      panel.photos.hidden = true;
      return;
    }
    panel.photos.hidden = false;
    if (panel.photosLabel) panel.photosLabel.textContent = i18n.casePhotos || "";
    panel.photoRow.innerHTML = urls
      .map((u) => {
        const safe = escapeHtml(u);
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer"><img src="${safe}" alt="" loading="lazy" /></a>`;
      })
      .join("");
  }

  function renderAllQuotes(dest) {
    const entries = (dest.entries || []).slice();
    panel.allQuotesLabel.textContent = `${i18n.allQuotes} (${entries.length})`;
    if (!entries.length) {
      panel.allQuotes.innerHTML = `<p class="muted">${i18n.noQuotesForDestination}</p>`;
      return;
    }
    // Legacy table shows sencillo/full columns; sort by full when full is selected.
    const sortKey = currentService() === "full" ? "full" : "sencillo";
    entries.sort((a, b) => (Number(b[sortKey] || 0) - Number(a[sortKey] || 0)));
    const rows = entries
      .map((e) => {
        const tag = e.cliente ? `<span class="inland-client-tag">${escapeHtml(e.cliente)}</span>` : "";
        return `<tr>
          <td>${escapeHtml(e.proveedor || "—")} ${tag}</td>
          <td>${e.sencillo != null ? fmtMoney(e.sencillo) : "—"}</td>
          <td>${e.full != null ? fmtMoney(e.full) : "—"}</td>
          <td>${escapeHtml(e.commodity || "")}</td>
        </tr>`;
      })
      .join("");
    panel.allQuotes.innerHTML = `<table><thead><tr>
      <th>${i18n.supplier}</th><th>${i18n.serviceSencillo}</th><th>${i18n.serviceFull}</th><th>${i18n.commodity}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderPrecise(dest) {
    const points = dest.precisePoints || [];
    if (!points.length) {
      panel.precise.hidden = true;
      return;
    }
    panel.precise.hidden = false;
    panel.preciseLabel.textContent = i18n.precisePoints;
    const chips = [`<button type="button" class="inland-chip is-active" data-precise-id="">${i18n.precisePointDefault}</button>`]
      .concat(
        points.map(
          (p) => `<button type="button" class="inland-chip" data-precise-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`
        )
      )
      .join("");
    panel.preciseChips.innerHTML = chips;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function selectDestination(id, { fly = true } = {}) {
    selectedId = id || "";
    if (panel.destSelect.value !== selectedId) panel.destSelect.value = selectedId;
    panel.preciseInput.value = "";
    if (selectedId && map.isStyleLoaded()) {
      applySelectionLayer();
    }
    if (map.isStyleLoaded()) updatePreciseLayer(); // O6.4: refresh precise markers
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("dest", selectedId);
    else url.searchParams.delete("dest");
    window.history.replaceState({}, "", url);
    renderQuote();
    void fly;
  }

  // O6.4: select a precise point (shared by the chips and the map markers).
  // Inherits the city/destination rate (renderQuote) + draws the point's own
  // route/ETA (applySelectionLayer via O6.2).
  function selectPrecisePoint(preciseId, { fly = true } = {}) {
    panel.preciseInput.value = preciseId || "";
    if (panel.preciseChips) {
      panel.preciseChips.querySelectorAll(".inland-chip").forEach((c) =>
        c.classList.toggle("is-active", (c.dataset.preciseId || "") === (preciseId || ""))
      );
    }
    if (map.isStyleLoaded()) applySelectionLayer();
    const dest = destById.get(selectedId);
    const point = (dest?.precisePoints || []).find((p) => p.id === preciseId);
    if (fly && point && point.lat != null) {
      map.flyTo({ center: [point.lng, point.lat], zoom: 9 });
    }
    renderQuote();
  }

  // --- wire interactions ---
  panel.destSelect.addEventListener("change", () => selectDestination(panel.destSelect.value));

  // O5: switching origin reloads the page scoped to that origin (?origin=), so the
  // server re-filters rates/routes for it. Preserves the selected destination.
  const originSelectEl = document.querySelector("[data-inland-origin-select]");
  if (originSelectEl) {
    originSelectEl.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("origin", originSelectEl.value);
      if (selectedId) url.searchParams.set("dest", selectedId);
      window.location.href = url.toString();
    });
  }

  if (panel.serviceInput) {
    panel.serviceInput.addEventListener("change", renderQuote);
  }
  document.querySelectorAll("[data-iva-value]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-iva-value]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      panel.ivaInput.value = btn.dataset.ivaValue;
      renderQuote();
    });
  });
  document.querySelectorAll("[data-qty-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = parseInt(btn.dataset.qtyStep, 10) || 0;
      panel.qtyInput.value = Math.max(0, currentQty() + step);
      renderQuote();
    });
  });
  panel.qtyInput.addEventListener("input", renderQuote);
  if (panel.burreoCheck) {
    panel.burreoCheck.addEventListener("change", () => {
      if (panel.burreoInput) {
        panel.burreoInput.value = panel.burreoCheck.checked ? "1" : "0";
      }
      renderQuote();
    });
  }
  panel.preciseChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-precise-id]");
    if (!chip) return;
    selectPrecisePoint(chip.dataset.preciseId || "");
  });

  map.on("load", () => {
    addLayers();
    setOriginMarker();
    requestAnimationFrame(animateDash);
    if (initial.formData && initial.formData.destinationId) {
      selectDestination(initial.formData.destinationId);
    }
  });
  map.on("style.load", () => {
    // re-add custom layers after a base style swap
    if (map.getSource("inland-routes")) return;
    addLayers();
    setOriginMarker();
  });

  // hover + click on dots and routes
  ["inland-dest-dot", "inland-route-line"].forEach((layer) => {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  });
  const hoverPopup = new maplibregl.Popup({ offset: 12, closeButton: false, closeOnClick: false });
  map.on("mousemove", "inland-dest-dot", (e) => {
    const f = e.features[0];
    const dest = destById.get(f.properties.id);
    if (!dest) return;
    const sLine = dest.maxSencillo != null ? `S $${fmtMoney(dest.maxSencillo)}` : "S —";
    const fLine = dest.maxFull != null ? `F $${fmtMoney(dest.maxFull)}` : "F —";
    hoverPopup
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${escapeHtml(dest.name)}</strong><br>${sLine} · ${fLine}<br>${dest.entryCount} ${i18n.allQuotes}`)
      .addTo(map);
  });
  map.on("mouseleave", "inland-dest-dot", () => hoverPopup.remove());
  map.on("click", "inland-dest-dot", (e) => selectDestination(e.features[0].properties.id));
  map.on("click", "inland-route-line", (e) => selectDestination(e.features[0].properties.destinationId));
  // O6.4: clicking a precise-point marker selects it (price + ETA for that point).
  map.on("mouseenter", "inland-precise-dot", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "inland-precise-dot", () => (map.getCanvas().style.cursor = ""));
  map.on("click", "inland-precise-dot", (e) => selectPrecisePoint(e.features[0].properties.id));

  // follow app theme
  const themeObserver = new MutationObserver(() => {
    const next = STYLES[currentTheme()];
    map.setStyle(next);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
