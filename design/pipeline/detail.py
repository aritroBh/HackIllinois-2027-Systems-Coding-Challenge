"""Roads, lawns, greenery, lamps, water, rail, parking and fountains."""
from __future__ import annotations

import math

from .config import ROAD_WIDTH, Frame
from .geom import centroid_latlng, clip_runs, close_ring_from_geom, ensure_ccw, hash01, point_in_ring, ring_area_m2, simplify, walk


def build_roads(frame: Frame, elements):
    out = []
    mpu = frame.meters_per_unit
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        hw = tags.get("highway")
        if e.get("type") != "way" or not geom or len(geom) < 2 or hw not in ROAD_WIDTH:
            continue
        minor = hw in ("service", "footway", "path")
        box = frame.detail_bbox if minor else frame.bbox
        for pts in clip_runs(frame, geom, box):
            span = math.dist(pts[0], pts[-1]) * mpu
            if minor and span < 30:
                continue
            pts = simplify(pts, 2.0 / mpu)
            if len(pts) < 2:
                continue
            out.append({
                "id": f"w{e['id']}",
                "w": round(ROAD_WIDTH[hw] / mpu, 3),
                "m": 1 if hw in ("primary", "secondary", "tertiary") else 0,
                "f": 1 if hw in ("footway", "path") else 0,
                "p": pts,
            })
    return out


GREEN = ("park", "garden", "grass", "pitch", "recreation_ground", "stadium", "forest", "wood", "meadow", "farmland", "grassland", "cemetery", "track", "scrub")


def build_lawns(frame: Frame, elements):
    out = []
    for e in elements:
        geom = e.get("geometry")
        tags = e.get("tags", {})
        kind = tags.get("leisure") or tags.get("landuse") or tags.get("natural")
        if e.get("type") != "way" or not geom or len(geom) < 4 or kind not in GREEN:
            continue
        lat, lng = centroid_latlng(geom)
        if not frame.in_bbox(lat, lng):
            continue
        ring = close_ring_from_geom(frame, geom)
        ring = simplify(ring, 2.5 / frame.meters_per_unit)
        if len(ring) < 3 or ring_area_m2(ring, frame.meters_per_unit) < 400:
            continue
        k = "field" if kind in ("pitch", "stadium", "track") else "wood" if kind in ("forest", "wood", "scrub") else "farm" if kind in ("farmland", "meadow") else "lawn"
        out.append({"id": f"w{e['id']}", "k": k, "n": tags.get("name"), "p": ensure_ccw(ring)})
    return out


def build_greenery(frame: Frame, roads, lawns, buildings):
    mpu = frame.meters_per_unit
    walks = [r["p"] for r in roads if r["f"]]
    lawn_rings = [l["p"] for l in lawns if l["k"] == "lawn"]
    footprints = [b["p"] for b in buildings]

    # Grid-bucketed lookups: the whole campus has thousands of rings.
    cell = 10.0
    lawn_grid: dict[tuple[int, int], list] = {}
    bld_grid: dict[tuple[int, int], list] = {}
    for rings, grid in ((lawn_rings, lawn_grid), (footprints, bld_grid)):
        for ring in rings:
            xs = [p[0] for p in ring]
            zs = [p[1] for p in ring]
            for gx in range(int(min(xs) // cell), int(max(xs) // cell) + 1):
                for gz in range(int(min(zs) // cell), int(max(zs) // cell) + 1):
                    grid.setdefault((gx, gz), []).append(ring)

    def hit(grid, x, z):
        return any(point_in_ring(x, z, r) for r in grid.get((int(x // cell), int(z // cell)), []))

    trees = []
    tree_spacing = 11.0 / mpu
    offset = 3.2 / mpu
    for pts in walks:
        for x, z, tx, tz in walk(pts, tree_spacing):
            nx, nz = -tz, tx
            for side in (1, -1):
                px, pz = x + nx * offset * side, z + nz * offset * side
                if hit(lawn_grid, px, pz) and not hit(bld_grid, px, pz):
                    trees.append((px, pz, 0.85 + hash01(px, pz) * 0.45))

    scatter_step = 26.0 / mpu
    for ring in lawn_rings:
        xs = [q[0] for q in ring]
        zs = [q[1] for q in ring]
        x = min(xs)
        recent = []
        while x <= max(xs):
            z = min(zs)
            while z <= max(zs):
                jx = x + (hash01(x, z) - 0.5) * scatter_step * 0.8
                jz = z + (hash01(z, x) - 0.5) * scatter_step * 0.8
                if point_in_ring(jx, jz, ring) and hash01(jx * 3.1, jz * 1.7) > 0.45:
                    if not any(math.hypot(jx - t[0], jz - t[1]) < 0.7 for t in recent[-60:]):
                        trees.append((jx, jz, 0.9 + hash01(jz, jx) * 0.6))
                        recent.append(trees[-1])
                z += scatter_step
            x += scatter_step

    lamps = []
    lamp_spacing = 60.0 / mpu
    for pts in walks:
        for x, z, _tx, _tz in walk(pts, lamp_spacing):
            lat, lng = frame.to_latlng(x, z)
            if frame.in_bbox(lat, lng, frame.detail_bbox):
                lamps.append((x, z))
    return trees, lamps


def build_detail(frame: Frame, elements):
    mpu = frame.meters_per_unit
    trees, lamps, fountains, water, rail, parking = [], [], [], [], [], []
    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "node":
            lat, lng = e["lat"], e["lon"]
            if not frame.in_bbox(lat, lng):
                continue
            x, z = frame.to_world(lat, lng)
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
        if tags.get("waterway") in ("stream", "canal", "river", "ditch", "drain"):
            for run in clip_runs(frame, geom, frame.bbox):
                water.append({"k": "line", "p": simplify(run, 2.0 / mpu)})
            continue
        if tags.get("railway") == "rail":
            for run in clip_runs(frame, geom, frame.bbox):
                rail.append(simplify(run, 3.0 / mpu))
            continue
        pts = [frame.to_world(p["lat"], p["lon"]) for p in geom if frame.in_bbox(p["lat"], p["lon"])]
        if len(pts) >= 3:
            ring = pts[:-1] if math.dist(pts[0], pts[-1]) < 1e-6 else pts
            ring = simplify(ring, 2.5 / mpu)
            if len(ring) < 3:
                continue
            if tags.get("natural") == "water":
                water.append({"k": "poly", "p": ensure_ccw(ring)})
            elif tags.get("amenity") == "fountain":
                fountains.append((sum(q[0] for q in ring) / len(ring), sum(q[1] for q in ring) / len(ring), 1.6))
            elif tags.get("amenity") == "parking" and ring_area_m2(ring, mpu) > 300:
                parking.append(ensure_ccw(ring))
    return trees, lamps, fountains, water, rail, parking


def merge_trees(surveyed, generated):
    """Surveyed trees win; generated ones fill in more than 12 m from any surveyed tree."""
    grid = {}
    trees = list(surveyed)
    for t in trees:
        grid.setdefault((int(t[0] // 2), int(t[1] // 2)), []).append(t)
    for t in generated:
        kx, kz = int(t[0] // 2), int(t[1] // 2)
        near = [u for dx in (-1, 0, 1) for dz in (-1, 0, 1) for u in grid.get((kx + dx, kz + dz), [])]
        if all(math.hypot(t[0] - u[0], t[1] - u[1]) > 1.2 for u in near):
            trees.append(t)
            grid.setdefault((kx, kz), []).append(t)
    return trees
