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
  std: { 3: "#4ADE9B", 2: "#FACC4D", 1: "#FF6B6B", 9: "#B18CFF", 0: "#4B5D73" },
  cb: { 3: "#56B4E9", 2: "#E69F00", 1: "#D55E00", 9: "#CC79A7", 0: "#5B6B7E" }, // Okabe-Ito, lyse varianter til mørk baggrund
};
const REG_COLOR = "#F2A65A";
const OERRED_COLORS = { 4: "#9BE7FF", 3: "#4FC3F7", 2: "#2B7FB8", 1: "#3A4F66" };
const LABELS = { 3: "God", 2: "Middel", 1: "Dårlig", 9: "Forbudt", 0: "Ukendt" };
const DK_BOUNDS = [[8.0, 54.5], [15.2, 57.8]];
const PAST_DAYS = 2, FORECAST_DAYS = 12; // i alt 14 døgn = ét Open-Meteo-kald pr. sted
const BATCH = 80;
const CACHE_KEY = "wx-v4", CACHE_MIN = 45;
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
  layers: Object.assign({ sat: false, fred: true, vand: false, cb: false, oerred: false }, store.get("layers", {})),
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

// ------------------------------------------------------------------ blinkfarve (tommelfingerregler)
// Lystfiskertradition, ikke målt viden – påvirker ikke scoren.
const LURE_COLORS = {
  sølv: "#cbd5e1", blå: "#2563eb", sort: "#111827", grøn: "#16a34a", kobber: "#b45309", guld: "#d4a017",
  orange: "#f97316", chartreuse: "#c6f432", rød: "#dc2626", hvid: "#f8fafc", glow: "#bef264",
};
function lureAdvice(species, c) {
  // c: { light, cloud, murky, green, s, sst, d2 }
  const cold = Number.isFinite(c.sst) && c.sst < 5;
  const grey = Number.isFinite(c.cloud) && c.cloud >= 70;
  const sunny = Number.isFinite(c.cloud) && c.cloud < 40;
  let a;
  if (species === "fladfisk") {
    if (c.light !== "day") a = { what: "Pirk i hvid eller selvlysende (glow)", sw: ["hvid", "glow"], why: "I mørke og skumring ses lyse og selvlysende pirke bedst." };
    else if (c.murky) a = { what: "Pirk i rød/orange eller selvlysende", sw: ["rød", "orange", "glow"], why: "Uklart vand: kraftige farver og selvlys giver kontrast." };
    else if (c.d2 >= 4) a = { what: "Pirk i hvid, rød/hvid eller sølv", sw: ["hvid", "rød", "sølv"], why: "Dybere vand mister rødt lys hurtigt – hvid og sølv står bedst." };
    else a = { what: "Pirk i rød/sort eller hvid", sw: ["rød", "sort", "hvid"], why: "Klassisk torskepirk i dagslys." };
    a.title = "Pirk (gæt)";
    return a;
  }
  if (species === "hornfisk") {
    if (c.light === "night") a = { what: "Fisk hellere i dagslys", sw: [], why: "Hornfisk jager efter synet." };
    else if (c.murky) a = { what: "Slankt blink i sølv med orange/rød", sw: ["sølv", "orange", "rød"], why: "Uklart vand: lidt kraftig farve giver kontrast." };
    else if (grey) a = { what: "Slankt blink i sølv/blå med fluo-detalje", sw: ["sølv", "blå", "chartreuse"], why: "Gråvejr: lidt mere farve end i sol." };
    else a = { what: "Slankt blink i sølv/blå eller sølv/grøn", sw: ["sølv", "blå", "grøn"], why: "Hornfisk tager næsten altid de klassiske, slanke sølvblink." };
    a.title = "Blink (gæt)";
    return a;
  }
  // havørred (og "Generelt")
  if (c.light === "night") a = { what: "Sort eller mørk kobber", sw: ["sort", "kobber"], why: "I mørke ses blinket bedst som silhuet mod himlen." };
  else if (c.light === "dusk") a = { what: "Mørk kobber eller sort/sølv", sw: ["kobber", "sort", "sølv"], why: "Svagt lys: en mørk silhuet med lidt glans." };
  else if (c.murky) a = { what: "Orange, chartreuse eller fluo", sw: ["orange", "chartreuse"], why: "Uklart vand efter hård vind: kraftige farver ses på længere afstand." };
  else if (c.green) a = { what: grey ? "Orange eller guld" : "Kobber, guld eller chartreuse", sw: grey ? ["orange", "guld"] : ["kobber", "guld", "chartreuse"], why: "Sommer i et kystvand med meget klorofyl (Miljøstyrelsen: ringe/dårlig) – vandet er ofte grønt, og varme farver og fluo står bedre end blå." };
  else if (grey) a = { what: "Kobber, guld eller sølv med orange", sw: ["kobber", "guld", "orange"], why: "Gråvejr: mere farve og glans end i sol." };
  else if (sunny && c.s === 2) a = { what: "Sølv/grøn (tobis-agtig)", sw: ["sølv", "grøn"], why: "Klart vand, sol og sandbund: diskret og naturligt, som en tobis." };
  else if (sunny) a = { what: "Sølv/blå eller sølv/sort", sw: ["sølv", "blå", "sort"], why: "Klart vand og sol: diskrete, naturlige farver." };
  else a = { what: "Sølv/blå med lidt kobber", sw: ["sølv", "blå", "kobber"], why: "Halvskyet: en mellemting mellem diskret og farverig." };
  if (cold && c.light === "day" && !c.murky) { a.what += " – eller orange/rød"; a.sw = a.sw.concat(["orange"]); a.why += " Koldt vand: mange vælger mere farve og fører blinket langsomt."; }
  a.title = "Blink (gæt)";
  return a;
}

