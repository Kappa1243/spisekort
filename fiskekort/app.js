/* Fiskekort – farver kysten efter vind, kystens retning, vandtemperatur, lys, uklart vand,
   dybde/bund, vandkvalitet og fredningsbælter. */
"use strict";

// ------------------------------------------------------------------ arter
// Startværdier – hypoteser, der ikke er kalibreret mod fangster.
// ideal/ok: vindstyrke i m/s. dir: vægt for pålands-, side- og fralandsvind.
// temp: havtemperatur i °C. light: faktor for skumring, nat og dag. murky: om uklart vand trækker ned.
const SPECIES = {
  havorred: { name: "Havørred", short: "Havørred", ideal: [3, 8], ok: [1.5, 11], gust: 16, dir: { on: 1, side: 0.85, off: 0.35 },
    temp: { ideal: [6, 12], ok: [2, 17] }, light: { dusk: 1.12, night: 0.85, nightWarm: 1.05, day: 1, dayWarm: 0.8 }, murky: true },
  hornfisk: { name: "Hornfisk", short: "Hornfisk", ideal: [1, 6], ok: [0, 9], gust: 13, dir: { on: 0.85, side: 1, off: 0.7 }, months: [4, 5, 6],
    temp: { ideal: [12, 18], ok: [9, 21] }, light: { dusk: 0.9, night: 0.4, nightWarm: 0.4, day: 1, dayWarm: 1 }, murky: true },
  fladfisk: { name: "Fladfisk/torsk", short: "Fladfisk", ideal: [0, 8], ok: [0, 12], gust: 17, dir: { on: 1, side: 1, off: 0.85 },
    temp: { ideal: [4, 14], ok: [1, 18] }, light: { dusk: 1.1, night: 1.1, nightWarm: 1.1, day: 0.95, dayWarm: 0.95 }, murky: false },
  custom: { name: "Generelt", short: "Egen" },
};
const DIR_PRESETS = {
  on: { on: 1, side: 0.8, off: 0.3 },
  side: { on: 0.75, side: 1, off: 0.5 },
  any: { on: 1, side: 1, off: 1 },
  off: { on: 0.4, side: 0.8, off: 1 },
};
const PALETTES = {
  std: { 3: "#16a34a", 2: "#eab308", 1: "#dc2626", 9: "#6d28d9", 0: "#94a3b8" },
  cb: { 3: "#0072B2", 2: "#E69F00", 1: "#D55E00", 9: "#000000", 0: "#999999" }, // Okabe-Ito
};
const LABELS = { 3: "God", 2: "Middel", 1: "Dårlig", 9: "Fiskeri forbudt", 0: "Ingen vind-data" };
const DK_BOUNDS = [[8.0, 54.5], [15.2, 57.8]];
const PAST_DAYS = 2, FORECAST_DAYS = 12; // i alt 14 døgn = ét Open-Meteo-kald pr. sted
const BATCH = 80;
const CACHE_KEY = "wx-v3", CACHE_MIN = 45;
const SUBSTRATE = { 5: "Sten/klippe", 3: "Grus/groft", 4: "Blandet", 2: "Sand", 1: "Mudder" };
const VQ = { 5: "Høj", 4: "God", 3: "Moderat", 2: "Ringe", 1: "Dårlig", 0: "–" };
const MONTH_NAMES = ["", "jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("fk-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fk-" + k, JSON.stringify(v)); return true; } catch { return false; } },
};

const state = {
  species: store.get("species", "havorred"),
  custom: Object.assign({ min: 3, max: 8, lim: 12, dir: "on" }, store.get("custom", {})),
  layers: Object.assign({ sat: false, fred: true, vand: false, cb: false }, store.get("layers", {})),
  coast: null, fred: null, vand: null, points: null, meta: null, fredError: null,
  ts: [], keys: [], N: 0, T: 0, sp: null, dr: null, gu: null, missing: 0,
  sst: null, sstGroup: null, sstError: null,
  windAt: null, windError: null,
  day: null, hour: new Date().getHours(),
};
if (!SPECIES[state.species]) state.species = "havorred";

// ------------------------------------------------------------------ hjælpere
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
const COMPASS = ["N", "NNØ", "NØ", "ØNØ", "Ø", "ØSØ", "SØ", "SSØ", "S", "SSV", "SV", "VSV", "V", "VNV", "NV", "NNV"];
const compass = (deg) => (Number.isFinite(deg) ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : "–");
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
const pad = (n) => String(n).padStart(2, "0");
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const SAFE_HOSTS = /(^|\.)(retsinformation\.dk|lovtidende\.dk|lfst\.dk|fiskeristyrelsen\.dk|fiskepleje\.dk)$/i;
function safeUrl(u) {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) && SAFE_HOSTS.test(x.hostname) ? x.href : null; } catch { return null; }
}
const colors = () => (state.layers.cb ? PALETTES.cb : PALETTES.std);

