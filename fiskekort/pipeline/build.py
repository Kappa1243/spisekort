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
    right_in_land = left_in_land = tested = 0
    dk = countries["DNK"]
    for i, (s, m) in enumerate(zip(segs, mids)):
        (x0, y0), (x1, y1) = s.coords[0], s.coords[-1]
        chord = math.hypot(x1 - x0, y1 - y0)
        lon0, lat0 = TO_WGS.transform(x0, y0)
        lon1, lat1 = TO_WGS.transform(x1, y1)
        if chord < 0.35 * s.length or chord < 20:
            bearing = -1  # krøllet stykke (lille holm, mole): ingen entydig retning
        else:
            az, _, _ = GEOD.inv(lon0, lat0, lon1, lat1)
            bearing = int(round((az + (270 if flip else 90)) % 360))
            if i % 10 == 0:  # stikprøve: ligger "havsiden" faktisk i vand?
                tested += 1
                ang = math.radians(bearing)
                px, py = m.x + 400 * math.sin(ang), m.y + 400 * math.cos(ang)
                qx, qy = m.x - 400 * math.sin(ang), m.y - 400 * math.cos(ang)
                right_in_land += dk.contains(Point(px, py))
                left_in_land += dk.contains(Point(qx, qy))
        out.append({"geom": s, "mid": m, "b": bearing})
    DISCOVERY["coast_direction_check"] = {
        "tested": tested,
        "sea_side_on_land_pct": round(100 * right_in_land / max(tested, 1), 1),
        "land_side_on_land_pct": round(100 * left_in_land / max(tested, 1), 1),
    }
    log(f"Retningstjek: {DISCOVERY['coast_direction_check']}")
    return out


