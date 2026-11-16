/* Fiskekort – farver kysten efter vind, kystens retning og fredningsbælter. */
"use strict";

// ------------------------------------------------------------------ arter
// Vind i m/s. ideal = bedste interval, ok = hvor scoren falder til "middel".
// dir = vægt for pålands-, side- og fralandsvind. Startværdier – kalibreres mod fangster.
const SPECIES = {
  havorred: { name: "Havørred", ideal: [3, 8], ok: [1.5, 11], gust: 16, dir: { on: 1, side: 0.85, off: 0.35 } },
  hornfisk: { name: "Hornfisk", ideal: [1, 6], ok: [0, 9], gust: 13, dir: { on: 0.85, side: 1, off: 0.7 }, months: [4, 5, 6] },
  fladfisk: { name: "Fladfisk/torsk", ideal: [0, 8], ok: [0, 12], gust: 17, dir: { on: 1, side: 1, off: 0.85 } },
  custom: { name: "Generelt" },
};
const DIR_PRESETS = {
  on: { on: 1, side: 0.8, off: 0.3 },
  side: { on: 0.75, side: 1, off: 0.5 },
  any: { on: 1, side: 1, off: 1 },
  off: { on: 0.4, side: 0.8, off: 1 },
};
const COLORS = { 3: "#16a34a", 2: "#eab308", 1: "#dc2626", 9: "#6d28d9", 0: "#94a3b8" };
const LABELS = { 3: "God", 2: "Middel", 1: "Dårlig", 9: "Fiskeri forbudt", 0: "Ingen vind-data" };
const DK_BOUNDS = [[8.0, 54.5], [15.2, 57.8]];
const FORECAST_DAYS = 16;
const BATCH = 100;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("fk-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fk-" + k, JSON.stringify(v)); } catch { /* privat tilstand */ } },
};

const state = {
  species: store.get("species", "havorred"),
  custom: Object.assign({ min: 3, max: 8, lim: 12, dir: "on" }, store.get("custom", {})),
  layers: Object.assign({ sat: false, fred: true, vand: false }, store.get("layers", {})),
  coast: null, fred: null, vand: null, points: null, meta: null,
  times: [], N: 0, T: 0, sp: null, dr: null, gu: null,
  windAt: null, windError: null,
  day: null, hour: new Date().getHours(),
};
if (!SPECIES[state.species]) state.species = "havorred";