// Lokal dato/time i dansk tid (uafhængigt af browserens tidszone)
const DK_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function dkKey(ms) {
  const p = Object.fromEntries(DK_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}
function todayStr() { return dkKey(Date.now()).slice(0, 10); }
function nowHour() { return +dkKey(Date.now()).slice(11, 13); }

function profile() {
  if (state.species !== "custom") return SPECIES[state.species];
  const c = state.custom;
  const lim = Math.max(1, c.lim);
  const min = Math.min(c.min, c.max), max = Math.min(Math.max(c.min, c.max), lim - 0.5);
  return { name: "Generelt", short: "Egen", ideal: [Math.min(min, max), max], ok: [Math.max(0, min - 2), lim], gust: lim + 5, dir: DIR_PRESETS[c.dir] || DIR_PRESETS.any };
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

// ------------------------------------------------------------------ sol
function sunElevation(ms, lat, lon) {
  const rad = Math.PI / 180;
  const d = ms / 86400000 - 10957.5; // dage siden J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
function lightPhase(elev) { return elev < -6 ? "night" : elev <= 6 ? "dusk" : "day"; }
const LIGHT_LABEL = { night: "Mørkt", dusk: "Skumring/daggry", day: "Dagslys" };
function sunTimes(dayStr, lat, lon) {
  // Find solop- og nedgang (højde -0,833°) ved at gå dagen igennem i 5-minutters skridt.
  const start = Date.parse(`${dayStr}T00:00:00Z`) - 3 * 3600e3;
  let rise = null, set = null, prev = sunElevation(start, lat, lon);
  for (let m = 5; m <= 30 * 60; m += 5) {
    const ms = start + m * 60e3;
    const el = sunElevation(ms, lat, lon);
    if (dkKey(ms).slice(0, 10) === dayStr) {
      if (prev < -0.833 && el >= -0.833 && !rise) rise = ms;
      if (prev >= -0.833 && el < -0.833 && rise && !set) set = ms;
    }
    prev = el;
  }
  return { rise, set };
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------------ fredning
function inPeriod(dateStr, [m1, d1, m2, d2]) {
  const v = +dateStr.slice(5, 7) * 100 + +dateStr.slice(8, 10), a = m1 * 100 + d1, b = m2 * 100 + d2;
  return a <= b ? v >= a && v <= b : v >= a || v <= b;
}
function zoneActive(z, dateStr) {
  if (z.stang || z.t === "omr") return false; // stangfiskeri tilladt / kun redskabs- og fangstbegrænsninger
  if (z.t === "hel" || z.t === "ukendt") return true; // ukendt periode: forsigtighedsprincip
  if (z.t === "per") return (z.p || []).some((p) => inPeriod(dateStr, p));
  return false;
}
function zoneText(z) {
  if (z.t === "hel") return "Fredningsbælte hele året";
  if (z.t === "per") return "Fredningsbælte " + (z.p || []).map(([a, b, c, d]) => `${b}. ${MONTH_NAMES[a]}–${d}. ${MONTH_NAMES[c]}`).join(", ");
  if (z.t === "omr") return "Særlige regler";
  return `Fredningszone (${z.txt || "periode ukendt"})`;
}

// ------------------------------------------------------------------ tid
function dateOfT(t) { return t >= 0 && state.keys[t] ? state.keys[t].slice(0, 10) : state.day || todayStr(); }
function currentT() {
  if (!state.keys.length) return -1;
  const key = `${state.day}T${pad(state.hour)}`;
  const i = state.keys.indexOf(key);
  if (i >= 0) return i;
  // fx sommertidsskifte: tag nærmeste time samme dag
  let best = -1, bd = 99;
  state.keys.forEach((k, j) => { if (k.slice(0, 10) === state.day) { const d = Math.abs(+k.slice(11, 13) - state.hour); if (d < bd) { bd = d; best = j; } } });
  return best;
}

// ------------------------------------------------------------------ scoring
function tempFactor(p, sst) {
  if (!p.temp || !Number.isFinite(sst)) return null;
  const [i0, i1] = p.temp.ideal, [o0, o1] = p.temp.ok;
  if (sst >= i0 && sst <= i1) return 1;
  if (sst < o0 || sst > o1) return 0.6;
  return sst < i0 ? lerp(0.75, 1, (sst - o0) / (i0 - o0)) : lerp(1, 0.75, (sst - i1) / (o1 - i1));
}
function placeFactor(species, pr) {
  const out = [];
  const d2 = pr.d2, s = pr.s;
  if (species === "havorred") {
    if (s === 3 || s === 4 || s === 5) out.push([1.08, "sten/grus i bunden"]);
    else if (s === 1) out.push([0.92, "mudderbund"]);
    if (d2 != null && d2 < 0.8) out.push([0.9, "meget lavt vand"]);
    else if (d2 != null && d2 >= 2) out.push([1.05, "dybt vand tæt på land"]);
  } else if (species === "hornfisk") {
    if (d2 != null && d2 >= 1.5) out.push([1.04, "dybt vand tæt på land"]);
    if (s === 1) out.push([0.95, "mudderbund"]);
  } else if (species === "fladfisk") {
    if (s === 2) out.push([1.08, "sandbund"]);
    else if (s === 5) out.push([0.95, "stenbund"]);
    if (d2 != null && d2 < 1.5) out.push([0.85, "lavt vand"]);
    else if (d2 != null && d2 >= 4) out.push([1.08, "dybt vand tæt på land"]);
  }
  return out;
}
function murkyHours(g, b, t) {
  // Timer med kraftig pålandsvind (≥9 m/s) eller hård vind (≥13 m/s) de seneste 36 timer.
  let n = 0, seen = 0;
  for (let k = Math.max(0, t - 36); k < t; k++) {
    const v = state.sp[g * state.T + k], dir = state.dr[g * state.T + k];
    if (!Number.isFinite(v)) continue;
    seen++;
    if (v >= 13 || (v >= 9 && (b < 0 || angDiff(dir, b) <= 70))) n++;
  }
  return seen >= 12 ? n : null;
}

function evaluate(f, t, opts = {}) {
  const p = profile();
  const pr = f.properties;
  const dateStr = dateOfT(t);
  const res = { cls: 0, score: null, zones: [], notes: [], factors: [] };
  if (pr.f && state.fred) {
    const seen = new Set();
    for (const id of pr.f) {
      const z = state.fred.byId[id];
      if (!z) continue;
      const key = [z.n, z.t, z.txt, z.note].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      res.zones.push(z);
      if (zoneActive(z, dateStr)) res.banned = true;
      if (z.t === "omr" || z.stang) res.reg = true;
    }
  }
  const finish = () => { if (res.banned) res.cls = 9; return res; };
  if (!state.sp || t < 0 || pr.g == null) return finish();
  const k = pr.g * state.T + t;
  const v = state.sp[k], dir = state.dr[k], gust = state.gu[k];
  if (!Number.isFinite(v)) return finish();
  res.v = v; res.dir = dir; res.gust = gust;

  let s = speedScore(p, v);
  if (Number.isFinite(gust) && gust > p.gust) { s = Math.min(s, 0.3); res.notes.push(`Kraftige vindstød (${fmt(gust)} m/s).`); }
  let w = 0.8;
  if (pr.b >= 0 && Number.isFinite(dir)) {
    res.delta = angDiff(dir, pr.b);
    w = v < 1 ? 1 : dirWeight(p, res.delta);
  }
  s *= w;
  res.base = s;

  // Tillægsfaktorer (kun for de faste arter)
  let mod = 1;
  if (state.species !== "custom") {
    const pt = state.points[pr.g];
    const gi = state.sstGroup ? state.sstGroup[pr.g] : -1;
    const sst = state.sst && gi >= 0 ? state.sst[gi * state.T + t] : NaN;
    res.sst = sst;
    const tf = tempFactor(p, sst);
    if (tf != null && tf !== 1) { mod *= tf; res.factors.push([tf, `havtemperatur ${fmt(sst)} °C`]); }
    const warm = Number.isFinite(sst) ? sst > 15 : [6, 7, 8].includes(+dateStr.slice(5, 7));
    const elev = sunElevation(state.ts[t] * 1000, pt[1], pt[0]);
    res.light = lightPhase(elev);
    const lf = res.light === "dusk" ? p.light.dusk : res.light === "night" ? (warm ? p.light.nightWarm : p.light.night) : (warm ? p.light.dayWarm : p.light.day);
    if (lf !== 1) { mod *= lf; res.factors.push([lf, LIGHT_LABEL[res.light].toLowerCase() + (warm && res.light !== "dusk" ? " (varmt vand)" : "")]); }
    for (const [ff, label] of placeFactor(state.species, pr)) { mod *= ff; res.factors.push([ff, label]); }
  }
  mod = Math.max(0.5, Math.min(1.25, mod));
  s = Math.min(1, s * mod);
  let cls = s >= 0.7 ? 3 : s >= 0.45 ? 2 : 1;

  // Lofter
  const month = +dateStr.slice(5, 7);
  if (p.months && !p.months.includes(month)) { cls = Math.min(cls, 2); res.notes.push("Hornfisk er primært under kysten april–juni."); }
  if (!opts.fast || state.species !== "custom") {
    const mh = murkyHours(pr.g, pr.b, t);
    res.murky = mh;
    if (mh != null && mh >= 8) {
      if (p.murky || state.species === "custom") {
        if (cls > 2) cls = 2;
        res.notes.push(`${mh} timer med kraftig pålandsvind eller hård vind det seneste døgn og en halv – vandet er sandsynligvis uklart. Derfor højst gul.`);
      } else {
        res.notes.push(`${mh} timer med kraftig vind det seneste døgn og en halv – vandet er sandsynligvis uklart, hvilket ofte er fint for fladfisk og torsk.`);
      }
    }
  }
  const vq = state.vand && pr.w != null ? state.vand.byId[pr.w] : null;
  if (vq) {
    res.vand = vq;
    // Kun "dårlig" giver loft: 80 af 109 kystvande er ringe eller dårlige.
    if (vq.sm === 1 && cls > 2) { cls = 2; res.notes.push(`Dårlig økologisk tilstand i ${vq.n || "kystvandet"} – derfor højst gul.`); }
    else if (state.species === "fladfisk" && vq.bb === 1 && cls > 2) { cls = 2; res.notes.push("Dårlig bundfauna i området – tegn på iltsvind ved bunden. Derfor højst gul for bundfisk."); }
  }
  res.score = s; res.cls = cls;
  return finish();
}

// ------------------------------------------------------------------ data
async function getJSON(url, optional = false) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) { if (optional) return null; throw new Error(`${url}: ${r.status}`); }
  return r.json();
}

async function loadStatic() {
  const [coast, points, meta, vand] = await Promise.all([
    getJSON("data/coast.geojson"), getJSON("data/windpoints.json"),
    getJSON("data/meta.json", true), getJSON("data/vand.geojson", true),
  ]);
  state.coast = coast; state.points = points; state.meta = meta;
  try {
    const fred = await getJSON("data/fredning.geojson");
    if (!fred.features || !fred.features.length) throw new Error("tom fil");
    fred.byId = {};
    for (const f of fred.features) fred.byId[f.properties.id] = f.properties;
    state.fred = fred;
  } catch (e) {
    state.fredError = e.message || String(e);
  }
  if (vand && vand.features && vand.features.length) {
    vand.byId = {};
    for (const f of vand.features) vand.byId[f.properties.id] = f.properties;
    state.vand = vand;
  } else {
    $("tVand").disabled = true;
    $("tVand").closest(".toggle").style.opacity = 0.45;
  }
  // Havtemperatur hentes for grove grupper af vindpunkter (temperaturen ændrer sig langsomt i rummet).
  const groups = new Map();
  state.sstGroup = points.map(([lon, lat]) => {
    const key = `${Math.round(lat / 0.5)}|${Math.round(lon / 0.75)}`;
    if (!groups.has(key)) groups.set(key, groups.size);
    return groups.get(key);
  });
  state.sstPoints = [];
  points.forEach((pt, g) => { const gi = state.sstGroup[g]; if (!state.sstPoints[gi]) state.sstPoints[gi] = pt; });
}

async function fetchWithRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return r.json();
      last = new Error(`svarede ${r.status}`);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      clearTimeout(timer);
      last = e.name === "AbortError" ? new Error("timeout") : e;
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1) ** 2));
  }
  throw last;
}