def build_windpoints(segs):
    cells = defaultdict(list)
    for s in segs:
        m = s["mid"]
        x, y = m.x, m.y
        if s["b"] >= 0:
            a = math.radians(s["b"])
            x, y = x + WIND_OFFSET * math.sin(a), y + WIND_OFFSET * math.cos(a)
        lon, lat = TO_WGS.transform(x, y)
        key = (int((lat - BBOX[1]) // GRID_DLAT), int((lon - BBOX[0]) // GRID_DLON))
        cells[key].append((lon, lat, s))
    points = []
    for key in sorted(cells):
        pts = cells[key]
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        idx = len(points)
        points.append([round(lon, 3), round(lat, 3)])
        for p in pts:
            p[2]["g"] = idx
    log(f"Vindpunkter: {len(points)}")
    return points


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


def fetch_fredning():
    layers: list = []
    errors = []
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


def build_fredning(layers):
    feats = []
    for l in layers:
        for g, a in l["feats"]:
            if g is None or g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            typ, label = classify_fred(l["title"], a)
            g = g.simplify(0.00002)
            feats.append({"type": "Feature", "id": len(feats),
                          "properties": {"id": len(feats), "t": typ, "n": label[:120],
                                         "lag": l["title"][:120]},
                          "geometry": json.loads(json.dumps(mapping(g)))})
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
    for w, c in STATUS_WORDS.items():
        if t.startswith(w) or f" {w}" in f" {t}":
            return c
    return 0


def build_vand():
    feats = wfs_get_all(VP3_EP, VP3_LAYER)
    props = [f.get("properties") or {} for f in feats]
    keys = sorted({k for p in props for k in p})
    distinct = {k: sorted({str(p.get(k))[:60] for p in props})[:25] for k in keys}
    DISCOVERY["vp3_layer"] = {"layer": VP3_LAYER, "count": len(feats), "fields": keys,
                              "distinct": distinct, "sample": props[:2]}
    # find felter med tilstandsklasser
    status_fields = [k for k in keys
                     if sum(status_code(p.get(k)) > 0 for p in props) > 0.3 * len(props)]
    DISCOVERY["vp3_status_fields"] = status_fields
    pref = [k for k in status_fields if re.search(r"oko|øko|samlet|eco", k, re.I)]
    main_field = (pref or status_fields or [None])[0]
    name_field = next((k for k in keys if re.search(r"navn|name", k, re.I)), None)
    out = []
    for f, p in zip(feats, props):
        g = shape(f["geometry"]) if f.get("geometry") else None
        if g is None or g.is_empty:
            continue
        code = status_code(p.get(main_field)) if main_field else 0
        g = g.simplify(0.0004, preserve_topology=True)
        gj = json.loads(json.dumps(mapping(g)))
        if gj["type"] == "Polygon":
            gj["coordinates"] = [rnd(r, 4) for r in gj["coordinates"]]
        elif gj["type"] == "MultiPolygon":
            gj["coordinates"] = [[rnd(r, 4) for r in poly] for poly in gj["coordinates"]]
        else:
            continue
        details = {k: p.get(k) for k in status_fields if k != main_field and p.get(k) not in (None, "")}
        out.append({"type": "Feature", "properties": {
            "id": len(out), "n": str(p.get(name_field) or "")[:100],
            "code": code, "label": str(p.get(main_field) or "Ukendt")[:60],
            "cap": 2 if code in (1, 2) else None, "color": STATUS_COLORS[code],
            "d": details}, "geometry": gj})
    DISCOVERY["vp3_main_field"] = main_field
    return out


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


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "fiskekort"))
    ap.add_argument("--coast-file", help="lokal kystlinje (til test)")
    ap.add_argument("--skip-remote", action="store_true", help="spring ArcGIS/VP3 over (test)")
    a = ap.parse_args()
    out, cache = Path(a.out), Path(a.cache)
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    ok = True
    meta = {"built": started.isoformat(timespec="seconds"), "sources": {}, "counts": {}}

    # 1) fredningsbælter
    fred_feats = []
    if not a.skip_remote:
        try:
            layers = fetch_fredning()
            fred_feats = build_fredning(layers)
            meta["sources"]["fredning"] = "Fiskeristyrelsen, Kort over fredningsbælter (ArcGIS)"
            log(f"Fredningszoner: {len(fred_feats)}")
        except Exception:  # noqa: BLE001
            log("FEJL fredningsbælter:\n" + traceback.format_exc())
        try:
            discover_geoservers()
        except Exception:  # noqa: BLE001
            log("FEJL geoserver-discovery:\n" + traceback.format_exc())
    vand_feats = []
    if not a.skip_remote:
        try:
            vand_feats = build_vand()
            meta["sources"]["vand"] = "Miljøstyrelsen, vandområdeplaner 2021-2027 (VP3), kystvande"
            log(f"Kystvandområder: {len(vand_feats)} (felt: {DISCOVERY.get('vp3_main_field')})")
        except Exception:  # noqa: BLE001
            log("FEJL VP3:\n" + traceback.format_exc())

    # 2) kyst
    try:
        countries = load_countries(cache)
        lines = load_coastlines(cache, a.coast_file)
        segs = build_segments(lines, countries)
        wind = build_windpoints(segs)

        zones_utm = [transform(TO_UTM.transform, shape(f["geometry"])) for f in fred_feats]
        tree = shapely.STRtree(zones_utm) if zones_utm else None

        vand_utm = [transform(TO_UTM.transform, shape(f["geometry"])) for f in vand_feats]
        vtree = shapely.STRtree(vand_utm) if vand_utm else None

        feats = []
        for i, s in enumerate(segs):
            g = s["geom"]
            props = {"i": i, "b": s["b"], "g": s["g"]}
            if tree is not None:
                hits = tree.query(g, predicate="intersects")
                if len(hits):
                    props["f"] = sorted(int(h) for h in hits)
            if vtree is not None:
                m = s["mid"]
                probe = m
                if s["b"] >= 0:
                    ang = math.radians(s["b"])
                    probe = Point(m.x + 200 * math.sin(ang), m.y + 200 * math.cos(ang))
                near = vtree.query_nearest(probe, max_distance=3000)
                if len(near):
                    props["w"] = int(near[0])
            gw = transform(TO_WGS.transform, g.simplify(8))
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "LineString", "coordinates": rnd(gw.coords)}})
        write_json(out / "coast.geojson", {"type": "FeatureCollection", "features": feats})
        write_json(out / "windpoints.json", wind)
        meta["counts"].update({"segments": len(feats), "windpoints": len(wind),
                               "segments_in_fredning": sum(1 for f in feats if "f" in f["properties"])})
        meta["sources"]["kyst"] = "OpenStreetMap coastline (osmdata.openstreetmap.de), ODbL"
    except Exception:  # noqa: BLE001
        ok = False
        log("FEJL kyst:\n" + traceback.format_exc())

    if vand_feats:
        write_json(out / "vand.geojson", {"type": "FeatureCollection", "features": vand_feats})
    meta["counts"]["vand"] = len(vand_feats)
    if fred_feats or not (out / "fredning.geojson").exists():
        write_json(out / "fredning.geojson", {"type": "FeatureCollection", "features": fred_feats})
    meta["counts"]["fredning"] = len(fred_feats)
    write_json(out / "meta.json", meta)
    write_json(out / "_build_log.json", {"ok": ok, "log": LOG, "discovery": DISCOVERY})
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
