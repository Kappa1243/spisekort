#!/usr/bin/env python3
"""Fiskekort – datapipeline.

Bygger de statiske lag, som kortet bruger:
  data/coast.geojson     kyststrækninger (~500 m) med retning ud mod vandet
  data/fredning.geojson  fredningsbælter og særlige fredningszoner
  data/vand.geojson      vandkvalitet (VP3 kystvande), hvis den kan hentes
  data/windpoints.json   punkter, som kortet henter vindprognoser for
  data/meta.json         byggetidspunkt, antal og kilder
  data/_build_log.json   log + discovery (bruges til fejlfinding)

Kører i GitHub Actions (kræver internetadgang). Lokalt:
  python build.py --out ../data --cache ~/.cache/fiskekort
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import requests
import shapely
from pyproj import Geod, Transformer
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import substring
from shapely.ops import transform  # noqa: E402

# ---------------------------------------------------------------- konstanter
BBOX = (7.9, 54.45, 15.3, 57.85)  # lon/lat, Danmark inkl. Bornholm
SEG_LEN = 500  # meter pr. kyststrækning
GRID_DLAT, GRID_DLON = 0.2, 0.3  # celle for vindpunkter (~22 x 19 km)
WIND_OFFSET = 1500  # vindpunkt lægges så langt ude i vandet (m)

COAST_URL = "https://osmdata.openstreetmap.de/download/coastlines-split-4326.zip"
COAST_LAYER = "/vsizip/{zip}/coastlines-split-4326/lines.shp"
NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
          "master/geojson/ne_10m_admin_0_countries.geojson")

# Fiskeristyrelsens "Kort over fredningsbælter i hele Danmark" (ArcGIS Web AppBuilder)
FRED_APP_ID = "5bd97e15c7d548b99640e28662e58a22"
ARCGIS_PORTALS = ["https://kms.maps.arcgis.com", "https://www.arcgis.com"]

VP3_ENDPOINTS = [
    "https://wfs2-miljoegis.mim.dk/vp3endelig2022/ows",
    "https://wfs2-miljoegis.mim.dk/vandprojekter/ows",
    "https://wfs2-miljoegis.mim.dk/vp3genbesoeg2025/ows",
]

TO_UTM = Transformer.from_crs(4326, 25832, always_xy=True)
TO_WGS = Transformer.from_crs(25832, 4326, always_xy=True)
FROM_MERC = Transformer.from_crs(3857, 4326, always_xy=True)
GEOD = Geod(ellps="WGS84")

LOG: list[str] = []
DISCOVERY: dict = {}

S = requests.Session()
S.headers["User-Agent"] = "fiskekort-pipeline (github.com/Kappa1243/spisekort)"


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG.append(line)


def get(url, params=None, timeout=120, tries=3, stream=False):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=timeout, stream=stream)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + 3 * i)
    raise last


def download(url: str, dest: Path, max_age_days: float = 7) -> Path:
    if dest.exists() and (time.time() - dest.stat().st_mtime) < max_age_days * 86400:
        log(f"Bruger cache: {dest.name} ({dest.stat().st_size/1e6:.0f} MB)")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log(f"Henter {url}")
    with get(url, timeout=600, stream=True) as r, open(tmp, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    log(f"Hentet {dest.name} ({dest.stat().st_size/1e6:.0f} MB)")
    return dest


def rnd(coords, nd=5):
    return [[round(x, nd), round(y, nd)] for x, y in coords]


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"Skrev {path.name} ({path.stat().st_size/1e6:.2f} MB)")


# ---------------------------------------------------------------- kystlinje
def load_countries(cache: Path) -> dict[str, shapely.Geometry]:
    p = download(NE_URL, cache / "ne_10m_admin_0_countries.geojson", max_age_days=90)
    ne = gpd.read_file(p)
    ne = ne[ne["ADM0_A3"].isin(["DNK", "SWE", "DEU", "NOR"])].to_crs(25832)
    return {r.ADM0_A3: r.geometry for r in ne.itertuples()}


def load_coastlines(cache: Path, coast_file: str | None) -> list[LineString]:
    if coast_file:
        path = coast_file
    else:
        z = download(COAST_URL, cache / "coastlines-split-4326.zip")
        path = COAST_LAYER.format(zip=z)
    gdf = gpd.read_file(path, bbox=BBOX)
    log(f"Kystlinjer i bbox: {len(gdf)}")
    parts = []
    for g in gdf.geometry:
        if g is None or g.is_empty:
            continue
        g = shapely.clip_by_rect(g, *BBOX)
        if g.is_empty:
            continue
        if g.geom_type == "LineString":
            parts.append(g)
        elif g.geom_type == "MultiLineString":
            parts.extend(g.geoms)
    merged = shapely.line_merge(shapely.MultiLineString(parts), directed=True)
    lines = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    log(f"Sammenhængende kystlinjer: {len(lines)}")
    return lines


def build_segments(lines_wgs, countries):
    """Del kystlinjen op i ~500 m stykker. OSM-konvention: land til venstre,
    vand til højre for linjens retning -> retning ud mod vandet = azimut + 90."""
    # Konventionstjek: lukkede ringe (øer) skal gå mod uret, hvis land er til venstre.
    rings = [transform(TO_UTM.transform, l) for l in lines_wgs if l.is_closed and len(l.coords) > 3]
    ccw = sum(shapely.LinearRing(r.coords).is_ccw for r in rings)
    flip = bool(rings) and ccw < len(rings) / 2
    DISCOVERY["ring_check"] = {"closed_rings": len(rings), "ccw": int(ccw), "flipped": flip}
    log(f"Ringtjek: {DISCOVERY['ring_check']}")

    segs = []
    for line in lines_wgs:
        lp = transform(TO_UTM.transform, line)
        L = lp.length
        if L < 60:
            continue
        n = max(1, round(L / SEG_LEN))
        for k in range(n):
            s = substring(lp, k * L / n, (k + 1) * L / n)
            if s.is_empty or s.length < 30 or s.geom_type != "LineString":
                continue
            segs.append(s)
    log(f"Kyststrækninger før landefilter: {len(segs)}")

    mids = shapely.line_interpolate_point(np.array(segs, dtype=object), 0.5, normalized=True)
    names = list(countries)
    dists = np.vstack([shapely.distance(mids, countries[c]) for c in names])
    nearest = np.array(names)[dists.argmin(axis=0)]
    keep = nearest == "DNK"
    segs = [s for s, k in zip(segs, keep) if k]
    mids = mids[keep]
    log(f"Kyststrækninger i Danmark: {len(segs)}")

    out = []
    for s, m in zip(segs, mids):
        (x0, y0), (x1, y1) = s.coords[0], s.coords[-1]
        chord = math.hypot(x1 - x0, y1 - y0)
        lon0, lat0 = TO_WGS.transform(x0, y0)
        lon1, lat1 = TO_WGS.transform(x1, y1)
        if chord < 0.35 * s.length or chord < 20:
            bearing = -1  # krøllet stykke (lille holm, mole): ingen entydig retning
        else:
            az, _, _ = GEOD.inv(lon0, lat0, lon1, lat1)
            bearing = int(round((az + (270 if flip else 90)) % 360))
        out.append({"geom": s, "mid": m, "b": bearing})
    return out


def _offset(s, dist):
    m = s["mid"]
    if s["b"] < 0:
        return m.x, m.y
    a = math.radians(s["b"])
    return m.x + dist * math.sin(a), m.y + dist * math.cos(a)


def build_windpoints(segs, water=None, max_points=240):
    """Ét vindpunkt pr. (celle, vandområde), placeret ude i vandet tæt på kysten.
    Gruppering pr. vandområde (VP3) holder fx Vesterhavet og Ringkøbing Fjord adskilt."""
    if water is not None:
        shapely.prepare(water)
    for dlat, dlon in ((0.3, 0.45), (0.4, 0.6), (0.5, 0.75), (0.7, 1.05)):
        groups = defaultdict(list)
        for s in segs:
            lon, lat = TO_WGS.transform(s["mid"].x, s["mid"].y)
            key = (int((lat - BBOX[1]) // dlat), int((lon - BBOX[0]) // dlon), s.get("w", -1))
            groups[key].append(s)
        if len(groups) <= max_points:
            break
    points, on_land = [], 0
    for key in sorted(groups):
        members = groups[key]
        cx = sum(s["mid"].x for s in members) / len(members)
        cy = sum(s["mid"].y for s in members) / len(members)
        best = None
        for dist in (1500, 800, 3000):
            cands = [_offset(s, dist) for s in members if s["b"] >= 0]
            if water is not None:
                cands = [c for c in cands if shapely.contains_xy(water, *c)]
            if cands:
                best = min(cands, key=lambda c: (c[0] - cx) ** 2 + (c[1] - cy) ** 2)
                break
        if best is None:
            best = (cx, cy)
            on_land += 1
        lon, lat = TO_WGS.transform(*best)
        idx = len(points)
        points.append([round(lon, 3), round(lat, 3)])
        for s in members:
            s["g"] = idx
    DISCOVERY["windpoints"] = {"count": len(points), "cell": [dlat, dlon], "not_in_water": on_land}
    log(f"Vindpunkter: {len(points)} (celle {dlat}x{dlon}, {on_land} uden vandplacering)")
    return points


def borrow_bearings(segs, max_dist=1500):
    """Strækninger uden entydig retning (små holme, moler) låner retningen fra den
    nærmeste strækning med en klar retning, så de ikke får en straf for 'uklar' retning."""
    known = [s for s in segs if s["b"] >= 0]
    if not known:
        return
    tree = shapely.STRtree([s["mid"] for s in known])
    n = 0
    for s in segs:
        if s["b"] >= 0:
            continue
        hit = tree.query_nearest(s["mid"], max_distance=max_dist)
        if len(hit):
            s["b"] = known[int(hit[0])]["b"]
            s["nb"] = 1
            n += 1
    left = sum(1 for s in segs if s["b"] < 0)
    DISCOVERY["borrowed_bearings"] = {"borrowed": n, "still_unknown": left}
    log(f"Lånt retning: {n} strækninger, {left} stadig uden retning")


def direction_check(segs, water):
    """Andel strækninger, hvor 'havsiden' ligger på land og 'landsiden' i vand (omvendt retning)."""
    shapely.prepare(water)
    good = bad = 0
    for s in segs[::5]:
        if s["b"] < 0:
            continue
        sea = shapely.contains_xy(water, *_offset(s, 150))
        land = shapely.contains_xy(water, *_offset(s, -150))
        if sea and not land:
            good += 1
        elif land and not sea:
            bad += 1
    tested = good + bad
    pct = 100 * bad / max(tested, 1)
    DISCOVERY["direction_check_water"] = {"decisive": tested, "correct": good, "reversed": bad,
                                          "reversed_pct": round(pct, 2)}
    log(f"Retningstjek mod VP3-vand: {good} rigtige, {bad} omvendte ({pct:.1f} %)")
    return pct


# ---------------------------------------------------------------- ArcGIS
def esri_to_shapely(geom: dict, sr: int):
    if not geom:
        return None
    tr = FROM_MERC.transform if sr in (102100, 3857, 102113) else None

    def fix(coords):
        if tr:
            return [tr(x, y) for x, y, *_ in coords]
        return [(x, y) for x, y, *_ in coords]

    if "rings" in geom:
        polys = [Polygon(fix(r)) for r in geom["rings"] if len(r) >= 4]
        outers, holes = [], []
        for p in polys:
            (holes if p.exterior.is_ccw else outers).append(p)  # Esri: ydre ringe er med uret
        if not outers:
            outers, holes = holes, []
        res = []
        for o in outers:
            hs = [h.exterior.coords for h in holes if o.contains(h.representative_point())]
            res.append(Polygon(o.exterior.coords, hs))
        g = res[0] if len(res) == 1 else MultiPolygon(res)
        return g.buffer(0) if not g.is_valid else g
    if "paths" in geom:
        ls = [LineString(fix(p)) for p in geom["paths"] if len(p) >= 2]
        return ls[0] if len(ls) == 1 else shapely.MultiLineString(ls)
    if "x" in geom and "y" in geom:
        return Point(*fix([(geom["x"], geom["y"])])[0])
    return None


def arcgis_json(url, params=None):
    p = {"f": "json", **(params or {})}
    r = get(url, params=p, timeout=120)
    j = r.json()
    if isinstance(j, dict) and "error" in j:
        raise RuntimeError(f"ArcGIS fejl {url}: {j['error']}")
    return j


def arcgis_item_data(item_id):
    last = None
    for portal in ARCGIS_PORTALS:
        try:
            return arcgis_json(f"{portal}/sharing/rest/content/items/{item_id}/data")
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def arcgis_query_layer(url):
    meta = arcgis_json(url)
    ids = arcgis_json(f"{url}/query", {"where": "1=1", "returnIdsOnly": "true"})
    oids = sorted(ids.get("objectIds") or [])
    feats = []
    for i in range(0, len(oids), 200):
        chunk = oids[i:i + 200]
        j = arcgis_json(f"{url}/query", {
            "objectIds": ",".join(map(str, chunk)), "outFields": "*",
            "returnGeometry": "true", "outSR": "4326"})
        sr = (j.get("spatialReference") or {}).get("wkid", 4326)
        for f in j.get("features", []):
            feats.append((esri_to_shapely(f.get("geometry"), sr), f.get("attributes", {})))
    return meta, feats


def summarize(feats, fields_meta=None):
    attrs = [a for _, a in feats]
    keys = sorted({k for a in attrs for k in a})
    distinct = {}
    for k in keys:
        vals = {str(a.get(k))[:80] for a in attrs}
        if len(vals) <= 15:
            distinct[k] = sorted(vals)
    return {"count": len(feats), "fields": keys, "sample": attrs[:3], "distinct": distinct,
            "geom_types": sorted({g.geom_type for g, _ in feats if g is not None})}


def collect_arcgis_layers(oplayers, out, prefix=""):
    for ol in oplayers or []:
        title = (prefix + " / " if prefix else "") + str(ol.get("title") or ol.get("id") or "")
        if ol.get("featureCollection"):
            for sub in ol["featureCollection"].get("layers", []):
                fs = sub.get("featureSet", {})
                sr = ((sub.get("layerDefinition") or {}).get("spatialReference")
                      or fs.get("spatialReference") or {}).get("wkid", 102100)
                feats = [(esri_to_shapely(f.get("geometry"), sr), f.get("attributes", {}))
                         for f in fs.get("features", [])]
                name = (sub.get("layerDefinition") or {}).get("name", "")
                out.append({"title": f"{title} / {name}".strip(" /"), "src": "featureCollection",
                            "feats": feats})
        url = ol.get("url")
        if url:
            url = url.rstrip("/")
            if re.search(r"/(MapServer|FeatureServer)/\d+$", url):
                urls = [url]
            else:
                svc = arcgis_json(url)
                urls = [f"{url}/{l['id']}" for l in svc.get("layers", [])
                        if not l.get("subLayerIds")]
            for u in urls:
                try:
                    meta, feats = arcgis_query_layer(u)
                    out.append({"title": f"{title} / {meta.get('name', '')}".strip(" /"),
                                "src": u, "feats": feats})
                except Exception as e:  # noqa: BLE001
                    out.append({"title": title, "src": u, "feats": [], "error": str(e)[:300]})
        if ol.get("layers") and not url:
            collect_arcgis_layers(ol["layers"], out, title)


FRED_RE = re.compile(r"fredning|fredede|fiskeri.?forbud|fredningsb", re.I)


def arcgis_search(q):
    j = arcgis_json("https://www.arcgis.com/sharing/rest/search", {"q": q, "num": 100})
    return j.get("results", [])


# Fredningsbælter (Landbrugs- og Fiskeristyrelsens web-app på lbst.maps.arcgis.com)
FRED_SERVICE = ("https://services-eu1.arcgis.com/c3o7qz6F0HswtuVz/arcgis/rest/services/"
                "Fredningsbælter/FeatureServer")


def fetch_fredning():
    layers: list = []
    errors = []
    try:
        collect_arcgis_layers([{"url": FRED_SERVICE, "title": "Fredningsbælter"}], layers)
        layers = [l for l in layers if l["feats"]]
    except Exception as e:  # noqa: BLE001
        errors.append(f"service: {e}"[:300])
        layers = []
    if layers:
        DISCOVERY["fred_errors"] = errors
        DISCOVERY["fred_layers"] = [
            {"title": l["title"], "src": l["src"], "error": l.get("error"), **summarize(l["feats"])}
            for l in layers]
        return layers
    # a) Fiskeristyrelsens web-app (link fra fiskepleje.dk)
    try:
        app = arcgis_item_data(FRED_APP_ID)
        map_id = (app.get("map") or {}).get("itemId")
        DISCOVERY["fred_app_map_id"] = map_id
        webmap = arcgis_item_data(map_id) if map_id else app
        collect_arcgis_layers(webmap.get("operationalLayers"), layers)
    except Exception as e:  # noqa: BLE001
        errors.append(f"app: {e}"[:300])
    # b) søg efter offentlige ArcGIS-elementer
    if not layers:
        found = []
        for q in ("fredningsbælter", "fredningsbaelter", "fredningsbælte", "fredningszoner fiskeri",
                  "Fiskeristyrelsen", "LFST fiskeri"):
            try:
                for it in arcgis_search(q):
                    if it["id"] not in {f["id"] for f in found}:
                        found.append({k: it.get(k) for k in ("id", "title", "type", "owner", "url", "access")})
            except Exception as e:  # noqa: BLE001
                errors.append(f"search {q}: {e}"[:200])
        DISCOVERY["fred_search"] = found
        for it in found:
            if not FRED_RE.search(it.get("title") or ""):
                continue
            try:
                if it["type"] in ("Feature Service", "Map Service") and it.get("url"):
                    collect_arcgis_layers([{"url": it["url"], "title": it["title"]}], layers)
                elif it["type"] in ("Web Map", "Web Mapping Application"):
                    d = arcgis_item_data(it["id"])
                    if it["type"] == "Web Mapping Application":
                        mid = (d.get("map") or {}).get("itemId") or ((d.get("values") or {}).get("webmap"))
                        d = arcgis_item_data(mid) if mid else {}
                    collect_arcgis_layers(d.get("operationalLayers"), layers, it["title"])
            except Exception as e:  # noqa: BLE001
                errors.append(f"{it['title']}: {e}"[:300])
    DISCOVERY["fred_errors"] = errors
    DISCOVERY["fred_layers"] = [
        {"title": l["title"], "src": l["src"], "error": l.get("error"), **summarize(l["feats"])}
        for l in layers]
    return layers


MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "maj": 5, "jun": 6, "jul": 7, "aug": 8,
          "sep": 9, "okt": 10, "nov": 11, "dec": 12}
PERIOD_RE = re.compile(r"(\d{1,2})\.?\s*([a-zæøå]{3})[a-zæøå]*\.?\s*(?:-|–|til)\s*"
                       r"(?:og med\s*)?(\d{1,2})\.?\s*([a-zæøå]{3})", re.I)


MONTH_ONLY_RE = re.compile(r"^\s*([a-zæøå]{3})[a-zæøå]*\s*(?:-|–|til|og)\s*([a-zæøå]{3})[a-zæøå]*\s*$", re.I)
MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def parse_periods(text: str):
    out = []
    for d1, m1, d2, m2 in PERIOD_RE.findall(text or ""):
        a, b = MONTHS.get(m1.lower()), MONTHS.get(m2.lower())
        if a and b:
            out.append([a, int(d1), b, int(d2)])
    if not out:  # fx "November - marts", "April og maj"
        m = MONTH_ONLY_RE.match(text or "")
        if m:
            a, b = MONTHS.get(m.group(1).lower()), MONTHS.get(m.group(2).lower())
            if a and b:
                out.append([a, 1, b, MONTH_DAYS[b]])
    return out


def classify_lfst(a: dict):
    """LFST-laget: FREDNINGSP (tekst), PeriodeTyp (1=helår, 2=halvår, 0=andet)."""
    txt = str(a.get("FREDNINGSP") or "").strip()
    ptype = str(a.get("PeriodeTyp") or "").strip()
    periods = parse_periods(txt)
    if re.search(r"hele året|helår|helårlig", txt, re.I) or (ptype == "1" and not periods):
        t, periods = "hel", []
    elif periods:
        t = "per"
    elif ptype == "2":
        t, periods = "per", [[9, 16, 3, 15]]
    else:
        t = "ukendt"
    red = str(a.get("Redskab") or "").strip()
    rod_ok = bool(re.search(r"stang", red, re.I) and re.search(r"tilladt", red, re.I))
    props = {"t": t, "n": str(a.get("NAVN") or "").strip()[:100], "txt": txt[:120]}
    if periods:
        props["p"] = periods
    if red:
        props["r"] = red[:120]
    if rod_ok:
        props["stang"] = 1
    www = str(a.get("WWW") or "").strip()
    if www.startswith("http"):
        props["url"] = www
    return props


def classify_fred(title: str, attrs: dict) -> tuple[str, str]:
    """-> (type, label). type: 'hel' (hele året), 'halv' (16/9-15/3), 'saer' (andre regler)."""
    text = (title + " " + " ".join(str(v) for v in attrs.values() if v is not None)).lower()
    label = ""
    for k in ("Navn", "NAVN", "navn", "Name", "NAME", "Vandloeb", "VANDLOB", "Lokalitet", "TEKST",
              "Tekst", "Beskrivel"):
        if attrs.get(k):
            label = str(attrs[k])
            break
    if "halvår" in text or "halvaar" in text or "16. sep" in text or "16/9" in text:
        return "halv", label
    if "helår" in text or "helaar" in text or "hele året" in text:
        return "hel", label
    return "saer", label


OMR_KM2 = 10
OVERRIDES_FILE = Path(__file__).resolve().parent / "fredning_overrides.json"


def load_overrides():
    try:
        return json.loads(OVERRIDES_FILE.read_text(encoding="utf-8")).get("rules", [])
    except FileNotFoundError:
        return []


def apply_override(props: dict, rules, used: defaultdict):
    navn, lov, txt, km2 = props.get("n", ""), props.get("lov", ""), props.get("txt", ""), props.get("km2", 0)
    for i, r in enumerate(rules):
        if "navn" in r and navn != r["navn"]:
            continue
        if "navn_re" in r and not re.search(r["navn_re"], navn):
            continue
        if "lov" in r and not re.search(r["lov"], lov):
            continue
        if "txt_re" in r and not re.search(r["txt_re"], txt):
            continue
        if "km2_min" in r and km2 < r["km2_min"]:
            continue
        if "km2_max" in r and km2 > r["km2_max"]:
            continue
        props["t"] = r["t"]
        props.pop("p", None)
        props.pop("stang", None)
        if r.get("p"):
            props["p"] = r["p"]
        if r.get("stang"):
            props["stang"] = 1
        props["note"] = r.get("note", "")[:300]
        props["kilde"] = r.get("kilde", "")[:120]
        props["v"] = 1  # kontrolleret mod bekendtgørelsen
        used[i] += 1
        return True
    return False


def build_fredning(layers):
    rules = load_overrides()
    used = defaultdict(int)
    feats, seen = [], set()
    unparsed = defaultdict(int)
    texts = defaultdict(int)
    for l in layers:
        for g, a in l["feats"]:
            if g is None or g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            key = (a.get("ID"), a.get("NAVN"), round(g.area, 9))
            if key in seen:
                continue
            seen.add(key)
            if "FREDNINGSP" in a or "PeriodeTyp" in a:
                props = classify_lfst(a)
                texts[f"{a.get('PeriodeTyp')} | {props['txt']}"] += 1
                if props["t"] == "ukendt":
                    unparsed[props["txt"]] += 1
            else:
                typ, label = classify_fred(l["title"], a)
                props = {"t": "hel" if typ == "hel" else "per" if typ == "halv" else "ukendt",
                         "n": label[:120]}
                if typ == "halv":
                    props["p"] = [[9, 16, 3, 15]]
            # Store polygoner (fx Roskilde Fjord syd for Eskilsø, Karrebæk Fjord, Præstø Fjord) er
            # reguleringsområder med redskabs- og fangstbegrænsninger – ikke fiskeforbud.
            area_km2 = transform(TO_UTM.transform, g).area / 1e6
            if area_km2 > OMR_KM2 and not props.get("stang"):
                props["t"] = "omr"
                props.pop("p", None)
            lov = str(a.get("LOVGRUNDLA") or "").strip()
            if lov:
                props["lov"] = lov[:120]
            props["km2"] = round(area_km2, 2)
            if not apply_override(props, rules, used) and (area_km2 > 1 or props["t"] in ("ukendt", "omr")):
                props["uv"] = 1  # stor eller uklar zone, ikke kontrolleret
            props["id"] = len(feats)
            g = g.simplify(0.00002)
            feats.append({"type": "Feature", "id": len(feats), "properties": props,
                          "geometry": json.loads(json.dumps(mapping(g)))})
    DISCOVERY["fred_period_texts"] = dict(sorted(texts.items(), key=lambda kv: -kv[1]))
    DISCOVERY["fred_unparsed"] = dict(unparsed)
    DISCOVERY["fred_types"] = {t: sum(1 for f in feats if f["properties"]["t"] == t)
                               for t in ("hel", "per", "ukendt", "omr")}
    DISCOVERY["fred_overrides_used"] = {f"{i}:{(rules[i].get('navn') or rules[i].get('navn_re'))[:40]}": n
                                        for i, n in sorted(used.items())}
    DISCOVERY["fred_overrides_unused"] = [i for i in range(len(rules)) if i not in used]
    for f in feats:  # afrund koordinater
        geom = f["geometry"]
        if geom["type"] == "Polygon":
            geom["coordinates"] = [rnd(r) for r in geom["coordinates"]]
        else:
            geom["coordinates"] = [[rnd(r) for r in p] for p in geom["coordinates"]]
    return feats


# ---------------------------------------------------------------- GeoServer discovery
GEOSERVERS = [
    "https://geodata.fvm.dk/geoserver/ows",
    "https://arealeditering-dist-geo.miljoeportal.dk/geoserver/wfs",
    "https://wfs2-miljoegis.mim.dk/ows",
]


def wfs_layers(ep):
    r = get(ep, params={"service": "WFS", "version": "2.0.0", "request": "GetCapabilities"},
            timeout=180, tries=2)
    return re.findall(r"<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>\s*<(?:wfs:)?Title>([^<]*)<", r.text)


def discover_geoservers():
    out = []
    for ep in GEOSERVERS:
        try:
            names = wfs_layers(ep)
            hit = [(n, t) for n, t in names
                   if re.search(r"fredning|fiskeri|b(æ|ae)lte|reservat|fisk", n + " " + t, re.I)]
            out.append({"endpoint": ep, "n_layers": len(names), "hits": hit[:60]})
        except Exception as e:  # noqa: BLE001
            out.append({"endpoint": ep, "error": str(e)[:200]})
    DISCOVERY["geoservers"] = out


def wfs_get_all(ep, typename, page=1000):
    feats, start = [], 0
    while True:
        r = get(ep, params={"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                            "typeNames": typename, "outputFormat": "application/json",
                            "srsName": "EPSG:4326", "count": page, "startIndex": start},
                timeout=300, tries=3)
        j = r.json()
        batch = j.get("features", [])
        feats.extend(batch)
        if len(batch) < page:
            return feats
        start += page


# ---------------------------------------------------------------- VP3 vandkvalitet
VP3_EP = "https://wfs2-miljoegis.mim.dk/vp3endelig2022/ows"
VP3_LAYER = "vp3endelig2022:vp3e2022_marin_samlet"
STATUS_WORDS = {"høj": 5, "god": 4, "moderat": 3, "ringe": 2, "dårlig": 1}
STATUS_COLORS = {5: "#2563eb", 4: "#16a34a", 3: "#eab308", 2: "#f97316", 1: "#dc2626", 0: "#94a3b8"}


def status_code(v):
    if v is None:
        return 0
    t = str(v).strip().lower()
    if t.startswith("maksimalt"):
        return 5
    if t.startswith(("ikke", "ukendt")):
        return 0
    for w, c in STATUS_WORDS.items():
        if t.startswith(w):
            return c
    return 0


VP3_FIELDS = {"sm": "til_oko_sm", "fy": "til_oko_fy", "an": "til_oko_an", "bb": "til_oko_bb"}


def build_vand():
    """Økologisk tilstand pr. kystvand. sm = samlet, fy = fytoplankton (klorofyl),
    an = ålegræs/blomsterplanter, bb = bundfauna (påvirkes af iltsvind)."""
    feats = wfs_get_all(VP3_EP, VP3_LAYER)
    props = [f.get("properties") or {} for f in feats]
    keys = sorted({k for p in props for k in p})
    distinct = {k: sorted({str(p.get(k))[:60] for p in props})[:25] for k in keys}
    DISCOVERY["vp3_layer"] = {"layer": VP3_LAYER, "count": len(feats), "fields": keys,
                              "distinct": distinct, "sample": props[:2]}
    out = []
    water = []
    for f, p in zip(feats, props):
        g = shape(f["geometry"]) if f.get("geometry") else None
        if g is None or g.is_empty:
            continue
        water.append(g)
        if str(p.get("ov_kat", "Kystvand")) != "Kystvand":
            continue
        g = g.simplify(0.0004, preserve_topology=True)
        gj = json.loads(json.dumps(mapping(g)))
        if gj["type"] == "Polygon":
            gj["coordinates"] = [rnd(r, 4) for r in gj["coordinates"]]
        elif gj["type"] == "MultiPolygon":
            gj["coordinates"] = [[rnd(r, 4) for r in poly] for poly in gj["coordinates"]]
        else:
            continue
        pr = {"id": len(out), "n": str(p.get("ov_navn") or "")[:100],
              "label": str(p.get("til_oko_sm") or "Ukendt").replace(" økologisk", "")[:60]}
        for k, field in VP3_FIELDS.items():
            pr[k] = status_code(p.get(field))
        pr["color"] = STATUS_COLORS[pr["sm"]]
        out.append({"type": "Feature", "properties": pr, "geometry": gj})
    DISCOVERY["vp3_sm_counts"] = {c: sum(1 for f in out if f["properties"]["sm"] == c) for c in range(6)}
    geoms = shapely.make_valid(np.array([transform(TO_UTM.transform, g) for g in water], dtype=object))
    water_utm = shapely.union_all(shapely.buffer(geoms, 0))
    return out, water_utm


def discover_vp3():
    found = []
    for ep in VP3_ENDPOINTS:
        try:
            r = get(ep, params={"service": "WFS", "version": "2.0.0", "request": "GetCapabilities"},
                    timeout=120, tries=2)
            names = re.findall(r"<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>\s*<(?:wfs:)?Title>([^<]*)<",
                               r.text)
            kyst = [(n, t) for n, t in names if re.search(r"kyst|coast|marin", n + t, re.I)]
            found.append({"endpoint": ep, "n_layers": len(names), "kyst_layers": kyst[:80]})
        except Exception as e:  # noqa: BLE001
            found.append({"endpoint": ep, "error": str(e)[:200]})
    DISCOVERY["vp3"] = found
    # stikprøver af attributter for de mest lovende lag
    samples = {}
    for f in found:
        for n, t in f.get("kyst_layers", []):
            if not re.search(r"tilstand", n + t, re.I) or len(samples) >= 12:
                continue
            try:
                r = get(f["endpoint"], params={
                    "service": "WFS", "version": "2.0.0", "request": "GetFeature",
                    "typeNames": n, "count": 3, "outputFormat": "application/json",
                    "srsName": "EPSG:4326"}, timeout=120, tries=2)
                j = r.json()
                samples[n] = {"title": t, "endpoint": f["endpoint"],
                              "props": [x.get("properties") for x in j.get("features", [])]}
            except Exception as e:  # noqa: BLE001
                samples[n] = {"title": t, "error": str(e)[:200]}
    DISCOVERY["vp3_samples"] = samples


# ---------------------------------------------------------------- dybde og bund
# Indsættes i build.py. Dybde fra EMODnet Bathymetry DTM 2024 (~115 m grid, ERDDAP),
# bundtype fra EUSeaMap 2023 (EMODnet Seabed Habitats, Folk 5-klasser).
BATHY_URL = ("https://erddap.emodnet.eu/erddap/griddap/bathymetry_dtm_2024.nc?"
             "elevation[({lat0}):1:({lat1})][({lon0}):1:({lon1})]")
SUBSTRATE_WFS = [
    "https://drive.emodnet-geology.eu/geoserver/gtk/wfs",
    "https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_view/wfs",
]
SUBSTRATE_CLASSES = [  # (kode, regex mod klassenavn, dansk navn)
    (5, r"rock|boulder", "Sten/klippe"),
    (3, r"coarse", "Grus/groft"),
    (4, r"mixed", "Blandet"),
    (2, r"sand", "Sand"),
    (1, r"mud", "Mudder"),
]
PROBE_M = (150, 400)  # målepunkter ud fra kysten


def load_bathymetry(cache: Path):
    """-> (lats, lons, depth[m, positiv nedad]) som numpy-arrays."""
    import netCDF4  # noqa: PLC0415
    url = BATHY_URL.format(lat0=BBOX[1], lat1=BBOX[3], lon0=BBOX[0], lon1=BBOX[2])
    p = download(url, cache / "bathymetry_dk.nc", max_age_days=180)
    with netCDF4.Dataset(p) as ds:
        lats = np.array(ds.variables["latitude"][:], dtype="f8")
        lons = np.array(ds.variables["longitude"][:], dtype="f8")
        z = np.ma.filled(ds.variables["elevation"][:].astype("f4"), np.nan)
    DISCOVERY["bathy"] = {"shape": list(z.shape), "lat": [float(lats.min()), float(lats.max())],
                          "lon": [float(lons.min()), float(lons.max())],
                          "z_pct": [float(np.nanpercentile(z, q)) for q in (1, 50, 99)]}
    return lats, lons, z


def sample_grid(lats, lons, z, lon, lat):
    i = int(round((lat - lats[0]) / (lats[1] - lats[0])))
    j = int(round((lon - lons[0]) / (lons[1] - lons[0])))
    if 0 <= i < len(lats) and 0 <= j < len(lons):
        return float(z[i, j])
    return float("nan")


def load_substrate():
    """Henter bundtype-polygoner for Danmark fra EMODnet (WFS, bbox)."""
    for ep in SUBSTRATE_WFS:
        try:
            names = wfs_layers(ep)
        except Exception as e:  # noqa: BLE001
            DISCOVERY.setdefault("substrate_errors", []).append(f"{ep}: {e}"[:200])
            continue
        allsubs = [n for n, t in names if re.search(r"subs|eusm", n, re.I)]
        DISCOVERY.setdefault("substrate_layers", {})[ep] = allsubs[:80]
        # EMODnet Geology: seabed_substrate_<skala>; grovere skalaer dækker hele Danmark.
        # EUSeaMap: europæiske substratlag (ikke caribiske/kaspiske).
        cands = [n for n in allsubs if re.search(r"seabed_substrate_(250k|1m|100k|50k)", n, re.I)
                 or re.search(r"(^|:)eusm\d{4}_subs", n, re.I)]

        def rank(n):
            order = ["250k", "1m", "100k", "50k"]
            for i, o in enumerate(order):
                if re.search(rf"_{o}", n, re.I):
                    return (i, len(n))
            return (9, len(n))
        cands.sort(key=rank)
        for n in cands:
            try:
                r = get(ep, params={"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                                    "typeNames": n, "outputFormat": "application/json",
                                    "srsName": "EPSG:4326",
                                    "bbox": f"{BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]},urn:ogc:def:crs:EPSG::4326"},
                        timeout=600, tries=2)
                j = r.json()
                feats = j.get("features", [])
                if not feats:
                    continue
                keys = sorted({k for f in feats[:200] for k in (f.get("properties") or {})})
                DISCOVERY["substrate_used"] = {"endpoint": ep, "layer": n, "count": len(feats), "fields": keys,
                                               "sample": [f.get("properties") for f in feats[:2]]}
                return feats
            except Exception as e:  # noqa: BLE001
                DISCOVERY.setdefault("substrate_errors", []).append(f"{n}: {e}"[:200])
    return []


def substrate_code(props: dict) -> int:
    """Folk 5-klasser: Mud to muddy sand / Sand / Coarse substrate / Mixed sediment / Rock & boulders."""
    t = str(props.get("folk_5cl_txt") or "").strip().lower()
    if not t:
        t = " ".join(str(v) for k, v in props.items()
                      if isinstance(v, str) and re.search(r"subs|folk|class|descr", k, re.I)).lower()
    if t.startswith("mud") or "mud to" in t:
        return 1
    for code, rx, _ in SUBSTRATE_CLASSES:
        if re.search(rx, t, re.I):
            return code
    return 0


def place_quality(segs, cache: Path):
    """Tilføjer d1/d2 (dybde i m ved 150/400 m ud) og s (bundtype-kode) til segmenterne."""
    try:
        lats, lons, z = load_bathymetry(cache)
        # EMODnet: elevation er negativ under havet. Tjek fortegn med stikprøve.
        probe = []
        for s in segs[::50]:
            if s["b"] < 0:
                continue
            a = math.radians(s["b"])
            x, y = s["mid"].x + 2000 * math.sin(a), s["mid"].y + 2000 * math.cos(a)
            lon, lat = TO_WGS.transform(x, y)
            probe.append(sample_grid(lats, lons, z, lon, lat))
        sign = -1.0 if np.nanmedian(probe) < 0 else 1.0
        DISCOVERY["bathy_sign"] = sign
        n_ok = 0
        for s in segs:
            if s["b"] < 0:
                continue
            a = math.radians(s["b"])
            for key, dist in zip(("d1", "d2"), PROBE_M):
                x, y = s["mid"].x + dist * math.sin(a), s["mid"].y + dist * math.cos(a)
                lon, lat = TO_WGS.transform(x, y)
                d = sign * sample_grid(lats, lons, z, lon, lat)
                if np.isfinite(d) and d > 0:
                    s[key] = round(d, 1)
            n_ok += "d2" in s
        log(f"Dybde fundet for {n_ok} strækninger")
    except Exception:  # noqa: BLE001
        log("FEJL dybde:\n" + traceback.format_exc())

    try:
        feats = load_substrate()
        if feats:
            polys = []
            codes = []
            for f in feats:
                c = substrate_code(f.get("properties") or {})
                if c and f.get("geometry"):
                    polys.append(transform(TO_UTM.transform, shape(f["geometry"])))
                    codes.append(c)
            tree = shapely.STRtree(polys)
            n_ok = 0
            for s in segs:
                p = s["mid"]
                if s["b"] >= 0:
                    a = math.radians(s["b"])
                    p = Point(p.x + PROBE_M[0] * math.sin(a), p.y + PROBE_M[0] * math.cos(a))
                hit = tree.query_nearest(p, max_distance=800)
                if len(hit):
                    s["s"] = codes[int(hit[0])]
                    n_ok += 1
            DISCOVERY["substrate_counts"] = {c: codes.count(c) for c in set(codes)}
            log(f"Bundtype fundet for {n_ok} strækninger")
    except Exception:  # noqa: BLE001
        log("FEJL bundtype:\n" + traceback.format_exc())


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "fiskekort"))
    ap.add_argument("--coast-file", help="lokal kystlinje (til test)")
    ap.add_argument("--skip-remote", action="store_true", help="spring ArcGIS/VP3/dybde over (test)")
    a = ap.parse_args()
    out, cache = Path(a.out), Path(a.cache)
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    errors: list[str] = []
    meta = {"built": started.isoformat(timespec="seconds"), "sources": {}, "counts": {}}
    try:
        prev = json.loads((out / "meta.json").read_text(encoding="utf-8")).get("counts", {})
    except Exception:  # noqa: BLE001
        prev = {}

    # 1) fredningsbælter (kritisk: uden dem vises ingen forbud)
    fred_feats = []
    if not a.skip_remote:
        try:
            fred_feats = build_fredning(fetch_fredning())
            if not fred_feats:
                raise RuntimeError("ingen fredningszoner hentet")
            meta["sources"]["fredning"] = "Fiskeristyrelsen, Fredningsbælter (ArcGIS) + håndkontrollerede rettelser"
            log(f"Fredningszoner: {len(fred_feats)} {DISCOVERY.get('fred_types')}")
        except Exception:  # noqa: BLE001
            errors.append("fredning")
            log("FEJL fredningsbælter:\n" + traceback.format_exc())

    # 2) vandkvalitet + vandpolygon (kritisk: bruges til vindpunkter og retningstjek)
    vand_feats, water = [], None
    if not a.skip_remote:
        try:
            vand_feats, water = build_vand()
            meta["sources"]["vand"] = "Miljøstyrelsen, vandområdeplaner 2021-2027 (VP3), kystvande"
            log(f"Kystvandområder: {len(vand_feats)} {DISCOVERY.get('vp3_sm_counts')}")
        except Exception:  # noqa: BLE001
            errors.append("vand")
            log("FEJL VP3:\n" + traceback.format_exc())

    # 3) kyst
    feats, wind = [], []
    try:
        countries = load_countries(cache)
        lines = load_coastlines(cache, a.coast_file)
        segs = build_segments(lines, countries)
        if water is not None and direction_check(segs, water) > 5:
            errors.append("retning")
        borrow_bearings(segs)

        zones_utm = [transform(TO_UTM.transform, shape(f["geometry"])) for f in fred_feats]
        tree = shapely.STRtree(zones_utm) if zones_utm else None
        vand_utm = [transform(TO_UTM.transform, shape(f["geometry"])) for f in vand_feats]
        vtree = shapely.STRtree(vand_utm) if vand_utm else None
        for s in segs:
            if tree is not None:
                hits = tree.query(s["geom"], predicate="dwithin", distance=75)
                if len(hits):
                    s["f"] = sorted(int(h) for h in hits)
            if vtree is not None:
                near = vtree.query_nearest(Point(*_offset(s, 200)), max_distance=3000)
                if len(near):
                    s["w"] = int(near[0])
        wind = build_windpoints(segs, water)
        if not a.skip_remote:
            place_quality(segs, cache)
            meta["sources"]["dybde"] = "EMODnet Bathymetry DTM 2024; bundtype: EMODnet Geology seabed substrate 1:250.000"

        for i, s in enumerate(segs):
            props = {"i": i, "b": s["b"], "g": s["g"]}
            for k in ("f", "w", "d1", "d2", "s", "nb"):
                if k in s:
                    props[k] = s[k]
            gw = transform(TO_WGS.transform, s["geom"].simplify(8))
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "LineString", "coordinates": rnd(gw.coords)}})
        meta["counts"].update({
            "segments": len(feats), "windpoints": len(wind),
            "segments_in_fredning": sum(1 for f in feats if "f" in f["properties"]),
            "segments_with_depth": sum(1 for f in feats if "d2" in f["properties"]),
            "segments_with_substrate": sum(1 for f in feats if "s" in f["properties"])})
        meta["sources"]["kyst"] = "OpenStreetMap coastline (osmdata.openstreetmap.de), ODbL"
    except Exception:  # noqa: BLE001
        errors.append("kyst")
        log("FEJL kyst:\n" + traceback.format_exc())
    meta["counts"]["vand"] = len(vand_feats)
    meta["counts"]["fredning"] = len(fred_feats)

    # 4) sanity: må ikke falde markant i forhold til sidste build
    if not a.skip_remote:
        for key, frac in (("segments", 0.95), ("fredning", 0.8), ("vand", 0.9)):
            if prev.get(key) and meta["counts"].get(key, 0) < frac * prev[key]:
                errors.append(f"{key} faldt fra {prev[key]} til {meta['counts'].get(key, 0)}")

    # 5) skriv alt eller intet
    if errors:
        log(f"Build afbrudt – data er IKKE opdateret. Fejl: {errors}")
        write_json(out / "_build_log.json", {"ok": False, "errors": errors, "log": LOG, "discovery": DISCOVERY})
        return 1
    files = {"coast.geojson": {"type": "FeatureCollection", "features": feats},
             "windpoints.json": wind, "meta.json": meta}
    if not a.skip_remote:
        files["fredning.geojson"] = {"type": "FeatureCollection", "features": fred_feats}
        files["vand.geojson"] = {"type": "FeatureCollection", "features": vand_feats}
    tmp = out / ".tmp_build"
    tmp.mkdir(exist_ok=True)
    for name, obj in files.items():
        write_json(tmp / name, obj)
    for name in files:
        (tmp / name).replace(out / name)
    tmp.rmdir()
    write_json(out / "_build_log.json", {"ok": True, "log": LOG, "discovery": DISCOVERY})
    return 0


if __name__ == "__main__":
    sys.exit(main())