async function fetchPoints(base, pts, hourly, extra) {
  const batches = [];
  for (let i = 0; i < pts.length; i += BATCH) batches.push(pts.slice(i, i + BATCH));
  const settled = await Promise.allSettled(batches.map((b) => fetchWithRetry(base + "?" + new URLSearchParams({
    latitude: b.map((p) => p[1]).join(","), longitude: b.map((p) => p[0]).join(","),
    hourly, timeformat: "unixtime", timezone: "GMT", ...extra,
  }))));
  const out = new Array(pts.length).fill(null);
  let err = null;
  settled.forEach((r, bi) => {
    if (r.status !== "fulfilled") { err = r.reason; return; }
    const arr = Array.isArray(r.value) ? r.value : [r.value];
    arr.forEach((loc, j) => { out[bi * BATCH + j] = loc; });
  });
  return { out, err };
}

function fillArrays(locs, vars, ts) {
  const T = ts.length, N = locs.length;
  const idx = new Map(ts.map((x, i) => [x, i]));
  const arrs = vars.map(() => new Float32Array(N * T).fill(NaN));
  locs.forEach((loc, g) => {
    if (!loc || !loc.hourly) return;
    const lt = loc.hourly.time;
    for (let j = 0; j < lt.length; j++) {
      const t = idx.get(lt[j]);
      if (t == null) continue;
      vars.forEach((v, vi) => { const x = loc.hourly[v] && loc.hourly[v][j]; if (x != null) arrs[vi][g * T + t] = x; });
    }
  });
  return arrs;
}