// ------------------------------------------------------------------ data
async function getJSON(url, optional = false) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) { if (optional) return null; throw new Error(`${url}: ${r.status}`); }
  return r.json();
}

async function loadStatic() {
  const [coast, points, meta, vand, oerred] = await Promise.all([
    getJSON("data/coast.geojson"), getJSON("data/windpoints.json"),
    getJSON("data/meta.json", true), getJSON("data/vand.geojson", true), getJSON("data/oerred.geojson", true),
  ]);
  state.coast = coast; state.points = points; state.meta = meta;
  state.oerred = oerred && oerred.features && oerred.features.length ? oerred : null;
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
      sp: unpack(cached.sp, 10), dr: unpack(cached.dr, 1), gu: unpack(cached.gu, 10), cc: cached.cc ? unpack(cached.cc, 1) : null,
      sst: cached.sst ? unpack(cached.sst, 10) : null, windAt: new Date(cached.at), missing: cached.missing || 0, sstError: cached.sstError || null });
    return;
  }
  const wind = await fetchPoints("https://api.open-meteo.com/v1/forecast", pts,
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover",
    { wind_speed_unit: "ms", past_days: String(PAST_DAYS), forecast_days: String(FORECAST_DAYS) });
  const ref = wind.out.find((l) => l && l.hourly && l.hourly.time);
  if (!ref) throw wind.err || new Error("ingen data");
  const ts = ref.hourly.time;
  const [sp, dr, gu, cc] = fillArrays(wind.out, ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "cloud_cover"], ts);
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

  Object.assign(state, { ts, keys: ts.map((x) => dkKey(x * 1000)), T: ts.length, N: pts.length, sp, dr, gu, cc, sst, missing, sstError, windAt: new Date() });
  store.set(CACHE_KEY, { at: Date.now(), sig, ts, sp: pack(sp, 10), dr: pack(dr, 1), gu: pack(gu, 10), cc: pack(cc, 1), sst: sst ? pack(sst, 10) : null, missing, sstError });
}

