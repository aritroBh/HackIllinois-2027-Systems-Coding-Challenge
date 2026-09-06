"""
Footprints: ways tagged building=*, multipolygon relations (outer rings assembled, inner
rings kept as holes), building:part ways attached to their containing footprint, stadium
rings, and an IoU dedupe so overlapping sources never yield two masses on one lot.
"""
from __future__ import annotations

import math

from .config import MIN_FOOTPRINT_M2, SIMPLIFY_TOLERANCE_M, Frame
from .geom import assemble_rings, centroid_latlng, close_ring_from_geom, ensure_ccw, ensure_cw, ring_area_m2, simplify


def _ring(frame: Frame, geom: list[dict], tol_m: float):
    ring = close_ring_from_geom(frame, geom)
    if len(ring) < 3:
        return None
    ring = simplify(ring, tol_m / frame.meters_per_unit)
    return ring if len(ring) >= 3 else None


def footprint(frame: Frame, geom: list[dict], tags: dict, osm_id: str, holes_geom=()) -> dict | None:
    """One OSM ring into a pack record, or None when it is not worth a mass.

    Two size floors, both about byte cost rather than accuracy: below
    MIN_FOOTPRINT_M2 a building is a bin store or a transformer hut that reads
    as noise at 10 m per unit, and a courtyard under 40 m2 is a light well that
    the extrusion's own wall thickness would swallow anyway.
    """
    if len(geom) < 4:
        return None
    lat, lng = centroid_latlng(geom)
    if not frame.in_bbox(lat, lng):
        return None
    ring = _ring(frame, geom, SIMPLIFY_TOLERANCE_M)
    if not ring:
        return None
    area = ring_area_m2(ring, frame.meters_per_unit)
    if area < MIN_FOOTPRINT_M2:
        return None
    holes = []
    for hg in holes_geom:
        hr = _ring(frame, hg, SIMPLIFY_TOLERANCE_M)
        if hr and ring_area_m2(hr, frame.meters_per_unit) >= 40:
            holes.append(ensure_cw(hr))
    return {
        "id": osm_id,
        "n": tags.get("name"),
        "t": tags.get("building", "yes"),
        "p": ensure_ccw(ring),
        "holes": holes,
        "_tags": tags,
        "_lat": lat, "_lng": lng, "_area": area,
    }