// ------------------------------------------------------------------ hjælpere
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
const COMPASS = ["N", "NNØ", "NØ", "ØNØ", "Ø", "ØSØ", "SØ", "SSØ", "S", "SSV", "SV", "VSV", "V", "VNV", "NV", "NNV"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const fmt = (v, d = 1) => v.toLocaleString("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, "0");
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function profile() {
  if (state.species !== "custom") return SPECIES[state.species];
  const c = state.custom;
  const min = Math.min(c.min, c.max), max = Math.max(c.min, c.max);
  return { name: "Generelt", ideal: [min, max], ok: [Math.max(0, min - 2), Math.max(max + 0.5, c.lim)], gust: c.lim + 5, dir: DIR_PRESETS[c.dir] || DIR_PRESETS.any };
}

function speedScore(p, v) {
  const [i0, i1] = p.ideal, [o0, o1] = p.ok;
  if (v >= i0 && v <= i1) return 1;
  if (v < i0) return v <= o0 ? 0.3 : lerp(0.45, 1, (v - o0) / (i0 - o0 || 1));
  return v >= o1 ? 0.15 : lerp(1, 0.45, (v - i1) / (o1 - i1 || 1));
}
function dirWeight(p, delta) {
  const d = p.dir;
  if (delta <= 35) return d.on;
  if (delta < 55) return lerp(d.on, d.side, (delta - 35) / 20);
  if (delta <= 105) return d.side;
  if (delta < 125) return lerp(d.side, d.off, (delta - 105) / 20);
  return d.off;
}
function windKind(delta) { return delta <= 45 ? "Pålandsvind" : delta <= 115 ? "Sidevind" : "Fralandsvind"; }

function dateOfT(t) { return state.times[t] ? state.times[t].slice(0, 10) : todayStr(); }
function inHalfYear(dateStr) { // 16/9 – 15/3
  const m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  return m > 9 || m < 3 || (m === 9 && d >= 16) || (m === 3 && d <= 15);
}
function inPeriod(dateStr, [m1, d1, m2, d2]) {
  const v = +dateStr.slice(5, 7) * 100 + +dateStr.slice(8, 10), a = m1 * 100 + d1, b = m2 * 100 + d2;
  return a <= b ? v >= a && v <= b : v >= a || v <= b;
}
function zoneActive(z, dateStr) {
  if (z.stang || z.t === "omr") return false; // stangfiskeri tilladt / kun redskabs- og fangstbegrænsninger
  if (z.t === "hel" || z.t === "ukendt") return true; // ukendt periode: forsigtighedsprincip
  if (z.t === "per") return (z.p || []).some((p) => inPeriod(dateStr, p));
  if (z.t === "halv") return inHalfYear(dateStr);
  return false;
}
const MONTH_NAMES = ["", "jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function zoneText(z) {
  if (z.t === "hel") return "Fredningsbælte hele året";
  if (z.t === "per") return "Fredningsbælte " + (z.p || []).map(([a, b, c, d]) => `${b}. ${MONTH_NAMES[a]}–${d}. ${MONTH_NAMES[c]}`).join(", ");
  if (z.t === "omr") return "Særligt reguleret område";
  return `Fredningszone (${z.txt || "periode ukendt"})`;
}
const VQ = { 5: "Høj", 4: "God", 3: "Moderat", 2: "Ringe", 1: "Dårlig", 0: "–" };

// ------------------------------------------------------------------ scoring
function evaluate(f, t) {
  const p = profile();
  const pr = f.properties;
  const dateStr = dateOfT(t);
  const res = { cls: 0, score: null, zones: [], notes: [] };
  if (pr.f && state.fred) {
    for (const id of pr.f) {
      const z = state.fred.byId[id];
      if (!z) continue;
      res.zones.push(z);
      if (zoneActive(z, dateStr)) res.banned = true;
    }
  }
  if (!state.sp || t < 0 || pr.g == null) { if (res.banned) res.cls = 9; return res; }
  const k = pr.g * state.T + t;
  const v = state.sp[k], dir = state.dr[k], gust = state.gu[k];
  if (!Number.isFinite(v)) return res;
  res.v = v; res.dir = dir; res.gust = gust;
  let s = speedScore(p, v);
  if (Number.isFinite(gust) && gust > p.gust) { s = Math.min(s, 0.3); res.notes.push(`Kraftige vindstød (${fmt(gust)} m/s)`); }
  let w = 0.8;
  if (pr.b >= 0 && Number.isFinite(dir)) {
    res.delta = angDiff(dir, pr.b);
    w = v < 1 ? 1 : dirWeight(p, res.delta);
  }
  s *= w;
  let cls = s >= 0.7 ? 3 : s >= 0.45 ? 2 : 1;
  if (p.months && !p.months.includes(+dateStr.slice(5, 7))) {
    cls = Math.min(cls, 2);
    res.notes.push("Hornfisk er primært under kysten april–juni.");
  }
  const vq = state.vand && pr.w != null ? state.vand.byId[pr.w] : null;
  if (vq) {
    res.vand = vq;
    // Kun "dårlig" giver loft: 80 af 109 kystvande er ringe eller dårlige, så et loft ved "ringe" ville gøre næsten hele landet gult.
    if (vq.sm === 1 && cls > 2) { cls = 2; res.notes.push(`Dårlig økologisk tilstand i ${vq.n || "kystvandet"} – derfor højst gul.`); }
    else if (state.species === "fladfisk" && vq.bb === 1 && cls > 2) { cls = 2; res.notes.push("Dårlig bundfauna i området – tegn på iltsvind ved bunden. Derfor højst gul for bundfisk."); }
  }
  res.score = s; res.cls = res.banned ? 9 : cls;
  return res;
}

// ------------------------------------------------------------------ data
async function getJSON(url, optional = false) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) { if (optional) return null; throw new Error(`${url}: ${r.status}`); }
  return r.json();
}