// ------------------------------------------------------------------ dage og tid
function futureIdx() {
  const today = todayStr();
  const out = [];
  state.keys.forEach((k, i) => { if (k.slice(0, 10) >= today) out.push(i); });
  return out;
}
function dayLabel(d, long = false) {
  if (d === todayStr()) return "I dag";
  const dt = new Date(d + "T12:00:00");
  const tomorrow = new Date(Date.parse(todayStr() + "T12:00:00") + 86400e3);
  if (dt.toDateString() === tomorrow.toDateString()) return "I morgen";
  const s = dt.toLocaleDateString("da-DK", long ? { weekday: "long", day: "numeric", month: "short" } : { weekday: "short", day: "numeric" }).replace(/\./g, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function setTime(day, hour) {
  state.day = day; state.hour = hour;
  update();
}

// ------------------------------------------------------------------ kort
let map, sel = null; // sel = valgt kyststrækning (feature)

const SEA = "#0B1C2E", LAND = "#16212E";
const FALLBACK_STYLE = {
  version: 8,
  sources: { carto: { type: "raster", tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap © CARTO" } },
  layers: [{ id: "bg", type: "background", paint: { "background-color": SEA } }, { id: "carto", type: "raster", source: "carto", paint: { "raster-opacity": 0.85 } }],
};

// Henter OpenFreeMaps lyse "positron"-stil og farver den om til nattefarver.
function darkify(st) {
  for (const l of st.layers || []) {
    const id = l.id.toLowerCase();
    l.paint = l.paint || {};
    const p = l.paint;
    if (l.type === "background") p["background-color"] = LAND;
    else if (l.type === "fill") {
      delete p["fill-pattern"]; delete p["fill-outline-color"];
      if (/water|ocean|sea|bay|lake|river/.test(id)) { p["fill-color"] = SEA; p["fill-opacity"] = 1; }
      else if (/building/.test(id)) { p["fill-color"] = "#1D2938"; p["fill-opacity"] = 0.7; }
      else { p["fill-color"] = "#1A2634"; p["fill-opacity"] = 0.6; }
    } else if (l.type === "line") {
      delete p["line-pattern"];
      if (/water|river|stream|canal|ditch/.test(id)) p["line-color"] = "#14324D";
      else if (/boundary|admin/.test(id)) p["line-color"] = "#34465C";
      else { p["line-color"] = "#243245"; p["line-opacity"] = 0.9; }
    } else if (l.type === "symbol") {
      if (l.layout && l.layout["text-field"]) {
        p["text-color"] = /water|ocean|sea|marine|bay|lake/.test(id) ? "#4F7AA0" : "#8597AD";
        p["text-halo-color"] = SEA; p["text-halo-width"] = 1.2; p["text-halo-blur"] = 0.5;
      }
      p["icon-opacity"] = 0.45;
    } else if (l.type === "fill-extrusion") {
      l.layout = Object.assign({}, l.layout, { visibility: "none" });
    }
  }
  return st;
}
async function baseStyle() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    const r = await fetch("https://tiles.openfreemap.org/styles/positron", { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(r.status);
    return darkify(await r.json());
  } catch {
    return FALLBACK_STYLE;
  }
}

async function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: await baseStyle(),
    bounds: DK_BOUNDS,
    fitBoundsOptions: { padding: { top: 70, bottom: dockHeight() + 20, left: 20, right: 20 } },
    attributionControl: { compact: true },
    maxZoom: 17,
  });
  if (window.innerWidth > 560) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-right");
  map.on("style.load", () => { addLayers(); lastSig = ""; update(); });
  map.on("moveend", () => { clearTimeout(areaTimer); areaTimer = setTimeout(() => { areaSig = ""; renderTimeline(); }, 250); });

  const hit = (e) => {
    const r = 12;
    return map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ["coast"] })[0];
  };
  map.on("click", (e) => {
    const f = hit(e);
    if (f) select(state.coast.features[f.properties.i]);
    else select(null);
  });
  map.on("mousemove", (e) => { map.getCanvas().style.cursor = hit(e) ? "pointer" : ""; });
}

function coastColorExpr() {
  const c = colors();
  return ["match", ["coalesce", ["feature-state", "s"], 0], 3, c[3], 2, c[2], 1, c[1], 9, c[9], c[0]];
}