def build_buildings(frame: Frame, elements: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return (buildings, parts). Parts are building:part ways not yet attached."""
    relations = [e for e in elements
                 if e.get("type") == "relation" and "building" in e.get("tags", {})
                 and e.get("tags", {}).get("type", "multipolygon") == "multipolygon"]
    # A relation's member ways are also returned as standalone ways by `(._;>;)`,
    # and some carry building tags of their own. Taking both would put a second
    # mass on top of the relation's, so the relation wins and its members are
    # skipped in the way pass below.
    member_ways: set[int] = set()
    for r in relations:
        for m in r.get("members", []):
            if m.get("type") == "way":
                member_ways.add(m.get("ref"))

    out, parts = [], []
    for e in elements:
        if e.get("type") != "way" or e.get("id") in member_ways:
            continue
        geom = e.get("geometry")
        tags = e.get("tags", {})
        if not geom:
            continue
        if "building:part" in tags and "building" not in tags:
            rec = footprint(frame, geom, tags, f"w{e['id']}")
            if rec:
                parts.append(rec)
            continue
        if "building" in tags:
            rec = footprint(frame, geom, tags, f"w{e['id']}")
            if rec:
                out.append(rec)
    for r in relations:
        outers = [m["geometry"] for m in r.get("members", [])
                  if m.get("type") == "way" and m.get("role", "outer") == "outer" and m.get("geometry")]
        inners = [m["geometry"] for m in r.get("members", [])
                  if m.get("type") == "way" and m.get("role") == "inner" and m.get("geometry")]
        inner_rings = assemble_rings(inners)
        recs = []
        for i, ring in enumerate(assemble_rings(outers)):
            rec = footprint(frame, ring, r.get("tags", {}), f"r{r['id']}" + (f".{i}" if i else ""), holes_geom=inner_rings)
            if rec:
                recs.append(rec)
        recs.sort(key=lambda x: -x["_area"])
        out.extend(recs)
    return out, parts


def stadium_footprints(frame: Frame, elements: list[dict]) -> list[dict]:
    """leisure=stadium rings, which OSM does not tag building=*.

    Memorial Stadium and the State Farm Center are the campus silhouette and
    both would be missing without this. The 32 m is a hand height: neither ring
    carries a height tag, and lidar reads the seating bowl rather than the roof.
    """
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        if e.get("type") != "way" or not geom or len(geom) < 4:
            continue
        if tags.get("leisure") != "stadium" or not tags.get("name"):
            continue
        lat, lng = centroid_latlng(geom)
        if not frame.in_bbox(lat, lng):
            continue
        ring = _ring(frame, geom, 3.0)
        if not ring:
            continue
        out.append({
            "id": f"w{e['id']}", "n": tags["name"], "t": "stadium", "p": ensure_ccw(ring), "holes": [],
            "_tags": {**tags, "height": "32"}, "_lat": lat, "_lng": lng, "_area": ring_area_m2(ring, frame.meters_per_unit),
        })
    return out


def attach_parts(buildings: list[dict], parts: list[dict], frame: Frame) -> list[dict]:
    """Attach each building:part to the footprint containing its centroid; orphans become buildings."""
    if not parts:
        return buildings
    from shapely.geometry import Point, Polygon
    from shapely.strtree import STRtree
    polys = [Polygon(b["p"]) for b in buildings]
    tree = STRtree(polys)
    orphans = []
    for part in parts:
        cx = sum(p[0] for p in part["p"]) / len(part["p"])
        cz = sum(p[1] for p in part["p"]) / len(part["p"])
        hit = None
        for idx in tree.query(Point(cx, cz)):
            if polys[idx].contains(Point(cx, cz)):
                hit = idx
                break
        if hit is None:
            orphans.append(part)
            continue
        buildings[hit].setdefault("_parts", []).append(part)
    return buildings + orphans


def dedupe(buildings: list[dict], frame: Frame, iou: float = 0.5) -> list[dict]:
    """Drop the smaller of any pair overlapping by more than `iou` (multi-source safety)."""
    if len(buildings) < 2:
        return buildings
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    polys = []
    for b in buildings:
        p = Polygon(b["p"])
        polys.append(p if p.is_valid else p.buffer(0))
    tree = STRtree(polys)
    drop: set[int] = set()
    order = sorted(range(len(buildings)), key=lambda i: -buildings[i]["_area"])
    for i in order:
        if i in drop:
            continue
        for j in tree.query(polys[i]):
            if j == i or j in drop or buildings[j]["_area"] > buildings[i]["_area"]:
                continue
            try:
                inter = polys[i].intersection(polys[j]).area
            except Exception:
                continue
            if inter <= 0:
                continue
            union = polys[i].area + polys[j].area - inter
            if union > 0 and inter / union > iou:
                # The survivor inherits a name it lacks: OSM often carries the name on the
                # leisure=stadium ring and the mass on the building=* ring.
                if not buildings[i]["n"] and buildings[j]["n"]:
                    buildings[i]["n"] = buildings[j]["n"]
                if buildings[j]["t"] == "stadium":
                    buildings[i]["t"] = "stadium"
                    buildings[i]["_tags"] = {**buildings[i]["_tags"], "height": buildings[i]["_tags"].get("height", "32")}
                drop.add(j)
    return [b for k, b in enumerate(buildings) if k not in drop]


def neighbour_ao(buildings: list[dict], frame: Frame) -> None:
    """Baked ambient occlusion: how hemmed-in each footprint is by walls within 8 m (0..1).

    The renderer has no shadow pass, so a dense block of Campustown reads as
    bright as an isolated hall on the Quad. This is the cheap stand-in: one
    scalar per building that tile-bake.js multiplies into the wall colour.

    Four close neighbours saturate it. Beyond that the darkening stops meaning
    anything, and a courtyard surrounded on all sides would otherwise go black.
    """
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    polys = [Polygon(b["p"]) for b in buildings]
    tree = STRtree(polys)
    reach = 8.0 / frame.meters_per_unit
    for i, b in enumerate(buildings):
        ring = polys[i].buffer(reach)
        near = 0.0
        for j in tree.query(ring):
            if j == i:
                continue
            d = polys[i].distance(polys[j])
            if d < reach:
                near += 1.0 - d / reach
        b["ao"] = round(min(1.0, near / 4.0), 2)