async function loadStatic() {
  const [coast, fred, points, meta, vand] = await Promise.all([
    getJSON("data/coast.geojson"),
    getJSON("data/fredning.geojson", true),
    getJSON("data/windpoints.json"),
    getJSON("data/meta.json", true),
    getJSON("data/vand.geojson", true),
  ]);
  state.coast = coast;
  state.points = points;
  state.meta = meta;
  if (fred) {
    fred.byId = {};
    for (const f of fred.features) fred.byId[f.properties.id] = f.properties;
    state.fred = fred;
  }
  if (vand && vand.features && vand.features.length) {
    vand.byId = {};
    for (const f of vand.features) vand.byId[f.properties.id] = f.properties;
    state.vand = vand;
  } else {
    $("tVand").disabled = true;
    $("tVand").closest(".toggle").style.opacity = 0.45;
  }
}

async function loadWind() {
  const pts = state.points;
  const N = pts.length;
  const batches = [];
  for (let i = 0; i < N; i += BATCH) batches.push(pts.slice(i, i + BATCH));
  const results = await Promise.all(batches.map(async (b) => {
    const qs = new URLSearchParams({
      latitude: b.map((p) => p[1]).join(","),
      longitude: b.map((p) => p[0]).join(","),
      hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      wind_speed_unit: "ms",
      timezone: "Europe/Copenhagen",
      forecast_days: String(FORECAST_DAYS),
    });
    const r = await fetch("https://api.open-meteo.com/v1/forecast?" + qs);
    if (!r.ok) throw new Error("Open-Meteo svarede " + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : [j];
  }));
  const all = results.flat();
  const times = all[0].hourly.time;
  const T = times.length;
  const sp = new Float32Array(N * T).fill(NaN), dr = new Float32Array(N * T).fill(NaN), gu = new Float32Array(N * T).fill(NaN);
  all.forEach((loc, g) => {
    const h = loc.hourly;
    for (let t = 0; t < T; t++) {
      const k = g * T + t;
      if (h.wind_speed_10m[t] != null) sp[k] = h.wind_speed_10m[t];
      if (h.wind_direction_10m[t] != null) dr[k] = h.wind_direction_10m[t];
      if (h.wind_gusts_10m && h.wind_gusts_10m[t] != null) gu[k] = h.wind_gusts_10m[t];
    }
  });
  Object.assign(state, { times, T, N, sp, dr, gu, windAt: new Date(), windError: null });
}

// ------------------------------------------------------------------ tid
function currentT() {
  if (!state.times.length) return -1;
  const key = `${state.day}T${pad(state.hour)}:00`;
  return state.times.indexOf(key);
}
function days() {
  const out = [];
  for (const t of state.times) { const d = t.slice(0, 10); if (out[out.length - 1] !== d) out.push(d); }
  return out.length ? out : [todayStr()];
}
function dayLabel(d, i) {
  if (d === todayStr()) return "I dag";
  const dt = new Date(d + "T12:00:00");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (dt.toDateString() === tomorrow.toDateString()) return "I morgen";
  return dt.toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: i > 6 ? "short" : undefined }).replace(".", "");
}
function renderDays() {
  const el = $("days");
  const ds = days();
  if (!ds.includes(state.day)) state.day = ds.includes(todayStr()) ? todayStr() : ds[0];
  el.innerHTML = "";
  ds.forEach((d, i) => {
    const b = document.createElement("button");
    b.textContent = dayLabel(d, i);
    b.setAttribute("aria-pressed", d === state.day);
    b.onclick = () => { state.day = d; renderDays(); update(); };
    el.appendChild(b);
  });
  const sel = el.querySelector("[aria-pressed=true]");
  if (sel) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

// ------------------------------------------------------------------ kort
let map, popup, popupFeature = null;

const FALLBACK_STYLE = {
  version: 8,
  sources: { carto: { type: "raster", tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap © CARTO" } },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/positron",
    bounds: DK_BOUNDS,
    fitBoundsOptions: { padding: { top: 70, bottom: 190, left: 20, right: 20 } },
    attributionControl: { compact: true },
    maxZoom: 17,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-right");
  let styled = false;
  const fallback = setTimeout(() => { if (!styled) map.setStyle(FALLBACK_STYLE); }, 8000);
  map.on("style.load", () => { styled = true; clearTimeout(fallback); addLayers(); lastSig = ""; update(); });
  map.on("error", (e) => { if (!styled && e && e.error && /style/i.test(String(e.error.message || ""))) { styled = true; map.setStyle(FALLBACK_STYLE); } });

  const hit = (e) => {
    const r = 10;
    const fs = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ["coast"] });
    return fs[0];
  };
  map.on("click", (e) => {
    const f = hit(e);
    if (!f) return;
    const panel = document.querySelector(".bottom").getBoundingClientRect();
    const room = panel.top - 20;
    if (e.point.y > room * 0.6) map.panBy([0, e.point.y - room * 0.55], { duration: 300 });
    openPopup(f, e.lngLat);
  });
  map.on("mousemove", (e) => { map.getCanvas().style.cursor = hit(e) ? "pointer" : ""; });
}

function firstSymbolId() {
  const l = map.getStyle().layers.find((x) => x.type === "symbol");
  return l && l.id;
}

function addLayers() {
  if (map.getSource("coast")) return;
  const below = firstSymbolId();
  map.addSource("sat", { type: "raster", tileSize: 256, maxzoom: 18, attribution: "Luftfoto © Esri, Maxar, Earthstar Geographics",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] });
  map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: state.layers.sat ? "visible" : "none" } }, below);

  if (state.vand) {
    map.addSource("vand", { type: "geojson", data: state.vand, promoteId: "id" });
    map.addLayer({ id: "vand", type: "fill", source: "vand", layout: { visibility: state.layers.vand ? "visible" : "none" },
      paint: { "fill-color": ["coalesce", ["get", "color"], "#94a3b8"], "fill-opacity": 0.28 } }, below);
  }
  if (state.fred) {
    map.addSource("fred", { type: "geojson", data: state.fred, promoteId: "id" });
    map.addLayer({ id: "fred-fill", type: "fill", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: { visibility: state.layers.fred ? "visible" : "none" },
      paint: { "fill-color": ["case", ["boolean", ["feature-state", "active"], false], "#6d28d9", "#a78bfa"],
        "fill-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.28, 0.1] } });
    map.addLayer({ id: "fred-omr", type: "line", source: "fred", filter: ["==", ["get", "t"], "omr"], layout: { visibility: state.layers.fred ? "visible" : "none" },
      paint: { "line-color": "#ea580c", "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "fred-line", type: "line", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: { visibility: state.layers.fred ? "visible" : "none" },
      paint: { "line-color": "#6d28d9", "line-width": 1, "line-opacity": 0.6,
        "line-dasharray": ["case", ["boolean", ["feature-state", "active"], false], ["literal", [1, 0]], ["literal", [2, 2]]] } });
  }
  map.addSource("coast", { type: "geojson", data: state.coast, promoteId: "i", tolerance: 0.2 });
  const width = ["interpolate", ["linear"], ["zoom"], 6, 1.6, 9, 3, 12, 5, 15, 8];
  map.addLayer({ id: "coast-casing", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["+", width, 2], "line-opacity": 0.85 } });
  map.addLayer({ id: "coast", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": width,
      "line-color": ["match", ["coalesce", ["feature-state", "s"], 0], 3, COLORS[3], 2, COLORS[2], 1, COLORS[1], 9, COLORS[9], COLORS[0]] } });
}

function setVis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }

