#!/usr/bin/env python3
"""
Bake OpenStreetMap extracts of a campus into the compact model the WebGL
renderer loads at runtime (`<pack>/campus.json`).

The frame (origin, bounding boxes, metres per unit) and the landmark list come
from a content pack — `content/<event>/event.json` and `monuments.json` — so a
fork points the script at its own pack and never edits this file. Source data
is fetched from the Overpass API with `--fetch` and cached (gitignored) under
design/osm/; the committed campus.json is what ships.

Everything is projected to a local metric frame centred on the pack's origin,
so the renderer never touches spherical maths.

    python3 design/build-campus.py --pack content/hackillinois-2027            # build
    python3 design/build-campus.py --pack content/hackillinois-2027 --fetch    # refresh cache, then build
    python3 design/build-campus.py --pack content/hackillinois-2027 --check    # rebuild to a temp file, compare hash
    python3 design/build-campus.py --pack content/hackillinois-2027 --core-only  # preview: academic core only

The build is deterministic: inputs are sorted by OSM id, floats are rounded,
and `meta.hash` is the sha256 of the document with `meta.builtAt`/`meta.hash`
removed. `--check` exits 1 when the committed hash drifts or a monument in
monuments.json fails to resolve.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OSM_DIR = HERE / "osm"
MANIFEST = OSM_DIR / "manifest.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DEFAULT_PACK = ROOT / "content" / "hackillinois-2027"
SCHEMA = 1

FETCH = """Refresh the cache with:

  python3 design/build-campus.py --fetch