function pack(a, f) { return Array.from(a, (x) => (Number.isFinite(x) ? Math.round(x * f) : null)); }
function unpack(a, f) { const o = new Float32Array(a.length); a.forEach((x, i) => { o[i] = x == null ? NaN : x / f; }); return o; }

async function loadWeather() {
  const pts = state.points;
  const sig = `${pts.length}|${pts[0]}|${pts[pts.length - 1]}`;
  const cached = store.get(CACHE_KEY, null);
  if (cached && cached.sig === sig && Date.now() - cached.at < CACHE_MIN * 60e3) {
    Object.assign(state, { ts: cached.ts, keys: cached.ts.map((x) => dkKey(x * 1000)), T: cached.ts.length, N: pts.length,
      sp: unpack(cached.sp, 10), dr: unpack(cached.dr, 1), gu: unpack(cached.gu, 10),
      sst: cached.sst ? unpack(cached.sst, 10) : null, windAt: new Date(cached.at), missing: cached.missing || 0, sstError: cached.sstError || null });
    return;
  }
  const wind = await fetchPoints("https://api.open-meteo.com/v1/forecast", pts,
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    { wind_speed_unit: "ms", past_days: String(PAST_DAYS), forecast_days: String(FORECAST_DAYS) });
  const ref = wind.out.find((l) => l && l.hourly && l.hourly.time);
  if (!ref) throw wind.err || new Error("ingen data");
  const ts = ref.hourly.time;
  const [sp, dr, gu] = fillArrays(wind.out, ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"], ts);
  const missing = wind.out.filter((l) => !l).length;

  let sst = null, sstError = null;
  try {
    const marine = await fetchPoints("https://marine-api.open-meteo.com/v1/marine", state.sstPoints, "sea_surface_temperature",
      { past_days: String(PAST_DAYS), forecast_days: "7" });
    [sst] = fillArrays(marine.out, ["sea_surface_temperature"], ts);
    const G = state.sstPoints.length, T = ts.length;
    // Forlæng sidste kendte værdi frem i tiden og udfyld grupper uden data fra nærmeste gruppe med data.
    const has = [];
    for (let g = 0; g < G; g++) {
      let last = NaN, any = false;
      for (let t = 0; t < T; t++) { const x = sst[g * T + t]; if (Number.isFinite(x)) { last = x; any = true; } else if (Number.isFinite(last)) sst[g * T + t] = last; }
      has[g] = any;
    }
    for (let g = 0; g < G; g++) {
      if (has[g]) continue;
      let best = -1, bd = Infinity;
      for (let h = 0; h < G; h++) {
        if (!has[h]) continue;
        const d = (state.sstPoints[g][0] - state.sstPoints[h][0]) ** 2 + (state.sstPoints[g][1] - state.sstPoints[h][1]) ** 2;
        if (d < bd) { bd = d; best = h; }
      }
      if (best >= 0) sst.copyWithin(g * T, best * T, best * T + T);
    }
    if (!has.some(Boolean)) { sst = null; sstError = "ingen data"; }
  } catch (e) { sstError = e.message || String(e); }

  Object.assign(state, { ts, keys: ts.map((x) => dkKey(x * 1000)), T: ts.length, N: pts.length, sp, dr, gu, sst, missing, sstError, windAt: new Date() });
  store.set(CACHE_KEY, { at: Date.now(), sig, ts, sp: pack(sp, 10), dr: pack(dr, 1), gu: pack(gu, 10), sst: sst ? pack(sst, 10) : null, missing, sstError });
}

// ------------------------------------------------------------------ dage
function days() {
  const today = todayStr();
  const out = [];
  for (const k of state.keys) { const d = k.slice(0, 10); if (d >= today && out[out.length - 1] !== d) out.push(d); }
  return out.length ? out : [today];
}
function dayLabel(d, i) {
  if (d === todayStr()) return "I dag";
  const dt = new Date(d + "T12:00:00");
  const tomorrow = new Date(Date.parse(todayStr() + "T12:00:00") + 86400e3);
  if (dt.toDateString() === tomorrow.toDateString()) return "I morgen";
  return dt.toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: i > 6 ? "short" : undefined }).replace(".", "");
}
function renderDays() {
  const el = $("days");
  const ds = days();
  if (!ds.includes(state.day)) state.day = ds[0];
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
    fitBoundsOptions: { padding: { top: 70, bottom: 210, left: 20, right: 20 } },
    attributionControl: { compact: true },
    maxZoom: 17,
  });
  if (window.innerWidth > 560) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-right");
  let styled = false;
  const fallback = setTimeout(() => { if (!styled) map.setStyle(FALLBACK_STYLE); }, 8000);
  map.on("style.load", () => { styled = true; clearTimeout(fallback); addLayers(); lastSig = ""; update(); });
  map.on("error", (e) => { if (!styled && e && e.error && /style/i.test(String(e.error.message || ""))) { styled = true; map.setStyle(FALLBACK_STYLE); } });
  map.on("moveend", renderSun);

  const hit = (e) => {
    const r = 10;
    const fs = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ["coast"] });
    return fs[0];
  };
  map.on("click", (e) => {
    const f = hit(e);
    if (!f) { if (popup) popup.remove(); return; }
    const panel = document.querySelector(".bottom").getBoundingClientRect();
    const target = panel.top - 30;
    if (Math.abs(e.point.y - target) > 40) map.panBy([0, e.point.y - target], { duration: 300 });
    openPopup(f, e.lngLat);
  });
  map.on("mousemove", (e) => { map.getCanvas().style.cursor = hit(e) ? "pointer" : ""; });
}