// ------------------------------------------------------------------ opdatering
let lastSig = "";
function update() {
  const t = currentT();
  $("hour").value = state.hour;
  $("clock").textContent = `${pad(state.hour)}:00`;
  renderBanner(t);
  renderStatus(t);
  if (!map || !map.getSource("coast") || !state.coast) return;
  const sig = [t, state.species, JSON.stringify(state.custom), state.day].join("|");
  if (sig === lastSig) return;
  lastSig = sig;
  const dateStr = dateOfT(t) || state.day;
  for (const f of state.coast.features) {
    const r = evaluate(f, t);
    map.setFeatureState({ source: "coast", id: f.properties.i }, { s: r.cls });
  }
  if (state.fred && map.getSource("fred")) {
    for (const f of state.fred.features) map.setFeatureState({ source: "fred", id: f.properties.id }, { active: zoneActive(f.properties, state.day || dateStr) });
  }
  if (popupFeature && popup && popup.isOpen()) popup.setHTML(popupHTML(popupFeature));
}

function renderStatus(t) {
  const el = $("status");
  if (state.windError) { el.innerHTML = `Vind kunne ikke hentes (${state.windError}). <a href="#" id="retry">Prøv igen</a>`; const a = $("retry"); if (a) a.onclick = (e) => { e.preventDefault(); startWind(); }; return; }
  if (!state.sp) { el.textContent = "Henter vindprognose …"; return; }
  if (t < 0) { el.textContent = "Ingen prognose for dette tidspunkt."; return; }
  const n = state.coast ? state.coast.features.length : 0;
  el.textContent = `Vind hentet ${state.windAt.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })} · ${n.toLocaleString("da-DK")} kyststrækninger · ${profile().name}`;
}

