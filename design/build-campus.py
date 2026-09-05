#!/usr/bin/env python3
"""
Bake OpenStreetMap extracts of the UIUC campus into the compact model the
WebGL renderer loads at runtime (public/gl/uiuc-campus.json).

Source data is fetched once from the Overpass API (see FETCH below) and cached
under design/osm/. Re-run this only when the cache is refreshed; the committed
JSON is what ships.

Everything is projected to a local metric frame centred on the Main Quad, so
the renderer never touches spherical maths.

    python3 design/build-campus.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OSM_DIR = HERE / "osm"
OUT = HERE.parent / "public" / "gl" / "uiuc-campus.json"

FETCH = """Refresh the cache with:

  mkdir -p design/osm
  curl -s -X POST --data-binary @design/osm/buildings.overpass \\
       https://overpass-api.de/api/interpreter -o design/osm/buildings.json
  curl -s -X POST --data-binary @design/osm/extra.overpass \\
       https://overpass-api.de/api/interpreter -o design/osm/extra.json
"""

# --- Frame -----------------------------------------------------------------
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
# `match` claims the OSM way with that name. `at` is a verified centroid used
# when the building carries no name; the nearest unclaimed footprint within
# 55 m wins. `synth` opts out of matching entirely and masses the monument from
# its centroid — for the statue, and for the two buildings OSM does not map.
MONUMENTS = [
    dict(id="alma-mater",   short="ALMA",       name="Alma Mater", mat="bronze",
         at=(40.10992, -88.22840), kind="statue", venue="Alma Mater",
         synth=(20, 20, 0.5), blurb="Green & Wright. The statue every Illini graduates under."),
    dict(id="illini-union", short="UNION",      name="Illini Union", mat="brick",
         match="Illini Union", kind="hall", venue="Illini Union",
         blurb="North head of the Main Quad. Registration and welcome desk."),
    dict(id="foellinger",   short="FOELLINGER", name="Foellinger Auditorium", mat="limestone",
         match="Foellinger Auditorium", kind="dome", venue="Foellinger",
         blurb="The domed rotunda closing the south end of the Quad."),
    dict(id="altgeld",      short="ALTGELD",    name="Altgeld Hall", mat="sandstone",
         match="Altgeld Hall", kind="belltower", venue="Altgeld",
         blurb="Romanesque hall and chime tower on the west walk."),
    dict(id="siebel",       short="SIEBEL",     name="Siebel Center for CS", mat="brick",
         match="Siebel Center for Computer Science", kind="tower", venue="Siebel",
         blurb="Engineering campus HQ. Atrium check-in and hardware bench."),
    # ECEB and the Main Library carry no building=* way in the OSM extract, so
    # both are massed from their verified centroid instead of a real outline.
    dict(id="eceb",         short="ECEB",       name="ECE Building", mat="glass",
         at=(40.11493, -88.22806), kind="tower", venue="ECEB",
         synth=(104, 46, 38), blurb="Net-zero glass hall. Second-floor labs and balcony."),
    dict(id="grainger",     short="GRAINGER",   name="Grainger Library", mat="brick",
         match="Grainger Engineering Library", kind="tower", venue="Grainger",
         blurb="Engineering library. The 24-hour reading room."),
    dict(id="dcl",          short="DCL",        name="Digital Computer Lab", mat="brick",
         match="Digital Computer Laboratory", kind="tower", venue="DCL",
         blurb="Loading dock and overnight supply runs."),
    dict(id="kenney",       short="KENNEY",     name="Kenney Gym", mat="brick",
         match="Kenney Gymnasium", kind="hall", venue="Kenney",
         blurb="Main floor and bleachers. The largest hacking hall."),
    dict(id="stadium",      short="STADIUM",    name="Memorial Stadium", mat="limestone",
         match="Gies Memorial Stadium", kind="bowl", venue="Memorial Stadium",
         blurb="South-west anchor. Shuttle staging and overflow parking."),
    dict(id="state-farm",   short="ASSEMBLY",   name="State Farm Center", mat="concrete",
         match="State Farm Center", kind="dome", venue="State Farm Center",
         blurb="The folded-edge dome. Closing ceremony venue."),
    dict(id="main-library", short="LIBRARY",    name="Main Library", mat="brick",
         at=(40.10455, -88.22885), kind="hall", venue="Main Library",
         synth=(112, 74, 28), blurb="Stacks and study halls south of the Quad."),
    dict(id="beckman",      short="BECKMAN",    name="Beckman Institute", mat="glass",
         match="Beckman Institute", kind="tower", venue="Beckman",
         blurb="North campus research block."),
    dict(id="krannert",     short="KRANNERT",   name="Krannert Center", mat="concrete",
         match="Krannert Center for the Performing Arts", kind="hall",
         venue="Krannert", blurb="Performing arts terraces on the east flank."),
]


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


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def load(name: str):
    path = OSM_DIR / name
    if not path.exists():
        sys.exit(f"missing {path}\n\n{FETCH}")
    with open(path) as fh:
        return json.load(fh)["elements"]


def build_buildings(elements):
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        if not geom or len(geom) < 4 or "building" not in tags:
            continue
        lat, lng = centroid(geom)
        if not in_bbox(lat, lng):
            continue

        # OSM closes rings by repeating the first node; drop the duplicate.
        ring = [to_world(p["lat"], p["lon"]) for p in geom]
        if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
            ring = ring[:-1]
        if len(ring) < 3:
            continue

        ring = simplify(ring, SIMPLIFY_TOLERANCE_M / METERS_PER_UNIT)
        if len(ring) < 3:
            continue
        area = ring_area_m2(ring)
        if area < MIN_FOOTPRINT_M2:
            continue

        btype = tags.get("building", "yes")
        height = parse_height(tags) or DEFAULT_HEIGHT.get(btype, 9.0)
        # Nudge large unlevelled footprints taller so big halls do not read flat.
        if not parse_height(tags) and area > 3000:
            height = max(height, 16.0)

        out.append({
            "n": tags.get("name"),
            "t": btype,
            "h": round(height / METERS_PER_UNIT, 3),
            "r": {"gabled": "g", "hipped": "h"}.get(tags.get("roof:shape"), ""),
            "p": ensure_ccw(ring),
            "_lat": lat, "_lng": lng, "_area": area,
        })
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


def roof_shapes(elements):
    """building:id -> roof:shape for the few OSM ways that carry one."""
    out = {}
    for e in elements:
        shape = e.get("tags", {}).get("roof:shape")
        if shape in ("gabled", "hipped") and e.get("geometry"):
            lat, lng = centroid(e["geometry"])
            out[(round(lat, 5), round(lng, 5))] = shape
    return out


def attach_monuments(buildings):
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
        # OSM: Alma Mater is a statue node, and ECEB and the Main Library have
        # no building way in the extract. Matching them by proximity used to
        # let them steal a neighbour's outline (Alma Mater took Altgeld Hall,
        # ECEB took Beckman) and silently draw two monuments on one building.
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

        rec = {k: mon[k] for k in ("id", "short", "name", "kind", "venue", "blurb", "mat")}

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
        sys.exit(f"only {len(monuments)}/{len(MONUMENTS)} monuments resolved; "
                 f"missing: {', '.join(sorted(missing))}")
    return monuments


def q(v: float) -> float:
    return round(v, 2)


def main() -> None:
    extra = load("extra.json")
    # Stadium rings join the building pool so monument resolution sees them.
    buildings = build_buildings(load("buildings.json")) + stadium_footprints(extra)
    roads = build_roads(extra)
    lawns = build_lawns(extra)
    monuments = attach_monuments(buildings)

    # Ambient mass excludes anything promoted to a monument — those are drawn
    # dynamically so they can change faction colour.
    ambient = [b for b in buildings if "_monument" not in b]
    gen_trees, gen_lamps = build_greenery(roads, lawns, buildings)
    detail_path = OSM_DIR / "detail.json"
    if detail_path.exists():
        with open(detail_path) as fh:
            detail = json.load(fh)["elements"]
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

    doc = {
        "meta": {
            "origin": [ORIGIN_LAT, ORIGIN_LNG],
            "metersPerUnit": METERS_PER_UNIT,
            "bbox": BBOX,
            "source": "OpenStreetMap contributors (ODbL 1.0), via Overpass API",
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

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))

    size = os.path.getsize(OUT) / 1024
    print(f"wrote {OUT.relative_to(HERE.parent)}  ({size:.0f} KB)")
    for k, v in doc["meta"]["counts"].items():
        print(f"  {k:11s} {v}")
    for mo in doc["monuments"]:
        print(f"  {mo['short']:11s} {mo['src']:5s} {mo['kind']:10s} "
              f"({mo['c'][0]:7.1f}, {mo['c'][1]:7.1f})")


if __name__ == "__main__":
    main()