function firstSymbolId() {
  const l = map.getStyle().layers.find((x) => x.type === "symbol");
  return l && l.id;
}
function coastColorExpr() {
  const c = colors();
  return ["match", ["coalesce", ["feature-state", "s"], 0], 3, c[3], 2, c[2], 1, c[1], 9, c[9], c[0]];
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
    const vis = { visibility: state.layers.fred ? "visible" : "none" };
    map.addSource("fred", { type: "geojson", data: state.fred, promoteId: "id" });
    map.addLayer({ id: "fred-fill", type: "fill", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: vis,
      paint: { "fill-color": ["case", ["boolean", ["feature-state", "active"], false], "#6d28d9", "#a78bfa"],
        "fill-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.28, 0.1] } });
    map.addLayer({ id: "fred-omr", type: "line", source: "fred", filter: ["==", ["get", "t"], "omr"], layout: vis,
      paint: { "line-color": "#ea580c", "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "fred-line", type: "line", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: vis,
      paint: { "line-color": "#6d28d9", "line-width": 1, "line-opacity": 0.6,
        "line-dasharray": ["case", ["boolean", ["feature-state", "active"], false], ["literal", [1, 0]], ["literal", [2, 2]]] } });
  }
  map.addSource("coast", { type: "geojson", data: state.coast, promoteId: "i", tolerance: 0.2 });
  const width = ["interpolate", ["linear"], ["zoom"], 6, 1.6, 9, 3, 12, 5, 15, 8];
  map.addLayer({ id: "coast-casing", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["boolean", ["feature-state", "reg"], false], "#ea580c", "#ffffff"],
      "line-width": ["+", width, ["case", ["boolean", ["feature-state", "reg"], false], 4, 2]], "line-opacity": 0.9 } });
  map.addLayer({ id: "coast", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": width, "line-color": coastColorExpr() } });
}

function setVis(id, on) { if (map && map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
function applyPalette() {
  const c = colors();
  const root = document.documentElement.style;
  root.setProperty("--good", c[3]); root.setProperty("--ok", c[2]); root.setProperty("--bad", c[1]); root.setProperty("--ban", c[9]); root.setProperty("--none", c[0]);
  if (map && map.getLayer("coast")) map.setPaintProperty("coast", "line-color", coastColorExpr());
  if (popupFeature && popup && popup.isOpen()) popup.setHTML(popupHTML(popupFeature));
}

// ------------------------------------------------------------------ opdatering
let lastSig = "";
function update() {
  const t = currentT();
  $("hour").value = state.hour;
  $("clock").textContent = `${pad(state.hour)}:00`;
  renderBanner(t);
  renderStatus(t);
  renderSun();
  if (!map || !map.getSource("coast") || !state.coast) return;
  const sig = [t, state.species, JSON.stringify(state.custom), state.day, !!state.sp].join("|");
  if (sig === lastSig) return;
  lastSig = sig;
  const dateStr = dateOfT(t);
  for (const f of state.coast.features) {
    const r = evaluate(f, t);
    map.setFeatureState({ source: "coast", id: f.properties.i }, { s: r.cls, reg: !!r.reg && !r.banned });
  }
  if (state.fred && map.getSource("fred")) {
    for (const f of state.fred.features) map.setFeatureState({ source: "fred", id: f.properties.id }, { active: zoneActive(f.properties, dateStr) });
  }
  if (popupFeature && popup && popup.isOpen()) popup.setHTML(popupHTML(popupFeature));
}

let sunSig = "";
function renderSun() {
  const el = $("sun");
  if (!el) return;
  const c = map ? map.getCenter() : { lat: 56, lng: 10.5 };
  const sig = `${state.day}|${c.lat.toFixed(1)}|${c.lng.toFixed(1)}`;
  if (sig === sunSig) return;
  sunSig = sig;
  const { rise, set } = sunTimes(state.day || todayStr(), c.lat, c.lng);
  el.textContent = rise && set ? `Sol op ${hhmm(rise)} · ned ${hhmm(set)}` : "";
}

function renderStatus(t) {
  const el = $("status");
  el.classList.remove("err");
  if (state.fredError) { el.classList.add("err"); el.textContent = `Fredningsbælterne kunne ikke hentes – forbudte områder vises IKKE (${state.fredError}).`; return; }
  if (state.windError) {
    el.classList.add("err");
    el.innerHTML = `Vind kunne ikke hentes (${esc(state.windError)}). <a href="#" id="retry">Prøv igen</a>`;
    const a = $("retry"); if (a) a.onclick = (e) => { e.preventDefault(); startWind(); };
    return;
  }
  if (!state.sp) { el.textContent = "Henter vind og havtemperatur …"; return; }
  if (t < 0) { el.textContent = "Ingen prognose for dette tidspunkt."; return; }
  const parts = [`Vind hentet ${state.windAt.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}`];
  if (state.missing) parts.push(`mangler for ${state.missing} af ${state.N} områder`);
  if (state.sstError) parts.push("havtemperatur mangler");
  parts.push(profile().name);
  el.textContent = parts.join(" · ");
}

function renderBanner(t) {
  const el = $("banner");
  const d = dateOfT(t);
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
function pct(f) { const p = Math.round((f - 1) * 100); return `${p > 0 ? "+" : "−"}${Math.abs(p)} %`; }
function popupHTML(f) {
  const t = currentT();
  const r = evaluate(f, t);
  const pr = f.properties;
  const c = colors();
  const rows = [];
  if (r.v != null) {
    const rot = Number.isFinite(r.dir) ? r.dir + 180 : 0; // pilen viser, hvor vinden blæser hen
    rows.push(["Vind", `${fmt(r.v)} m/s fra ${compass(r.dir)} <span class="arrow" style="transform:rotate(${rot}deg)">↑</span>`]);
    if (Number.isFinite(r.gust)) rows.push(["Vindstød", `${fmt(r.gust)} m/s`]);
  }
  rows.push(["Kysten vender mod", pr.b >= 0 ? `${compass(pr.b)} (${pr.b}°)` : "uklart (lille holm/mole)"]);
  if (r.delta != null && r.v >= 1) rows.push(["Vindretning", windKind(r.delta)]);
  if (Number.isFinite(r.sst)) rows.push(["Havtemperatur", `${fmt(r.sst)} °C`]);
  if (r.light) rows.push(["Lys", LIGHT_LABEL[r.light]]);
  if (pr.d1 != null || pr.d2 != null) rows.push(["Dybde (ca.)", `${pr.d1 != null ? fmt(pr.d1) + " m" : "–"} 150 m ude · ${pr.d2 != null ? fmt(pr.d2) + " m" : "–"} 400 m ude`]);
  if (pr.s) rows.push(["Bund", SUBSTRATE[pr.s] || "–"]);
  if (r.score != null && !r.banned) rows.push(["Score", `${fmt(r.score * 100, 0)} / 100`]);
  if (r.vand) {
    rows.push(["Vandkvalitet", `${esc(r.vand.label || "Ukendt")}${r.vand.n ? ` <span class="muted">· ${esc(r.vand.n)}</span>` : ""}`]);
    rows.push(["Delelementer", `<span class="muted">Klorofyl ${VQ[r.vand.fy] || "–"} · Ålegræs ${VQ[r.vand.an] || "–"} · Bunddyr ${VQ[r.vand.bb] || "–"}</span>`]);
  }
  let extra = "";
  if (r.factors.length && !r.banned) {
    extra += `<div class="factors">${r.factors.map(([ff, label]) => `<span class="${ff >= 1 ? "up" : "down"}">${pct(ff)} ${esc(label)}</span>`).join("")}</div>`;
  }
  const dateStr = dateOfT(t);
  for (const z of r.zones) {
    const active = zoneActive(z, dateStr);
    let txt = `<b>${esc(zoneText(z))}${z.n ? ` – ${esc(z.n)}` : ""}</b>`;
    if (z.note) txt += `. ${esc(z.note)}`;
    else if (z.stang) txt += `. ${esc(z.r || "Stangfiskeri tilladt")}.`;
    else if (z.t === "omr") txt += ": særlige regler for redskaber eller fangst. Tjek reglerne, før du fisker.";
    else if (active) txt += z.t === "ukendt" ? ": perioden kunne ikke tolkes – regnet som forbudt." : ": alt fiskeri forbudt på denne dato.";
    if (!z.note && !active && z.t === "per") txt += " (ikke aktivt på denne dato)";
    if (z.v) txt += ` <span class="tag">Kontrolleret</span>`;
    else if (z.uv) txt += ` <span class="tag">Ikke kontrolleret</span>`;
    const url = safeUrl(z.url);
    const src = z.kilde || z.lov;
    if (src || url) txt += `<br><span style="opacity:.85">${esc(src || "")}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:inherit">Bekendtgørelse</a>` : ""}</span>`;
    extra += `<div class="${active ? "ban" : "note"}">${txt}</div>`;
  }
  for (const n of r.notes) extra += `<div class="note">${esc(n)}</div>`;
  const when = t >= 0 ? new Date(state.ts[t] * 1000).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return `<div class="pop"><h3><span class="dot" style="background:${c[r.cls]}"></span>${LABELS[r.cls]} for ${esc(profile().name.toLowerCase())}</h3>
    <div class="muted">${when}</div>
    <dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>${extra}</div>`;
}
function openPopup(f, lngLat) {
  popupFeature = state.coast.features[f.properties.i] || f;
  if (!popup) popup = new maplibregl.Popup({ maxWidth: "330px", focusAfterOpen: false, anchor: "bottom", closeOnClick: false });
  popup.setLngLat(lngLat).setHTML(popupHTML(popupFeature)).addTo(map);
}

// ------------------------------------------------------------------ UI
function renderSpecies() {
  const el = $("species");
  el.innerHTML = "";
  for (const [k, s] of Object.entries(SPECIES)) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="long">${esc(s.name)}</span><span class="short">${esc(s.short)}</span>`;
    b.title = s.name;
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
  $("now").onclick = () => { state.day = todayStr(); state.hour = nowHour(); renderDays(); update(); };
  $("openSettings").onclick = openSheet;
  $("closeSettings").onclick = closeSheet;
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });

  const toggles = { tSat: ["sat", ["sat"]], tFred: ["fred", ["fred-fill", "fred-line", "fred-omr"]], tVand: ["vand", ["vand"]] };
  for (const [id, [key, layers]] of Object.entries(toggles)) {
    $(id).checked = !!state.layers[key];
    $(id).addEventListener("change", (e) => { state.layers[key] = e.target.checked; store.set("layers", state.layers); layers.forEach((l) => setVis(l, e.target.checked)); });
  }
  $("tCb").checked = !!state.layers.cb;
  $("tCb").addEventListener("change", (e) => { state.layers.cb = e.target.checked; store.set("layers", state.layers); applyPalette(); });

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
  try { await loadWeather(); }
  catch (e) { state.windError = e.message || String(e); }
  renderDays(); lastSig = ""; update();
}

async function main() {
  state.day = todayStr();
  state.hour = nowHour();
  applyPalette();
  renderSpecies(); bindUI(); renderDays(); update();
  try {
    await loadStatic();
  } catch (e) {
    $("loading").innerHTML = `<div>Kunne ikke hente kortdata: ${esc(e.message)}</div>`;
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