function renderBanner(t) {
  const el = $("banner");
  const d = dateOfT(t) || state.day || todayStr();
  const m = +d.slice(5, 7), day = +d.slice(8, 10);
  let msg = "";
  if (state.species === "havorred" && ((m === 11 && day >= 16) || m === 12 || (m === 1 && day <= 15)))
    msg = "Farvede (gydemodne) havørreder er fredede i saltvand 16/11–15/1 og skal genudsættes. Blanke fisk må tages.";
  else if (state.species === "fladfisk")
    msg = "Torsk: hjemtagning er forbudt eller begrænset i flere farvande (bl.a. Bælthavet og Østersøen). Tjek de aktuelle regler.";
  else if (state.species === "hornfisk" && !(m >= 4 && m <= 6))
    msg = "Hornfisk står primært under kysten i april–juni – resten af året er chancen lille.";
  el.textContent = msg;
  el.classList.toggle("show", !!msg);
}

// ------------------------------------------------------------------ popup
function popupHTML(f) {
  const t = currentT();
  const r = evaluate(f, t);
  const pr = f.properties;
  const rows = [];
  if (r.v != null) {
    const rot = Number.isFinite(r.dir) ? r.dir + 180 : 0; // pil viser hvor vinden blæser hen
    rows.push(["Vind", `${fmt(r.v)} m/s fra ${compass(r.dir)} <span class="arrow" style="transform:rotate(${rot}deg)">↑</span>`]);
    if (Number.isFinite(r.gust)) rows.push(["Vindstød", `${fmt(r.gust)} m/s`]);
  }
  if (pr.b >= 0) rows.push(["Kysten vender mod", `${compass(pr.b)} (${pr.b}°)`]);
  else rows.push(["Kysten vender mod", "uklart (lille holm/mole)"]);
  if (r.delta != null && r.v >= 1) rows.push(["Vindretning", windKind(r.delta)]);
  if (r.score != null && !r.banned) rows.push(["Score", `${fmt(r.score * 100, 0)} / 100`]);
  if (r.vand) {
    rows.push(["Vandkvalitet", `${r.vand.label || "Ukendt"}${r.vand.n ? ` <span class="muted">· ${r.vand.n}</span>` : ""}`]);
    rows.push(["Delelementer", `<span class="muted">Klorofyl ${VQ[r.vand.fy]} · Ålegræs ${VQ[r.vand.an]} · Bunddyr ${VQ[r.vand.bb]}</span>`]);
  }
  let extra = "";
  for (const z of r.zones) {
    const active = zoneActive(z, dateOfT(t) || state.day);
    const name = z.n ? ` – ${z.n}` : "";
    let txt = `${zoneText(z)}${name}`;
    if (z.stang) txt += `. ${z.r}.`;
    else if (z.t === "omr") txt += ": typisk begrænsninger på redskaber og fangst (fx max 1–3 havørreder pr. dag), ikke et fiskeforbud. Tjek reglerne.";
    else if (active) txt += z.t === "ukendt" ? ": perioden kunne ikke tolkes – regnet som forbudt." : ": alt fiskeri forbudt på denne dato.";
    else txt += " (ikke aktivt på denne dato).";
    if (z.url) txt += ` <a href="${z.url}" target="_blank" rel="noopener" style="color:inherit">Bekendtgørelse</a>`;
    if (active && z.km2 > 5) txt += " Stort område – tjek om forbuddet kun gælder visse redskaber.";
    if (z.lov) txt += `<br><span style="opacity:.8">${z.lov}</span>`;
    extra += `<div class="${active ? "ban" : "note"}">${txt}</div>`;
  }
  for (const n of r.notes) extra += `<div class="note">${n}</div>`;
  const when = t >= 0 ? new Date(state.times[t]).toLocaleString("da-DK", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return `<div class="pop"><h3><span class="dot" style="background:${COLORS[r.cls]}"></span>${LABELS[r.cls]} for ${profile().name.toLowerCase()}</h3>
    <div class="muted">${when}</div>
    <dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>${extra}</div>`;
}
function openPopup(f, lngLat) {
  popupFeature = state.coast.features[f.properties.i] || f;
  if (!popup) popup = new maplibregl.Popup({ maxWidth: "320px", focusAfterOpen: false });
  popup.setLngLat(lngLat).setHTML(popupHTML(popupFeature)).addTo(map);
}

// ------------------------------------------------------------------ UI
function renderSpecies() {
  const el = $("species");
  el.innerHTML = "";
  for (const [k, s] of Object.entries(SPECIES)) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.setAttribute("aria-pressed", k === state.species);
    b.onclick = () => { state.species = k; store.set("species", k); renderSpecies(); update(); if (k === "custom") openSheet(); };
    el.appendChild(b);
  }
  $("customBox").style.display = state.species === "custom" ? "" : "none";
}