function addLayers() {
  if (map.getSource("coast")) return;
  const firstSymbol = (map.getStyle().layers.find((x) => x.type === "symbol") || {}).id;
  map.addSource("sat", { type: "raster", tileSize: 256, maxzoom: 18, attribution: "Luftfoto © Esri, Maxar, Earthstar Geographics",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] });
  map.addLayer({ id: "sat", type: "raster", source: "sat", paint: { "raster-brightness-max": 0.75, "raster-saturation": -0.2 },
    layout: { visibility: state.layers.sat ? "visible" : "none" } }, firstSymbol);

  if (state.vand) {
    map.addSource("vand", { type: "geojson", data: state.vand, promoteId: "id" });
    map.addLayer({ id: "vand", type: "fill", source: "vand", layout: { visibility: state.layers.vand ? "visible" : "none" },
      paint: { "fill-color": ["coalesce", ["get", "color"], "#94a3b8"], "fill-opacity": 0.22 } }, firstSymbol);
  }
  if (state.fred) {
    const vis = { visibility: state.layers.fred ? "visible" : "none" };
    map.addSource("fred", { type: "geojson", data: state.fred, promoteId: "id" });
    map.addLayer({ id: "fred-fill", type: "fill", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: vis,
      paint: { "fill-color": "#B18CFF", "fill-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.2, 0.05] } });
    map.addLayer({ id: "fred-line", type: "line", source: "fred", filter: ["!=", ["get", "t"], "omr"], layout: vis,
      paint: { "line-color": "#B18CFF", "line-width": 1, "line-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.7, 0.3] } });
    map.addLayer({ id: "fred-omr", type: "line", source: "fred", filter: ["==", ["get", "t"], "omr"], layout: vis,
      paint: { "line-color": REG_COLOR, "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [3, 2] } });
  }
  if (state.oerred) {
    // Ørredkortet: vandløbsstationer farvet efter yngeltæthed (DTU Aquas klasser).
    map.addSource("oerred", { type: "geojson", data: state.oerred });
    map.addLayer({ id: "oerred", type: "circle", source: "oerred", minzoom: 6.5, filter: [">=", ["get", "k"], 1],
      layout: { visibility: state.layers.oerred ? "visible" : "none", "circle-sort-key": ["get", "k"] },
      paint: { "circle-color": ["match", ["get", "k"], 4, OERRED_COLORS[4], 3, OERRED_COLORS[3], 2, OERRED_COLORS[2], OERRED_COLORS[1]],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, ["match", ["get", "k"], 4, 3, 3, 2.6, 2, 2, 1.6], 12, ["match", ["get", "k"], 4, 7, 3, 6, 2, 5, 4]],
        "circle-stroke-color": SEA, "circle-stroke-width": 1, "circle-opacity": 0.95 } });
  }
  map.addSource("coast", { type: "geojson", data: state.coast, promoteId: "i", tolerance: 0.2 });
  // Zoom må kun stå øverst i et interpolate-udtryk, så hver bredde bygges som sit eget udtryk.
  const STOPS = [[6, 1.8], [9, 3.2], [12, 5.5], [15, 9]];
  const W = (fn) => ["interpolate", ["linear"], ["zoom"], ...STOPS.flatMap(([z, w]) => [z, fn(w)])];
  const width = W((w) => w);
  const reg = ["boolean", ["feature-state", "reg"], false];
  const on = ["boolean", ["feature-state", "sel"], false];
  // Glød under kysten – "lysende kyst" mod det mørke hav.
  map.addLayer({ id: "coast-glow", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": coastColorExpr(), "line-width": W((w) => w * 3), "line-blur": W((w) => w * 1.6), "line-opacity": 0.32 } });
  map.addLayer({ id: "coast-sel", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#E8EEF5", "line-width": W((w) => w + 7), "line-opacity": ["case", on, 1, 0] } });
  map.addLayer({ id: "coast-casing", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", reg, REG_COLOR, SEA], "line-width": W((w) => ["case", reg, w + 4, w + 2]), "line-opacity": 0.95 } });
  map.addLayer({ id: "coast", type: "line", source: "coast", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": width, "line-color": coastColorExpr() } });
}

function setVis(id, on) { if (map && map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
function applyPalette() {
  const c = colors();
  const root = document.documentElement.style;
  root.setProperty("--good", c[3]); root.setProperty("--ok", c[2]); root.setProperty("--bad", c[1]); root.setProperty("--ban", c[9]); root.setProperty("--none", c[0]);
  if (map && map.getLayer("coast")) { map.setPaintProperty("coast", "line-color", coastColorExpr()); map.setPaintProperty("coast-glow", "line-color", coastColorExpr()); }
  renderCard();
}
function dockHeight() { const d = document.querySelector(".dock-inner"); return d ? d.getBoundingClientRect().height : 170; }
function syncDockHeight() { document.documentElement.style.setProperty("--dock-h", `${Math.round(dockHeight()) + 8}px`); }

// ------------------------------------------------------------------ valg af strækning
function select(f) {
  if (sel && map.getSource("coast")) map.setFeatureState({ source: "coast", id: sel.properties.i }, { sel: false });
  sel = f;
  if (sel) {
    map.setFeatureState({ source: "coast", id: sel.properties.i }, { sel: true });
    renderCard();
    const cs = sel.geometry.coordinates;
    const mid = cs[Math.floor(cs.length / 2)];
    requestAnimationFrame(() => {
      syncDockHeight();
      const p = map.project(mid);
      const bottom = window.innerHeight - dockHeight() - 24;
      if (p.y > bottom || p.y < 80) map.easeTo({ center: mid, padding: { top: 70, bottom: dockHeight() + 20, left: 0, right: 0 }, duration: 400 });
    });
  } else {
    renderCard();
  }
  areaSig = "";
  renderTimeline();
  renderCaption(currentT());
}

// ------------------------------------------------------------------ opdatering
let lastSig = "";
function update() {
  const t = currentT();
  renderWhen(t);
  renderTimeline();
  renderCaption(t);
  if (!map || !map.getSource("coast") || !state.coast) { renderCard(); return; }
  const sig = [t, state.species, JSON.stringify(state.custom), state.day, !!state.sp].join("|");
  if (sig !== lastSig) {
    lastSig = sig;
    const dateStr = dateOfT(t);
    for (const f of state.coast.features) {
      const r = evaluate(f, t);
      map.setFeatureState({ source: "coast", id: f.properties.i }, { s: r.cls, reg: !!r.reg && !r.banned });
    }
    if (state.fred && map.getSource("fred")) {
      for (const f of state.fred.features) map.setFeatureState({ source: "fred", id: f.properties.id }, { active: zoneActive(f.properties, dateStr) });
    }
  }
  renderCard();
}

function renderWhen(t) {
  const d = state.day || todayStr();
  $("when").textContent = `${dayLabel(d)}, ${pad(state.hour)}:00`;
  $("now").hidden = d === todayStr() && state.hour === nowHour();
}

function renderCaption(t) {
  const el = $("caption");
  const c = colors();
  if (state.fredError) { el.innerHTML = `<span class="err">Fredningsbælterne kunne ikke hentes. Forbudte områder vises ikke.</span>`; return; }
  if (state.windError) {
    el.innerHTML = `<span class="err">Vinden kunne ikke hentes (${esc(state.windError)}).</span> <a href="#" id="retry">Prøv igen</a>`;
    const a = $("retry"); if (a) a.onclick = (e) => { e.preventDefault(); startWind(); };
    return;
  }
  if (!state.sp) { el.textContent = "Henter vind og havtemperatur"; return; }
  const what = sel ? "Søjlerne viser den valgte strækning time for time." : "Søjlerne viser, hvor meget af kysten i kortudsnittet der er god.";
  let html = `<span>${what}</span>`;
  if (state.missing) html += `<span class="err">Vind mangler for ${state.missing} af ${state.N} områder.</span>`;
  if (!sel) {
    html += `<span class="key"><i style="background:${c[3]}"></i>God</span><span class="key"><i style="background:${c[2]}"></i>Middel</span>` +
      `<span class="key"><i style="background:${c[1]}"></i>Dårlig</span><span class="key"><i style="background:${c[9]}"></i>Forbudt</span><span class="key"><i class="ring"></i>Særlige regler</span>`;
  }
  el.innerHTML = html;
}

// ------------------------------------------------------------------ tidslinje
let areaSig = "", areaSeries = null, areaTimer = null, tlSig = "";
function sampleVisible() {
  if (!map || !state.coast) return [];
  const b = map.getBounds();
  const vis = state.coast.features.filter((f) => { const c = f.geometry.coordinates[0]; return b.contains(c); });
  const step = Math.max(1, Math.floor(vis.length / 220));
  return vis.filter((_, i) => i % step === 0);
}
function series(idx) {
  if (!state.sp) return idx.map(() => ({ v: 0, c: 0 }));
  if (sel) {
    return idx.map((t) => {
      const r = evaluate(sel, t);
      if (r.banned) return { v: 0.15, c: 9 };
      return { v: r.score == null ? 0 : Math.max(0.06, r.cls === 3 ? Math.max(r.score, 0.7) : Math.min(r.score, r.cls === 2 ? 0.69 : 0.44)), c: r.cls };
    });
  }
  const sig = [state.species, JSON.stringify(state.custom), map ? map.getBounds().toString() : "", state.T].join("|");
  if (sig === areaSig && areaSeries && areaSeries.length === idx.length) return areaSeries;
  const sample = sampleVisible();
  areaSeries = idx.map((t) => {
    let g = 0, y = 0, n = 0, ban = 0;
    for (const f of sample) {
      const r = evaluate(f, t);
      if (r.banned) { ban++; continue; }
      if (!r.cls) continue;
      n++;
      if (r.cls === 3) g++; else if (r.cls === 2) y++;
    }
    if (!n) return { v: ban ? 0.15 : 0, c: ban ? 9 : 0 };
    const v = (g + 0.5 * y) / n;
    return { v: Math.max(0.06, v), c: v >= 0.55 ? 3 : v >= 0.3 ? 2 : 1 };
  });
  areaSig = sig;
  return areaSeries;
}

function renderTimeline() {
  const el = $("tl");
  const idx = futureIdx();
  if (!idx.length) { el.innerHTML = ""; return; }
  // Byg søjlerne én gang pr. datasæt
  const sig = `${state.T}|${idx[0]}|${idx.length}`;
  if (sig !== tlSig) {
    tlSig = sig;
    let html = "", lastDay = "";
    idx.forEach((t, j) => {
      const d = state.keys[t].slice(0, 10);
      if (d !== lastDay) {
        if (lastDay) html += `</div><div class="dl" data-d="${lastDay}">${esc(dayLabel(lastDay))}</div></div>`;
        html += `<div class="tday"><div class="bars">`;
        lastDay = d;
      }
      html += `<i data-j="${j}"></i>`;
    });
    html += `</div><div class="dl" data-d="${lastDay}">${esc(dayLabel(lastDay))}</div></div>`;
    el.innerHTML = html;
    el.setAttribute("aria-valuemax", String(idx.length - 1));
  }
  const vals = series(idx);
  const bars = el.querySelectorAll(".bars i");
  const cur = currentT();
  const nowKey = dkKey(Date.now()).slice(0, 13);
  let curEl = null;
  bars.forEach((b, j) => {
    const t = idx[j];
    const { v, c } = vals[j] || { v: 0, c: 0 };
    b.style.height = `${Math.round(6 + v * 40)}px`;
    b.className = `c${c}${state.keys[t] < nowKey ? " past" : ""}${t === cur ? " on" : ""}`;
    if (t === cur) curEl = b;
  });
  el.querySelectorAll(".dl").forEach((d) => d.classList.toggle("sel", d.dataset.d === state.day));
  const j = idx.indexOf(cur);
  el.setAttribute("aria-valuenow", String(Math.max(0, j)));
  el.setAttribute("aria-valuetext", $("when").textContent);
  if (curEl && !scrubbing) {
    const r = curEl.getBoundingClientRect(), box = el.getBoundingClientRect();
    if (r.left < box.left + 20 || r.right > box.right - 20) el.scrollLeft += r.left - box.left - box.width / 2;
  }
}

let scrubbing = false;
function bindTimeline() {
  const el = $("tl");
  const pick = (x, y) => {
    const target = document.elementFromPoint(x, y);
    let b = target && target.closest ? target.closest(".bars i") : null;
    if (!b) {
      // mellem søjlerne: tag nærmeste
      let best = null, bd = 1e9;
      el.querySelectorAll(".bars i").forEach((i) => { const r = i.getBoundingClientRect(); const d = Math.abs(r.left + r.width / 2 - x); if (d < bd) { bd = d; best = i; } });
      b = bd < 12 ? best : null;
    }
    if (!b) return;
    const t = futureIdx()[+b.dataset.j];
    if (t == null) return;
    const k = state.keys[t];
    if (k.slice(0, 10) !== state.day || +k.slice(11, 13) !== state.hour) setTime(k.slice(0, 10), +k.slice(11, 13));
  };
  let startX = 0, moved = false;
  el.addEventListener("pointerdown", (e) => { scrubbing = true; startX = e.clientX; moved = false; if (e.pointerType === "mouse") pick(e.clientX, e.clientY); });
  el.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    if (Math.abs(e.clientX - startX) > 6) moved = true;
    if (e.pointerType === "mouse") pick(e.clientX, e.clientY);
  });
  const end = (e) => { if (scrubbing && e.pointerType !== "mouse" && !moved) pick(e.clientX, e.clientY); scrubbing = false; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => { scrubbing = false; });
  el.addEventListener("keydown", (e) => {
    const idx = futureIdx();
    let j = idx.indexOf(currentT());
    if (e.key === "ArrowRight") j++; else if (e.key === "ArrowLeft") j--;
    else if (e.key === "PageDown") j += 24; else if (e.key === "PageUp") j -= 24; else return;
    e.preventDefault();
    j = Math.max(0, Math.min(idx.length - 1, j));
    const k = state.keys[idx[j]];
    setTime(k.slice(0, 10), +k.slice(11, 13));
  });
}

// ------------------------------------------------------------------ svarkort
function pct(f) { const p = Math.round((f - 1) * 100); return `${p > 0 ? "+" : "−"}${Math.abs(p)} %`; }
function windWord(v) { return v < 1.5 ? "Næsten vindstille" : v < 4 ? "Svag" : v < 7 ? "Let" : v < 10 ? "Frisk" : v < 14 ? "Hård" : "Stormende"; }

function speciesReminder(dateStr) {
  const m = +dateStr.slice(5, 7), day = +dateStr.slice(8, 10);
  if (state.species === "havorred" && ((m === 11 && day >= 16) || m === 12 || (m === 1 && day <= 15)))
    return "Husk: farvede havørreder er fredede i saltvand fra 16. november til 15. januar. Blanke fisk må tages.";
  if (state.species === "fladfisk")
    return "Torsk må ikke hjemtages eller er begrænset i flere farvande, bl.a. Bælthavet og Østersøen. Tjek de aktuelle regler.";
  return "";
}

function renderCard() {
  const el = $("card");
  if (!sel) { el.hidden = true; el.innerHTML = ""; syncDockHeight(); return; }
  const t = currentT();
  const r = evaluate(sel, t);
  const pr = sel.properties;
  const c = colors();
  const dateStr = dateOfT(t);
  const when = `${dayLabel(dateStr, true).toLowerCase()} kl. ${pad(state.hour)}`;

  // Én sætning om hvorfor
  let why = "";
  if (r.v != null) {
    if (r.v < 1.5) why = "Næsten vindstille.";
    else {
      const kind = r.delta != null ? windKind(r.delta).toLowerCase() : "vind";
      why = `${windWord(r.v)} ${kind}, ${fmt(r.v, 0)} m/s fra ${compass(r.dir)}.`;
    }
    if (Number.isFinite(r.gust) && r.gust > profile().gust) why += ` Vindstød op til ${fmt(r.gust, 0)} m/s.`;
    if (Number.isFinite(r.sst)) why += ` Vandet er ${fmt(r.sst, 0)} °C.`;
  } else if (state.sp) why = "Der mangler vinddata for dette sted.";
  else why = "Henter vind …";
  let near = "";
  if ((state.species === "havorred" || state.species === "custom") && (pr.oh || pr.om)) {
    const parts = [];
    if (pr.oh) parts.push(`${pr.oh} ${pr.oh === 1 ? "station" : "stationer"} med god eller høj ørredyngel`);
    if (pr.om) parts.push(`${pr.om} med moderat`);
    near = `<p class="near">Gydevandløb inden for 10 km: ${parts.join(", ")} (DTU Aqua).</p>`;
  }

  // Blink
  let lure = "";
  if (r.v != null && !r.banned) {
    const pt = state.points[pr.g];
    const cloud = state.cc && t >= 0 && pr.g != null ? state.cc[pr.g * state.T + t] : NaN;
    const light = r.light || (t >= 0 && pt ? lightPhase(sunElevation(state.ts[t] * 1000, pt[1], pt[0])) : "day");
    const vq = r.vand;
    const a = lureAdvice(state.species, { light, cloud, murky: r.murky != null && r.murky >= 8,
      green: !!(vq && (vq.fy === 1 || vq.fy === 2)) && [5, 6, 7, 8, 9].includes(+dateStr.slice(5, 7)), s: pr.s, sst: r.sst, d2: pr.d2 });
    const sw = a.sw.map((k) => `<i title="${esc(k)}" style="background:${LURE_COLORS[k]}"></i>`).join("");
    lure = `<div class="lure">${sw ? `<div class="swatches">${sw}</div>` : ""}<div><b>${esc(a.what)}</b><span>${esc(a.why)}</span></div></div>`;
  }

  // Hvad trækker op og ned
  const chips = r.factors.length && !r.banned
    ? `<div class="chips">${r.factors.map(([ff, label]) => `<span class="${ff >= 1 ? "up" : "down"}">${pct(ff)} ${esc(label)}</span>`).join("")}</div>` : "";

  // Regler og forbehold
  const rules = [];
  for (const z of r.zones) {
    const active = zoneActive(z, dateStr);
    let txt = `<b>${esc(zoneText(z))}${z.n ? `, ${esc(z.n)}` : ""}.</b> `;
    if (z.note) txt += esc(z.note);
    else if (z.stang) txt += esc(z.r || "Stangfiskeri tilladt.");
    else if (z.t === "omr") txt += "Særlige regler for redskaber eller fangst. Tjek reglerne, før du fisker.";
    else if (active) txt += z.t === "ukendt" ? "Perioden kunne ikke tolkes og er regnet som forbudt." : "Alt fiskeri er forbudt på denne dato.";
    else if (z.t === "per") txt += "Gælder ikke på denne dato.";
    const url = safeUrl(z.url);
    const src = [z.kilde || z.lov, z.v ? "kontrolleret" : z.uv ? "ikke kontrolleret" : ""].filter(Boolean).join(", ");
    if (src || url) txt += `<small>${esc(src)}${url ? `${src ? " – " : ""}<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">bekendtgørelsen</a>` : ""}</small>`;
    rules.push(`<div class="rule${active ? " ban" : ""}">${txt}</div>`);
  }
  for (const n of r.notes) rules.push(`<div class="rule info">${esc(n)}</div>`);
  const rem = speciesReminder(dateStr);
  if (rem) rules.push(`<div class="rule info">${esc(rem)}</div>`);

  // Detaljer
  const rows = [];
  if (Number.isFinite(r.gust)) rows.push(["Vindstød", `${fmt(r.gust, 0)} m/s`]);
  if (Number.isFinite(r.sst)) rows.push(["Havtemperatur", `${fmt(r.sst)} °C`]);
  if (pr.d1 != null || pr.d2 != null) rows.push(["Dybde 150 / 400 m ude", `ca. ${pr.d1 != null ? fmt(pr.d1) : "–"} / ${pr.d2 != null ? fmt(pr.d2) : "–"} m`]);
  if (pr.s) rows.push(["Bund", SUBSTRATE[pr.s] || "–"]);
  if (r.vand) rows.push(["Vandkvalitet", `${esc(r.vand.label || "Ukendt")}${r.vand.n ? ` (${esc(r.vand.n)})` : ""}`]);
  if (pr.oh || pr.om) rows.push(["Ørredvandløb inden for 10 km", `${pr.oh || 0} gode/høje, ${pr.om || 0} moderate`]);
  const details = rows.length ? `<details><summary>Detaljer</summary><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl></details>` : "";

  el.innerHTML = `<div class="card-head"><div><div class="verdict" style="color:${c[r.cls]}">${LABELS[r.cls]}</div>` +
    `<div class="for">for ${esc(profile().name.toLowerCase())}, ${esc(when)}</div></div>` +
    `<button class="close" id="closeCard" aria-label="Luk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>` +
    `<p class="why">${esc(why)}</p>${near}${lure}${chips}${rules.length ? `<div class="rules">${rules.join("")}</div>` : ""}${details}`;
  el.hidden = false;
  $("closeCard").onclick = () => select(null);
  syncDockHeight();
}

// ------------------------------------------------------------------ indstillinger og arter
function renderSpecies() {
  const el = $("species");
  el.innerHTML = "";
  for (const [k, s] of Object.entries(SPECIES)) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="long">${esc(s.name)}</span><span class="short">${esc(s.short)}</span>`;
    b.title = s.name;
    b.setAttribute("aria-pressed", k === state.species);
    b.onclick = () => { state.species = k; store.set("species", k); renderSpecies(); areaSig = ""; update(); if (k === "custom") openSheet(); };
    el.appendChild(b);
  }
  $("customBox").style.display = state.species === "custom" ? "" : "none";
}
function openSheet() { $("sheet").classList.add("open"); $("sheet").setAttribute("aria-hidden", "false"); $("customBox").style.display = state.species === "custom" ? "" : "none"; $("closeSettings").focus(); }
function closeSheet() { $("sheet").classList.remove("open"); $("sheet").setAttribute("aria-hidden", "true"); $("openSettings").focus(); }

function bindUI() {
  $("now").onclick = () => setTime(todayStr(), nowHour());
  $("openSettings").onclick = openSheet;
  $("closeSettings").onclick = closeSheet;
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if ($("sheet").classList.contains("open")) closeSheet(); else if (sel) select(null); } });

  const toggles = { tSat: ["sat", ["sat"]], tFred: ["fred", ["fred-fill", "fred-line", "fred-omr"]], tVand: ["vand", ["vand"]], tOerred: ["oerred", ["oerred"]] };
  for (const [id, [key, layers]] of Object.entries(toggles)) {
    $(id).checked = !!state.layers[key];
    $(id).addEventListener("change", (e) => { state.layers[key] = e.target.checked; store.set("layers", state.layers); layers.forEach((l) => setVis(l, e.target.checked)); });
  }
  $("tCb").checked = !!state.layers.cb;
  $("tCb").addEventListener("change", (e) => { state.layers.cb = e.target.checked; store.set("layers", state.layers); applyPalette(); renderCaption(currentT()); });

  const c = state.custom;
  const bind = (id, out, key) => {
    $(id).value = c[key];
    $(out).textContent = `${fmt(+c[key])} m/s`;
    $(id).addEventListener("input", (e) => { c[key] = +e.target.value; $(out).textContent = `${fmt(c[key])} m/s`; store.set("custom", c); areaSig = ""; update(); });
  };
  bind("cMin", "oMin", "min"); bind("cMax", "oMax", "max"); bind("cLim", "oLim", "lim");
  $("cDir").value = c.dir;
  $("cDir").addEventListener("change", (e) => { c.dir = e.target.value; store.set("custom", c); areaSig = ""; update(); });
  bindTimeline();
  window.addEventListener("resize", syncDockHeight);
}

async function startWind() {
  state.windError = null; update();
  try { await loadWeather(); }
  catch (e) { state.windError = e.message || String(e); }
  tlSig = ""; areaSig = ""; lastSig = "";
  update();
}

async function main() {
  state.day = todayStr();
  state.hour = nowHour();
  applyPalette();
  renderSpecies(); bindUI(); update(); syncDockHeight();
  try {
    await loadStatic();
  } catch (e) {
    $("loading").innerHTML = `<div><p>Kortdata kunne ikke hentes: ${esc(e.message)}</p></div>`;
    return;
  }
  if (!state.vand) $("tVandRow").classList.add("off");
  if (!state.oerred) { $("tOerredRow").classList.add("off"); $("tOerred").disabled = true; }
  const m = state.meta;
  if (m) $("metaInfo").textContent = `Kortdata er bygget ${new Date(m.built).toLocaleDateString("da-DK", { day: "numeric", month: "long", year: "numeric" })} og dækker ${(m.counts.segments || 0).toLocaleString("da-DK")} kyststrækninger og ${m.counts.fredning || 0} fredningszoner.`;
  await initMap();
  map.once("load", () => $("loading").classList.add("hide"));
  setTimeout(() => $("loading").classList.add("hide"), 6000);
  startWind();
}
main();