(one POST per design/osm/*.overpass query, results cached as design/osm/*.json
with a manifest.json recording URL, query hash, size, sha256 and fetch time)
"""

# --- Frame (defaults; the pack's event.json overrides) ----------------------
# Main Quad centroid, confirmed against the OSM "Main Quad" park polygon.
ORIGIN_LAT, ORIGIN_LNG = 40.10746, -88.22713
METERS_PER_UNIT = 10.0
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(ORIGIN_LAT))

# Campus core plus the stadium/arena block to the south-west.
BBOX = (40.0950, -88.2405, 40.1175, -88.2195)  # (south, west, north, east)
# The academic core, where pedestrian detail is worth carrying.
CORE_BBOX = (40.1020, -88.2340, 40.1170, -88.2210)

# --- Massing rules ---------------------------------------------------------
LEVEL_HEIGHT = 3.8
DEFAULT_HEIGHT = {
    "university": 15.0,
    "apartments": 17.0,
    "dormitory": 20.0,
    "commercial": 12.0,
    "retail": 8.0,
    "house": 7.0,
    "detached": 7.0,
    "semidetached_house": 7.0,
    "residential": 9.0,
    "garage": 3.5,
    "roof": 4.0,
    "yes": 9.0,
}
MIN_FOOTPRINT_M2 = 55.0
SIMPLIFY_TOLERANCE_M = 1.1

ROAD_WIDTH = {
    "primary": 16.0, "secondary": 14.0, "tertiary": 12.0,
    "residential": 9.0, "unclassified": 9.0, "service": 5.5,
    "footway": 2.6, "path": 2.2,
}

# --- Territory gyms --------------------------------------------------------
# Read from `<pack>/monuments.json`. `match` claims the OSM way or multipolygon
# relation with that name. `at` is a verified centroid used when the building
# carries no name; the nearest unclaimed footprint within 55 m wins. `synth`
# opts out of matching entirely and masses the monument from its centroid —
# for the statue, which has no footprint to speak of.
MONUMENTS: list[dict] = []


# ---------------------------------------------------------------------------
# Pack
# ---------------------------------------------------------------------------

def configure(pack_dir: Path, core_only: bool = False) -> dict:
    """Load event.json + monuments.json and point the frame at that campus."""
    global ORIGIN_LAT, ORIGIN_LNG, METERS_PER_UNIT, M_PER_DEG_LNG, BBOX, CORE_BBOX, MONUMENTS

    event_path = pack_dir / "event.json"
    mon_path = pack_dir / "monuments.json"
    for p in (event_path, mon_path):
        if not p.exists():
            sys.exit(f"pack is missing {p}")
    with open(event_path) as fh:
        event = json.load(fh)
    with open(mon_path) as fh:
        monuments = json.load(fh)["monuments"]

    campus = event.get("campus", {})
    if "origin" in campus:
        ORIGIN_LAT, ORIGIN_LNG = float(campus["origin"][0]), float(campus["origin"][1])
        M_PER_DEG_LNG = 111320.0 * math.cos(math.radians(ORIGIN_LAT))
    if "metersPerUnit" in campus:
        METERS_PER_UNIT = float(campus["metersPerUnit"])
    if "bbox" in campus:
        BBOX = tuple(float(v) for v in campus["bbox"])
    if "coreBbox" in campus:
        CORE_BBOX = tuple(float(v) for v in campus["coreBbox"])
    if core_only:
        BBOX = CORE_BBOX

    MONUMENTS = []
    for m in monuments:
        rec = dict(m)
        if "at" in rec:
            rec["at"] = (float(rec["at"][0]), float(rec["at"][1]))
        if "synth" in rec:
            rec["synth"] = tuple(float(v) for v in rec["synth"])
        rec.setdefault("blurb", "")
        MONUMENTS.append(rec)
    if not MONUMENTS:
        sys.exit(f"{mon_path} declares no monuments")
    return event


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def to_world(lat: float, lng: float) -> tuple[float, float]:
    """WGS84 -> local metric frame. +x east, +z south, in world units."""
    return (
        (lng - ORIGIN_LNG) * M_PER_DEG_LNG / METERS_PER_UNIT,
        -(lat - ORIGIN_LAT) * M_PER_DEG_LAT / METERS_PER_UNIT,
    )


def in_bbox(lat: float, lng: float) -> bool:
    s, w, n, e = BBOX
    return s <= lat <= n and w <= lng <= e


def centroid(geom) -> tuple[float, float]:
    """Mean vertex position, ignoring OSM's repeated closing node."""
    pts = geom
    if len(pts) > 2 and pts[0]["lat"] == pts[-1]["lat"] and pts[0]["lon"] == pts[-1]["lon"]:
        pts = pts[:-1]
    return (
        sum(p["lat"] for p in pts) / len(pts),
        sum(p["lon"] for p in pts) / len(pts),
    )


def ring_area_m2(pts: list[tuple[float, float]]) -> float:
    """Shoelace area of a world-unit ring, returned in square metres."""
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * z1 - x1 * z0
    return abs(a) / 2.0 * METERS_PER_UNIT ** 2


def simplify(pts: list[tuple[float, float]], tol_units: float) -> list[tuple[float, float]]:
    """Douglas-Peucker on an open polyline."""
    if len(pts) < 3:
        return pts

    def rec(lo: int, hi: int, keep: set[int]) -> None:
        if hi <= lo + 1:
            return
        x0, z0 = pts[lo]
        x1, z1 = pts[hi]
        dx, dz = x1 - x0, z1 - z0
        norm = math.hypot(dx, dz)
        best_i, best_d = -1, 0.0
        for i in range(lo + 1, hi):
            px, pz = pts[i]
            if norm < 1e-9:
                d = math.hypot(px - x0, pz - z0)
            else:
                d = abs(dz * px - dx * pz + x1 * z0 - z1 * x0) / norm
            if d > best_d:
                best_i, best_d = i, d
        if best_d > tol_units:
            keep.add(best_i)
            rec(lo, best_i, keep)
            rec(best_i, hi, keep)

    keep = {0, len(pts) - 1}
    sys.setrecursionlimit(10000)
    rec(0, len(pts) - 1, keep)
    return [pts[i] for i in sorted(keep)]


def ensure_ccw(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Normalise winding so the renderer's extruder can assume one direction."""
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * z1 - x1 * z0
    return pts if a > 0 else pts[::-1]


def parse_height(tags: dict) -> float | None:
    raw = tags.get("height")
    if raw:
        try:
            return float(str(raw).replace("m", "").strip())
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            return float(str(lv).split(";")[0].strip()) * LEVEL_HEIGHT + 1.2
        except ValueError:
            pass
    return None


def assemble_rings(ways: list[list[dict]]) -> list[list[dict]]:
    """
    Chain multipolygon member ways into closed rings. OSM splits a relation's
    outer boundary into any number of ways, in any order and direction; join
    them end-to-end on shared node coordinates. Unclosable fragments are
    dropped rather than guessed at.
    """
    segs = [list(w) for w in ways if len(w) >= 2]
    rings: list[list[dict]] = []

    def key(p: dict) -> tuple[float, float]:
        return (p["lat"], p["lon"])

    while segs:
        cur = segs.pop(0)
        while key(cur[0]) != key(cur[-1]):
            end = key(cur[-1])
            for i, s in enumerate(segs):
                if key(s[0]) == end:
                    cur += s[1:]
                    segs.pop(i)
                    break
                if key(s[-1]) == end:
                    cur += s[-2::-1]
                    segs.pop(i)
                    break
            else:
                break  # open fragment — nothing left to join
        if len(cur) >= 4 and key(cur[0]) == key(cur[-1]):
            rings.append(cur)
    return rings


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def load(name: str):
    path = OSM_DIR / name
    if not path.exists():
        sys.exit(f"missing {path}\n\n{FETCH}")
    with open(path) as fh:
        elements = json.load(fh)["elements"]
    # Overpass returns elements in database order, which is not stable across
    # fetches. Sort so the build is a pure function of the data.
    elements.sort(key=lambda e: (e.get("type", ""), e.get("id", 0)))
    return elements


def footprint(geom: list[dict], tags: dict) -> dict | None:
    """One building record from a closed lat/lon ring, or None if it is culled."""
    if len(geom) < 4:
        return None
    lat, lng = centroid(geom)
    if not in_bbox(lat, lng):
        return None

    # OSM closes rings by repeating the first node; drop the duplicate.
    ring = [to_world(p["lat"], p["lon"]) for p in geom]
    if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
        ring = ring[:-1]
    if len(ring) < 3:
        return None

    ring = simplify(ring, SIMPLIFY_TOLERANCE_M / METERS_PER_UNIT)
    if len(ring) < 3:
        return None
    area = ring_area_m2(ring)
    if area < MIN_FOOTPRINT_M2:
        return None

    btype = tags.get("building", "yes")
    height = parse_height(tags) or DEFAULT_HEIGHT.get(btype, 9.0)
    # Nudge large unlevelled footprints taller so big halls do not read flat.
    if not parse_height(tags) and area > 3000:
        height = max(height, 16.0)

    return {
        "n": tags.get("name"),
        "t": btype,
        "h": round(height / METERS_PER_UNIT, 3),
        "r": {"gabled": "g", "hipped": "h"}.get(tags.get("roof:shape"), ""),
        "p": ensure_ccw(ring),
        "_lat": lat, "_lng": lng, "_area": area,
    }


def build_buildings(elements):
    """
    Ways tagged building=* plus multipolygon relations tagged building=*. The
    big campus halls — Main Library, ECEB, Holonyak — are relations whose outer
    boundary is split across several untagged ways, so a way-only extract never
    saw them. Each assembled outer ring becomes a footprint carrying the
    relation's tags; inner rings (courtyards) are ignored for now.
    """
    relations = [e for e in elements
                 if e.get("type") == "relation" and "building" in e.get("tags", {})
                 and e.get("tags", {}).get("type", "multipolygon") == "multipolygon"]

    # A way that is a member of a building relation is that relation's outline,
    # not a second building — even when it also carries its own building tag.
    member_ways: set[int] = set()
    for r in relations:
        for m in r.get("members", []):
            if m.get("type") == "way":
                member_ways.add(m.get("ref"))

    out = []
    for e in elements:
        if e.get("type") != "way" or e.get("id") in member_ways:
            continue
        geom = e.get("geometry")
        tags = e.get("tags", {})
        if not geom or "building" not in tags:
            continue
        rec = footprint(geom, tags)
        if rec:
            out.append(rec)

    for r in relations:
        outers = [m["geometry"] for m in r.get("members", [])
                  if m.get("type") == "way" and m.get("role", "outer") == "outer" and m.get("geometry")]
        recs = [footprint(ring, r.get("tags", {})) for ring in assemble_rings(outers)]
        recs = [x for x in recs if x]
        # Largest ring first so a name match lands on the main mass, not an annex.
        recs.sort(key=lambda x: -x["_area"])
        out.extend(recs)
    return out


def clip_runs(geom, box):
    """
    Split a polyline into the runs of consecutive vertices inside `box`, in
    world units. Dropping outside vertices but keeping one polyline joined the
    last point before an exit to the first after re-entry with a straight
    chord, so a road or creek that leaves the frame and comes back was drawn
    cutting across it. Separate runs end at the edge instead.
    """
    s, w, n, e = box
    runs, cur = [], []
    for pt in geom:
        if s <= pt["lat"] <= n and w <= pt["lon"] <= e:
            cur.append(to_world(pt["lat"], pt["lon"]))
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def build_roads(elements):
    """
    Named streets are kept across the whole frame; paths and service drives are
    kept only inside the academic core, where they read as the Quad walks. Left
    unfiltered, OSM's residential driveways triple the payload for no gain.
    """
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        hw = tags.get("highway")
        if not geom or len(geom) < 2 or hw not in ROAD_WIDTH:
            continue
        minor = hw in ("service", "footway", "path")
        box = CORE_BBOX if minor else BBOX
        for pts in clip_runs(geom, box):
            # Skip stubs — driveway fragments add vertices but no legibility.
            span = math.dist(pts[0], pts[-1]) * METERS_PER_UNIT
            if minor and span < 30:
                continue
            pts = simplify(pts, 2.0 / METERS_PER_UNIT)
            if len(pts) < 2:
                continue
            out.append({
                "w": round(ROAD_WIDTH[hw] / METERS_PER_UNIT, 3),
                "m": 1 if hw in ("primary", "secondary", "tertiary") else 0,
                "f": 1 if hw in ("footway", "path") else 0,
                "p": pts,
            })
    return out


def build_lawns(elements):
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        kind = tags.get("leisure") or tags.get("landuse")
        green = ("park", "garden", "grass", "pitch", "recreation_ground", "stadium")
        if not geom or len(geom) < 4 or kind not in green:
            continue
        lat, lng = centroid(geom)
        if not in_bbox(lat, lng):
            continue
        ring = [to_world(p["lat"], p["lon"]) for p in geom]
        if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
            ring = ring[:-1]
        ring = simplify(ring, 2.5 / METERS_PER_UNIT)
        if len(ring) < 3 or ring_area_m2(ring) < 400:
            continue
        out.append({
            "k": "field" if kind in ("pitch", "stadium") else "lawn",
            "n": tags.get("name"),
            "p": ensure_ccw(ring),
        })
    return out


def stadium_footprints(elements):
    """
    Memorial Stadium is tagged leisure=stadium, not building=*, so it never
    appears in the buildings extract. Pull those rings in as monument
    candidates with the same shape as a building record.
    """
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        if not geom or len(geom) < 4:
            continue
        if tags.get("leisure") != "stadium" or not tags.get("name"):
            continue
        lat, lng = centroid(geom)
        if not in_bbox(lat, lng):
            continue
        ring = [to_world(p["lat"], p["lon"]) for p in geom]
        if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
            ring = ring[:-1]
        ring = simplify(ring, 3.0 / METERS_PER_UNIT)
        if len(ring) < 3:
            continue
        out.append({
            "n": tags["name"], "t": "stadium",
            "h": round(32.0 / METERS_PER_UNIT, 3),
            "p": ensure_ccw(ring),
            "_lat": lat, "_lng": lng, "_area": ring_area_m2(ring),
        })
    return out


def point_in_ring(x: float, z: float, ring: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon on a world-unit ring."""
    inside = False
    n = len(ring)
    for i in range(n):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % n]
        if (z0 > z) != (z1 > z):
            xi = x0 + (z - z0) * (x1 - x0) / (z1 - z0)
            if x < xi:
                inside = not inside
    return inside


def walk(pts: list[tuple[float, float]], step: float):
    """Yield (x, z, tx, tz) every `step` world units along a polyline."""
    carry = 0.0
    for i in range(len(pts) - 1):
        (x0, z0), (x1, z1) = pts[i], pts[i + 1]
        seg = math.hypot(x1 - x0, z1 - z0)
        if seg < 1e-6:
            continue
        tx, tz = (x1 - x0) / seg, (z1 - z0) / seg
        d = carry
        while d <= seg:
            yield x0 + tx * d, z0 + tz * d, tx, tz
            d += step
        carry = d - seg


def hash01(a: float, b: float) -> float:
    """Deterministic jitter so the campus looks the same on every build."""
    h = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - math.floor(h)


def build_greenery(roads, lawns, buildings):
    """
    Trees and street lamps, placed from the data rather than by hand.

    Elm rows come from the footways: every walk that crosses a lawn gets a tree
    on each side at a fixed spacing, which reproduces the double rows lining the
    Main Quad and the Bardeen Quad. Open lawn gets a jittered scatter. Lamps sit
    on the walks themselves, every 40 m, inside the academic core only.
    """
    walks = [r["p"] for r in roads if r["f"]]
    lawn_rings = [l["p"] for l in lawns if l["k"] == "lawn"]
    footprints = [b["p"] for b in buildings]

    def on_lawn(x, z):
        return any(point_in_ring(x, z, ring) for ring in lawn_rings)

    def on_building(x, z):
        return any(point_in_ring(x, z, ring) for ring in footprints)

    trees: list[tuple[float, float, float]] = []
    tree_spacing = 11.0 / METERS_PER_UNIT
    offset = 3.2 / METERS_PER_UNIT
    for pts in walks:
        for x, z, tx, tz in walk(pts, tree_spacing):
            nx, nz = -tz, tx
            for side in (1, -1):
                px, pz = x + nx * offset * side, z + nz * offset * side
                if on_lawn(px, pz) and not on_building(px, pz):
                    trees.append((px, pz, 0.85 + hash01(px, pz) * 0.45))

    # Interior scatter, thinned so it does not swamp the rows.
    scatter_step = 26.0 / METERS_PER_UNIT
    for ring in lawn_rings:
        xs = [q[0] for q in ring]
        zs = [q[1] for q in ring]
        x = min(xs)
        while x <= max(xs):
            z = min(zs)
            while z <= max(zs):
                jx = x + (hash01(x, z) - 0.5) * scatter_step * 0.8
                jz = z + (hash01(z, x) - 0.5) * scatter_step * 0.8
                if point_in_ring(jx, jz, ring) and hash01(jx * 3.1, jz * 1.7) > 0.45:
                    if not any(math.hypot(jx - t[0], jz - t[1]) < 0.7 for t in trees[-60:]):
                        trees.append((jx, jz, 0.9 + hash01(jz, jx) * 0.6))
                z += scatter_step
            x += scatter_step

    lamps: list[tuple[float, float]] = []
    lamp_spacing = 60.0 / METERS_PER_UNIT
    s_, w_, n_, e_ = CORE_BBOX
    for pts in walks:
        for x, z, _tx, _tz in walk(pts, lamp_spacing):
            lat = ORIGIN_LAT - z * METERS_PER_UNIT / M_PER_DEG_LAT
            lng = ORIGIN_LNG + x * METERS_PER_UNIT / M_PER_DEG_LNG
            if s_ <= lat <= n_ and w_ <= lng <= e_:
                lamps.append((x, z))

    # Hard caps keep the static batch bounded whatever the extract contains.
    return trees[:1400], lamps[:520]


def build_detail(elements):
    """
    Surveyed detail: real tree nodes, street lamps, water, rail, parking and
    fountains from the detail extract. Trees come straight from OSM node
    positions — 2,300+ surveyed on campus — with a size variant derived from a
    stable hash so the canopy varies without a random seed.
    """
    trees, lamps, fountains, water, rail, parking = [], [], [], [], [], []
    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "node":
            lat, lng = e["lat"], e["lon"]
            if not in_bbox(lat, lng):
                continue
            x, z = to_world(lat, lng)
            if tags.get("natural") == "tree":
                trees.append((x, z, 0.8 + hash01(x, z) * 0.7))
            elif tags.get("highway") == "street_lamp":
                lamps.append((x, z))
            elif tags.get("amenity") == "fountain":
                fountains.append((x, z, 1.0))
            continue

        geom = e.get("geometry")
        if not geom:
            continue
        if tags.get("waterway") in ("stream", "canal"):
            for run in clip_runs(geom, BBOX):
                water.append({"k": "line", "p": simplify(run, 2.0 / METERS_PER_UNIT)})
            continue
        if tags.get("railway") == "rail":
            for run in clip_runs(geom, BBOX):
                rail.append(simplify(run, 3.0 / METERS_PER_UNIT))
            continue
        pts = [to_world(p["lat"], p["lon"]) for p in geom if in_bbox(p["lat"], p["lon"])]
        if len(pts) >= 3:
            ring = pts[:-1] if math.dist(pts[0], pts[-1]) < 1e-6 else pts
            ring = simplify(ring, 2.5 / METERS_PER_UNIT)
            if len(ring) < 3:
                continue
            if tags.get("natural") == "water":
                water.append({"k": "poly", "p": ensure_ccw(ring)})
            elif tags.get("amenity") == "fountain":
                fountains.append((sum(q[0] for q in ring) / len(ring), sum(q[1] for q in ring) / len(ring), 1.6))
            elif tags.get("amenity") == "parking" and ring_area_m2(ring) > 300:
                parking.append(ensure_ccw(ring))
    return trees, lamps, fountains, water, rail, parking


def attach_monuments(buildings, strict: bool = True):
    """Resolve each monument to a real footprint, by name or by proximity."""
    by_name = {}
    for i, b in enumerate(buildings):
        if b["n"]:
            by_name.setdefault(b["n"], i)

    monuments = []
    claimed: set[int] = set()

    for mon in MONUMENTS:
        idx = None

        # A monument declaring its own footprint size is never matched against
        # OSM: Alma Mater is a statue node with no building outline. Matching a
        # synthetic monument by proximity used to let it steal a neighbour's
        # outline (Alma Mater took Altgeld Hall) and silently draw two
        # monuments on one building.
        if not mon.get("synth"):
            if mon.get("match"):
                idx = by_name.get(mon["match"])
                if idx is None:  # tolerate suffixes like "Annex"
                    for name, j in by_name.items():
                        if name.startswith(mon["match"]):
                            idx = j
                            break
            if idx is None and mon.get("at"):
                lat, lng = mon["at"]
                best, best_d = None, 1e9
                for j, b in enumerate(buildings):
                    if b["_area"] < 400 or j in claimed:
                        continue
                    d = math.hypot((b["_lat"] - lat) * M_PER_DEG_LAT,
                                   (b["_lng"] - lng) * M_PER_DEG_LNG)
                    if d < best_d:
                        best, best_d = j, d
                # The monument must sit on its building, not near it: 55 m is
                # about half a Quad building, so a hit is unambiguous.
                if best is not None and best_d < 55.0:
                    idx = best

        if idx is not None and idx in claimed:
            idx = None

        rec = {k: mon.get(k, "") for k in ("id", "short", "name", "kind", "venue", "blurb", "mat")}

        if idx is not None:
            b = buildings[idx]
            rec["poly"] = b["p"]
            rec["h"] = b["h"]
            cx = sum(p[0] for p in b["p"]) / len(b["p"])
            cz = sum(p[1] for p in b["p"]) / len(b["p"])
            rec["c"] = [round(cx, 3), round(cz, 3)]
            rec["src"] = "osm"
            claimed.add(idx)
            b["_monument"] = mon["id"]
        elif mon.get("at"):
            # Synthesised mass at the verified centroid. Dimensions are metres:
            # (width, depth) with an optional height, defaulting to a plinth.
            dims = mon.get("synth") or (24, 24)
            w = dims[0] / METERS_PER_UNIT / 2
            d = dims[1] / METERS_PER_UNIT / 2
            h = (dims[2] if len(dims) > 2 else 12.0) / METERS_PER_UNIT
            x, z = to_world(*mon["at"])
            rec["poly"] = [(x - w, z - d), (x + w, z - d), (x + w, z + d), (x - w, z + d)]
            rec["h"] = round(h, 3)
            rec["c"] = [round(x, 3), round(z, 3)]
            rec["src"] = "synth"
        else:
            print(f"  ! unresolved monument: {mon['id']}", file=sys.stderr)
            continue

        monuments.append(rec)

    # Fail loudly. A monument that silently drops out here produces a model the
    # seed disagrees with: the gym exists in the database but never colours the
    # map, and nothing at runtime reports it.
    if len(monuments) != len(MONUMENTS):
        missing = {m["id"] for m in MONUMENTS} - {m["id"] for m in monuments}
        msg = (f"only {len(monuments)}/{len(MONUMENTS)} monuments resolved; "
               f"missing: {', '.join(sorted(missing))}")
        if strict:
            sys.exit(msg)
        print(f"  ! {msg}", file=sys.stderr)
    return monuments


def q(v: float) -> float:
    return round(v, 2)


def content_hash(doc: dict) -> str:
    """sha256 of the document with the informational meta fields removed."""
    meta = {k: v for k, v in doc["meta"].items() if k not in ("builtAt", "hash")}
    body = {"meta": meta, **{k: v for k, v in doc.items() if k != "meta"}}
    return hashlib.sha256(json.dumps(body, separators=(",", ":")).encode("utf-8")).hexdigest()


def read_manifest() -> dict:
    if not MANIFEST.exists():
        return {}
    with open(MANIFEST) as fh:
        return {e["file"]: e for e in json.load(fh).get("files", [])}


def build(event: dict, strict: bool = True) -> dict:
    extra = load("extra.json")
    # Stadium rings join the building pool so monument resolution sees them.
    buildings = build_buildings(load("buildings.json")) + stadium_footprints(extra)
    roads = build_roads(extra)
    lawns = build_lawns(extra)
    monuments = attach_monuments(buildings, strict=strict)

    # Ambient mass excludes anything promoted to a monument — those are drawn
    # dynamically so they can change faction colour.
    ambient = [b for b in buildings if "_monument" not in b]
    gen_trees, gen_lamps = build_greenery(roads, lawns, buildings)
    detail_path = OSM_DIR / "detail.json"
    if detail_path.exists():
        detail = load("detail.json")
        trees, lamps, fountains, water, rail, parking = build_detail(detail)
        # Surveyed trees win. Generated ones only fill in more than 12 m from
        # any surveyed tree, so unsurveyed lawns still read as planted.
        grid = {}
        for t in trees:
            grid.setdefault((int(t[0] // 2), int(t[1] // 2)), []).append(t)
        for t in gen_trees:
            kx, kz = int(t[0] // 2), int(t[1] // 2)
            near = [u for dx in (-1, 0, 1) for dz in (-1, 0, 1) for u in grid.get((kx + dx, kz + dz), [])]
            if all(math.hypot(t[0] - u[0], t[1] - u[1]) > 1.2 for u in near):
                trees.append(t)
                grid.setdefault((kx, kz), []).append(t)
        lamps = lamps + [l for l in gen_lamps
                         if all(math.hypot(l[0] - m[0], l[1] - m[1]) > 1.5 for m in lamps)]
    else:
        print("  (no design/osm/detail.json — using generated greenery only)", file=sys.stderr)
        trees, lamps, fountains, water, rail, parking = gen_trees, gen_lamps, [], [], [], []
    trees, lamps = trees[:3200], lamps[:360]

    manifest = read_manifest()
    fetched = sorted(e["fetched_at"] for e in manifest.values() if e.get("fetched_at"))
    osm_source = {"name": "OpenStreetMap contributors, via Overpass API", "licence": "ODbL 1.0"}
    if fetched:
        osm_source["fetchedAt"] = fetched[-1]

    doc = {
        "meta": {
            "schema": SCHEMA,
            "pack": event.get("id", ""),
            "origin": [ORIGIN_LAT, ORIGIN_LNG],
            "metersPerUnit": METERS_PER_UNIT,
            "bbox": list(BBOX),
            "source": "OpenStreetMap contributors (ODbL 1.0), via Overpass API",
            "sources": [osm_source],
            "counts": {
                "buildings": len(ambient),
                "monuments": len(monuments),
                "roads": len(roads),
                "lawns": len(lawns),
                "trees": len(trees),
                "lamps": len(lamps),
                "water": len(water),
                "rail": len(rail),
                "parking": len(parking),
                "fountains": len(fountains),
            },
        },
        "buildings": [
            {"n": b["n"], "t": b["t"], "h": b["h"], "r": b.get("r", ""),
             "p": [[q(x), q(z)] for x, z in b["p"]]}
            for b in ambient
        ],
        "monuments": [
            {**mo, "poly": [[q(x), q(z)] for x, z in mo["poly"]]}
            for mo in monuments
        ],
        "roads": [
            {"w": r["w"], "m": r["m"], "f": r["f"],
             "p": [[q(x), q(z)] for x, z in r["p"]]}
            for r in roads
        ],
        "lawns": [
            {"k": l["k"], "n": l["n"], "p": [[q(x), q(z)] for x, z in l["p"]]}
            for l in lawns
        ],
        "trees": [[q(x), q(z), round(sc, 2)] for x, z, sc in trees],
        "lamps": [[q(x), q(z)] for x, z in lamps],
        "fountains": [[q(x), q(z), round(sc, 2)] for x, z, sc in fountains],
        "water": [{"k": w["k"], "p": [[q(x), q(z)] for x, z in w["p"]]} for w in water],
        "rail": [[[q(x), q(z)] for x, z in r] for r in rail],
        "parking": [[[q(x), q(z)] for x, z in r] for r in parking],
    }
    doc["meta"]["hash"] = content_hash(doc)
    doc["meta"]["builtAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return doc


def write(doc: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))


def report(doc: dict, out: Path) -> None:
    size = os.path.getsize(out) / 1024
    try:
        shown = out.relative_to(ROOT)
    except ValueError:
        shown = out
    print(f"wrote {shown}  ({size:.0f} KB)  hash {doc['meta']['hash'][:12]}")
    for k, v in doc["meta"]["counts"].items():
        print(f"  {k:11s} {v}")
    print(f"  {'monument':11s} {'src':5s} {'kind':10s} {'centre (x, z)':18s} footprint (m)")
    for mo in doc["monuments"]:
        xs = [p[0] for p in mo["poly"]]
        zs = [p[1] for p in mo["poly"]]
        span = f"{(max(xs) - min(xs)) * METERS_PER_UNIT:5.0f} x {(max(zs) - min(zs)) * METERS_PER_UNIT:3.0f}"
        print(f"  {mo['short']:11s} {mo['src']:5s} {mo['kind']:10s} "
              f"({mo['c'][0]:7.1f}, {mo['c'][1]:7.1f})   {span}   h {mo['h'] * METERS_PER_UNIT:.0f}")


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch() -> None:
    """Run every design/osm/*.overpass query against Overpass, one request each."""
    queries = sorted(OSM_DIR.glob("*.overpass"))
    if not queries:
        sys.exit(f"no *.overpass queries in {OSM_DIR}")
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    entries = []
    for qpath in queries:
        out = OSM_DIR / (qpath.stem + ".json")
        query = qpath.read_bytes()
        print(f"fetching {qpath.name} -> {out.relative_to(ROOT)} ...", flush=True)
        fd, tmp = tempfile.mkstemp(dir=OSM_DIR, suffix=".part")
        os.close(fd)
        try:
            subprocess.run(
                ["curl", "-sS", "-f", "--retry", "2", "--retry-delay", "20",
                 "-X", "POST", "--data-binary", f"@{qpath}", OVERPASS_URL, "-o", tmp],
                check=True,
            )
            with open(tmp) as fh:
                data = json.load(fh)
            if "elements" not in data:
                raise ValueError(f"no 'elements' in response: {json.dumps(data)[:200]}")
            if data.get("remark"):
                print(f"  overpass remark: {data['remark']}", file=sys.stderr)
            os.replace(tmp, out)
        except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as err:
            if os.path.exists(tmp):
                os.unlink(tmp)
            sys.exit(f"fetch of {qpath.name} failed: {err}")
        entries.append({
            "file": out.name,
            "url": OVERPASS_URL,
            "query": qpath.name,
            "query_sha256": hashlib.sha256(query).hexdigest(),
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "bytes": os.path.getsize(out),
            "sha256": sha256_file(out),
            "elements": len(data["elements"]),
        })
        print(f"  {entries[-1]['bytes'] / 1024:.0f} KB, {entries[-1]['elements']} elements")
    with open(MANIFEST, "w") as fh:
        json.dump({"source": "OpenStreetMap contributors (ODbL 1.0)", "files": entries}, fh, indent=1)
    print(f"wrote {MANIFEST.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", default=str(DEFAULT_PACK),
                    help="content pack directory holding event.json and monuments.json "
                         "(default: content/hackillinois-2027)")
    ap.add_argument("--check", action="store_true",
                    help="rebuild to a temp file and compare meta.hash with the committed campus.json; exit 1 on drift")
    ap.add_argument("--fetch", action="store_true",
                    help="refresh design/osm/*.json from the Overpass API before building")
    ap.add_argument("--core-only", action="store_true",
                    help="preview build restricted to campus.coreBbox; written to <pack>/campus.core.json "
                         "so the shipped model is never overwritten by a preview")
    ap.add_argument("--out", default=None,
                    help="override the output path (default: <pack>/campus.json)")
    args = ap.parse_args(argv)

    pack_dir = Path(args.pack)
    if not pack_dir.is_absolute():
        pack_dir = (Path.cwd() / pack_dir).resolve()
    if not pack_dir.is_dir():
        sys.exit(f"pack directory not found: {pack_dir}")

    if args.fetch:
        fetch()

    event = configure(pack_dir, core_only=args.core_only)
    out = pack_dir / ("campus.core.json" if args.core_only else "campus.json")
    if args.out:
        out = Path(args.out).resolve()
    if args.check and args.core_only:
        sys.exit("--check compares against the shipped campus.json; it cannot be combined with --core-only")
    # A core-only preview legitimately loses monuments outside the core box.
    doc = build(event, strict=not args.core_only)

    if args.check:
        if not out.exists():
            print(f"check: {out} does not exist — run without --check to build it", file=sys.stderr)
            return 1
        with open(out) as fh:
            committed = json.load(fh)
        fd, tmp = tempfile.mkstemp(suffix=".campus.json")
        os.close(fd)
        try:
            write(doc, Path(tmp))
            report(doc, Path(tmp))
        finally:
            os.unlink(tmp)
        want = committed.get("meta", {}).get("hash")
        have = doc["meta"]["hash"]
        recomputed = content_hash(committed)
        if want != recomputed:
            print(f"check: FAIL — committed meta.hash {str(want)[:12]} does not match its own content "
                  f"({recomputed[:12]}); the file was edited by hand", file=sys.stderr)
            return 1
        if want != have:
            print(f"check: FAIL — committed {want[:12]} != rebuilt {have[:12]}; "
                  f"rebuild with: python3 design/build-campus.py --pack {args.pack}", file=sys.stderr)
            return 1
        print(f"check: OK — {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out} matches ({have[:12]})")
        return 0

    write(doc, out)
    report(doc, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