function openSheet() { $("sheet").classList.add("open"); $("sheet").setAttribute("aria-hidden", "false"); $("customBox").style.display = state.species === "custom" ? "" : "none"; }
function closeSheet() { $("sheet").classList.remove("open"); $("sheet").setAttribute("aria-hidden", "true"); }

function bindUI() {
  $("hour").addEventListener("input", (e) => { state.hour = +e.target.value; update(); });
  $("now").onclick = () => { state.day = todayStr(); state.hour = new Date().getHours(); renderDays(); update(); };
  $("openSettings").onclick = openSheet;
  $("closeSettings").onclick = closeSheet;
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });

  const toggles = { tSat: ["sat", ["sat"]], tFred: ["fred", ["fred-fill", "fred-line", "fred-omr"]], tVand: ["vand", ["vand"]] };
  for (const [id, [key, layers]] of Object.entries(toggles)) {
    $(id).checked = !!state.layers[key];
    $(id).addEventListener("change", (e) => { state.layers[key] = e.target.checked; store.set("layers", state.layers); layers.forEach((l) => setVis(l, e.target.checked)); });
  }
  const c = state.custom;
  const bind = (id, out, key) => {
    $(id).value = c[key];
    $(out).textContent = `${fmt(+c[key])} m/s`;
    $(id).addEventListener("input", (e) => { c[key] = +e.target.value; $(out).textContent = `${fmt(c[key])} m/s`; store.set("custom", c); update(); });
  };
  bind("cMin", "oMin", "min"); bind("cMax", "oMax", "max"); bind("cLim", "oLim", "lim");
  $("cDir").value = c.dir;
  $("cDir").addEventListener("change", (e) => { c.dir = e.target.value; store.set("custom", c); update(); });
}

async function startWind() {
  state.windError = null; update();
  try { await loadWind(); }
  catch (e) { state.windError = e.message || String(e); }
  renderDays(); lastSig = ""; update();
}

async function main() {
  state.day = todayStr();
  renderSpecies(); bindUI(); renderDays(); update();
  try {
    await loadStatic();
  } catch (e) {
    $("loading").innerHTML = `<div>Kunne ikke hente kortdata: ${e.message}</div>`;
    return;
  }
  const m = state.meta;
  if (m) $("metaInfo").textContent = `Kortdata bygget ${new Date(m.built).toLocaleDateString("da-DK")} · ${(m.counts.segments || 0).toLocaleString("da-DK")} kyststrækninger · ${m.counts.fredning || 0} fredningszoner`;
  initMap();
  map.once("load", () => $("loading").classList.add("hide"));
  setTimeout(() => $("loading").classList.add("hide"), 6000);
  startWind();
}
main();
