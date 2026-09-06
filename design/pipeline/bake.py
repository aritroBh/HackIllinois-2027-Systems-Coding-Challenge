"""
Assemble the model and write it two ways:

  <pack>/campus.json            schema 1 + the v2 per-building keys, restricted to the core
                                bbox — the legacy single-batch bake older clients and the
                                content loader's monument cross-check read
  <pack>/campus/index.json      schema 2: frame, sources, monuments (with crown recipes), and
                                the tile table {x, z, bbox, maxH, counts, bytes, sha256, file, core}
  <pack>/campus/tiles/<x>_<z>.<sha8>.json
                                500 m tiles: buildings by centroid (never clipped), roads and
                                rail clipped to runs, lawns/parking/water rings clipped
                                (Sutherland–Hodgman), trees/lamps/fountains by point

Everything is deterministic: inputs sorted by OSM id, floats rounded, tile files
content-addressed, `meta.hash` = sha256 over the tile hashes and the frame.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import detail as D
from . import fetch as F
from . import footprints as FP
from .config import SCHEMA, TILE_UNITS, Pack
from .facade import facade_for
from .geom import clip_polyline_box, clip_ring_box
from .heights import resolve as resolve_height
from .lidar import Lidar
from .monuments import attach_monuments
from .roofs import ridge_for, roof_for


def q(v: float) -> float:
    return round(v, 2)


def qr(ring):
    return [[q(x), q(z)] for x, z in ring]


def _building_record(frame, b: dict, lidar: Lidar | None) -> dict:
    tags = b["_tags"]
    lidar_h, lidar_ratio = None, None
    if lidar is not None:
        s = lidar.sample(b["p"])
        if s:
            lidar_h, lidar_ratio = s
    h_m, hsrc, lv = resolve_height(tags, b["t"], b["_area"], lidar_h)
    r = roof_for(tags, b["t"], h_m, b["_area"], lidar_ratio)
    m, c = facade_for(tags, b["t"], h_m, b["n"])
    rec = {
        "id": b["id"], "n": b["n"], "t": b["t"],
        "h": round(h_m / frame.meters_per_unit, 3), "hsrc": hsrc, "lv": lv,
        "r": r, "m": m, "ao": b.get("ao", 0.0),
        "par": 1 if (r == "f" and h_m >= 8.0) else 0,
        "p": qr(b["p"]),
    }
    if c:
        rec["c"] = c
    if r in ("g", "h", "m"):
        rr = ridge_for(b["p"])
        if rr:
            rec["rr"] = rr
    if b.get("holes"):
        rec["holes"] = [qr(hr) for hr in b["holes"]]
    if lidar_ratio is not None:
        rec["ps"] = round(lidar_ratio, 3)
    parts = []
    for part in b.get("_parts", []):
        ph, _, _ = resolve_height(part["_tags"], part["t"], part["_area"], None)
        pmin = part["_tags"].get("min_height")
        try:
            pmin = float(str(pmin).replace("m", "")) if pmin else 0.0
        except ValueError:
            pmin = 0.0
        parts.append({"p": qr(part["p"]), "h": round(ph / frame.meters_per_unit, 3), "min": round(pmin / frame.meters_per_unit, 3)})
    if parts:
        rec["parts"] = parts
    b["h"] = rec["h"]
    b["hsrc"] = hsrc
    b["parts"] = parts
    return rec


def assemble(pack: Pack, strict: bool = True, legacy_cache: bool = False, use_lidar: bool = True) -> dict:
    frame = pack.frame
    load = (lambda n: F.load_legacy(n)) if legacy_cache else F.load
    b_elements = load("buildings")
    extra = load("extra")
    buildings, parts = FP.build_buildings(frame, b_elements)
    buildings += FP.stadium_footprints(frame, b_elements) + FP.stadium_footprints(frame, extra)
    buildings = FP.attach_parts(buildings, parts, frame)
    buildings = FP.dedupe(buildings, frame)
    buildings.sort(key=lambda b: b["id"])
    FP.neighbour_ao(buildings, frame)

    lidar = Lidar.load(frame.meters_per_unit, enabled=use_lidar)
    records = [_building_record(frame, b, lidar) for b in buildings]
    monuments = attach_monuments(frame, buildings, pack.monuments, pack.crowns, strict=strict)
    monument_ids = {b["id"] for b in buildings if "_monument" in b}
    ambient = [rec for rec in records if rec["id"] not in monument_ids]

    roads = D.build_roads(frame, extra)
    lawns = D.build_lawns(frame, extra)
    gen_trees, gen_lamps = D.build_greenery(frame, roads, lawns, buildings)
    try:
        det = load("detail")
    except SystemExit:
        det = None
    if det is not None:
        trees, lamps, fountains, water, rail, parking = D.build_detail(frame, det)
        trees = D.merge_trees(trees, gen_trees)
        lamps = lamps + [l for l in gen_lamps if all(math.hypot(l[0] - m[0], l[1] - m[1]) > 1.5 for m in lamps)]
    else:
        print("  (no detail extract — using generated greenery only)", file=sys.stderr)
        trees, lamps, fountains, water, rail, parking = gen_trees, gen_lamps, [], [], [], []

    hsrc_counts: dict[str, int] = {}
    for rec in records:
        hsrc_counts[rec["hsrc"]] = hsrc_counts.get(rec["hsrc"], 0) + 1

    return {
        "frame": frame,
        "event": pack.event,
        "buildings": ambient,
        "monuments": [{**mo, "poly": qr(mo["poly"])} for mo in monuments],
        "roads": [{"id": r["id"], "w": r["w"], "m": r["m"], "f": r["f"], "p": qr(r["p"])} for r in roads],
        "lawns": [{"id": l["id"], "k": l["k"], "n": l["n"], "p": qr(l["p"])} for l in lawns],
        "trees": [[q(x), q(z), round(s, 2)] for x, z, s in trees],
        "lamps": [[q(x), q(z)] for x, z in lamps],
        "fountains": [[q(x), q(z), round(s, 2)] for x, z, s in fountains],
        "water": [{"k": w["k"], "p": qr(w["p"])} for w in water],
        "rail": [qr(r) for r in rail],
        "parking": [qr(r) for r in parking],
        "hsrc": hsrc_counts,
        "lidar": lidar is not None,
    }


# ---------------------------------------------------------------------------
# Tiling
# ---------------------------------------------------------------------------

def _tile_key(x: float, z: float) -> tuple[int, int]:
    return (math.floor(x / TILE_UNITS), math.floor(z / TILE_UNITS))


def _tile_box(tx: int, tz: int):
    return (tx * TILE_UNITS, tz * TILE_UNITS, (tx + 1) * TILE_UNITS, (tz + 1) * TILE_UNITS)


def _tile_name(tx: int, tz: int) -> str:
    f = lambda v: f"m{-v}" if v < 0 else str(v)
    return f"{f(tx)}_{f(tz)}"


def _ring_bbox(ring):
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    return min(xs), min(zs), max(xs), max(zs)


def _tiles_touching(x0, z0, x1, z1):
    a, b = _tile_key(x0, z0)
    c, d = _tile_key(x1, z1)
    for tx in range(a, c + 1):
        for tz in range(b, d + 1):
            yield tx, tz


def tile_model(model: dict, frame) -> dict[tuple[int, int], dict]:
    tiles: dict[tuple[int, int], dict] = {}

    def tile(tx, tz):
        key = (tx, tz)
        if key not in tiles:
            tiles[key] = {"x": tx, "z": tz, "buildings": [], "roads": [], "lawns": [], "trees": [], "lamps": [],
                          "fountains": [], "water": [], "rail": [], "parking": []}
        return tiles[key]

    for b in model["buildings"]:
        cx = sum(p[0] for p in b["p"]) / len(b["p"])
        cz = sum(p[1] for p in b["p"]) / len(b["p"])
        tile(*_tile_key(cx, cz))["buildings"].append(b)
    for r in model["roads"]:
        for tx, tz in _tiles_touching(*_ring_bbox(r["p"])):
            box = _tile_box(tx, tz)
            for run in clip_polyline_box(r["p"], *box):
                tile(tx, tz)["roads"].append({**r, "p": qr(run)})
    for rail in model["rail"]:
        for tx, tz in _tiles_touching(*_ring_bbox(rail)):
            for run in clip_polyline_box(rail, *_tile_box(tx, tz)):
                tile(tx, tz)["rail"].append(qr(run))
    for l in model["lawns"]:
        for tx, tz in _tiles_touching(*_ring_bbox(l["p"])):
            clipped = clip_ring_box(l["p"], *_tile_box(tx, tz))
            if clipped:
                tile(tx, tz)["lawns"].append({**l, "p": qr(clipped)})
    for ring in model["parking"]:
        for tx, tz in _tiles_touching(*_ring_bbox(ring)):
            clipped = clip_ring_box(ring, *_tile_box(tx, tz))
            if clipped:
                tile(tx, tz)["parking"].append(qr(clipped))
    for w in model["water"]:
        for tx, tz in _tiles_touching(*_ring_bbox(w["p"])):
            box = _tile_box(tx, tz)
            if w["k"] == "line":
                for run in clip_polyline_box(w["p"], *box):
                    tile(tx, tz)["water"].append({"k": "line", "p": qr(run)})
            else:
                clipped = clip_ring_box(w["p"], *box)
                if clipped:
                    tile(tx, tz)["water"].append({"k": "poly", "p": qr(clipped)})
    for t in model["trees"]:
        tile(*_tile_key(t[0], t[1]))["trees"].append(t)
    for l in model["lamps"]:
        tile(*_tile_key(l[0], l[1]))["lamps"].append(l)
    for f in model["fountains"]:
        tile(*_tile_key(f[0], f[1]))["fountains"].append(f)
    return tiles


def _jsonable(v):
    """Integral floats become ints and strings stay UTF-8, so JSON.stringify in the
    renderer/tests reproduces the same bytes (`10.0` vs `10`, `\\u2014` vs `—`)."""
    if isinstance(v, float):
        return int(v) if v.is_integer() and abs(v) < 1e15 else v
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def _canon(doc) -> bytes:
    return json.dumps(_jsonable(doc), separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")


def write_tiled(model: dict, out_dir: Path, core_only: bool) -> dict:
    frame = model["frame"]
    tiles = tile_model(model, frame)
    tiles_dir = out_dir / "tiles"
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    tiles_dir.mkdir(parents=True, exist_ok=True)

    s, w, n, e = frame.core_bbox
    def in_core(tx, tz):
        x0, z0, x1, z1 = _tile_box(tx, tz)
        lat, lng = frame.to_latlng((x0 + x1) / 2, (z0 + z1) / 2)
        return s <= lat <= n and w <= lng <= e

    table = []
    for (tx, tz), t in sorted(tiles.items()):
        for k in ("buildings", "roads", "lawns", "trees", "lamps", "fountains", "water", "rail", "parking"):
            if k in ("buildings", "roads", "lawns"):
                t[k].sort(key=lambda r: (r.get("id") or "", json.dumps(r.get("p"))))
            else:
                t[k].sort(key=lambda r: json.dumps(r, sort_keys=True))
        body = _canon({"schema": SCHEMA, "x": tx, "z": tz, **{k: t[k] for k in t if k not in ("x", "z")}})
        sha = hashlib.sha256(body).hexdigest()
        name = f"{_tile_name(tx, tz)}.{sha[:8]}.json"
        (tiles_dir / name).write_bytes(body)
        max_h = max([b["h"] for b in t["buildings"]] + [0.0])
        x0, z0, x1, z1 = _tile_box(tx, tz)
        table.append({
            "x": tx, "z": tz, "bbox": [x0, z0, x1, z1], "maxH": round(max_h, 3),
            "counts": {k: len(t[k]) for k in ("buildings", "roads", "lawns", "trees", "lamps")},
            "bytes": len(body), "sha256": sha, "file": f"tiles/{name}", "core": 1 if in_core(tx, tz) else 0,
        })

    frame_meta = {
        "schema": SCHEMA,
        "pack": model["event"].get("id", ""),
        "origin": [frame.origin_lat, frame.origin_lng],
        "metersPerUnit": frame.meters_per_unit,
        "vscale": frame.vscale,
        "tileUnits": TILE_UNITS,
        "bbox": list(frame.bbox),
        "coreBbox": list(frame.core_bbox),
        "coreOnly": bool(core_only),
        "sources": F.sources(),
        "heights": {**model["hsrc"], "lidar": model["lidar"]},
        "counts": {
            "buildings": len(model["buildings"]), "monuments": len(model["monuments"]), "roads": len(model["roads"]),
            "lawns": len(model["lawns"]), "trees": len(model["trees"]), "lamps": len(model["lamps"]),
            "water": len(model["water"]), "rail": len(model["rail"]), "parking": len(model["parking"]),
            "fountains": len(model["fountains"]), "tiles": len(table),
        },
    }
    index = {"meta": frame_meta, "monuments": model["monuments"], "tiles": table}
    index["meta"]["hash"] = hashlib.sha256(_canon({"meta": frame_meta, "monuments": model["monuments"], "tiles": [t["sha256"] for t in table]})).hexdigest()
    index["meta"]["builtAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (out_dir / "index.json").write_bytes(json.dumps(_jsonable(index), separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    return index


# ---------------------------------------------------------------------------
# Legacy single-file bake (schema 1 layout, core bbox)
# ---------------------------------------------------------------------------

def legacy_doc(model: dict) -> dict:
    frame = model["frame"]
    s, w, n, e = frame.core_bbox

    def core_pt(x, z):
        lat, lng = frame.to_latlng(x, z)
        return s <= lat <= n and w <= lng <= e

    def core_ring(ring):
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        return core_pt(cx, cz)

    buildings = [b for b in model["buildings"] if core_ring(b["p"])]
    roads = [r for r in model["roads"] if any(core_pt(*p) for p in r["p"])]
    lawns = [l for l in model["lawns"] if core_ring(l["p"])]
    trees = [t for t in model["trees"] if core_pt(t[0], t[1])][:3200]
    lamps = [l for l in model["lamps"] if core_pt(l[0], l[1])][:360]
    fountains = [f for f in model["fountains"] if core_pt(f[0], f[1])]
    water = [wt for wt in model["water"] if any(core_pt(*p) for p in wt["p"])]
    rail = [r for r in model["rail"] if any(core_pt(*p) for p in r)]
    parking = [p for p in model["parking"] if core_ring(p)]
    doc = {
        "meta": {
            "schema": 1,
            "pack": model["event"].get("id", ""),
            "origin": [frame.origin_lat, frame.origin_lng],
            "metersPerUnit": frame.meters_per_unit,
            "bbox": list(frame.core_bbox),
            "source": "OpenStreetMap contributors (ODbL 1.0), via Overpass API",
            "sources": F.sources(),
            "counts": {
                "buildings": len(buildings), "monuments": len(model["monuments"]), "roads": len(roads),
                "lawns": len(lawns), "trees": len(trees), "lamps": len(lamps), "water": len(water),
                "rail": len(rail), "parking": len(parking), "fountains": len(fountains),
            },
        },
        "buildings": [{k: v for k, v in b.items() if k != "id"} for b in buildings],
        "monuments": model["monuments"],
        "roads": [{"w": r["w"], "m": r["m"], "f": r["f"], "p": r["p"]} for r in roads],
        "lawns": [{"k": l["k"], "n": l["n"], "p": l["p"]} for l in lawns],
        "trees": trees, "lamps": lamps, "fountains": fountains, "water": water, "rail": rail, "parking": parking,
    }
    doc["meta"]["hash"] = content_hash(doc)
    doc["meta"]["builtAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return doc


def content_hash(doc: dict) -> str:
    meta = {k: v for k, v in doc["meta"].items() if k not in ("builtAt", "hash")}
    body = {"meta": meta, **{k: v for k, v in doc.items() if k != "meta"}}
    return hashlib.sha256(json.dumps(body, separators=(",", ":")).encode("utf-8")).hexdigest()


def write_legacy(doc: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))


def report(index: dict, legacy: dict, out_dir: Path, mpu: float) -> None:
    total = sum(t["bytes"] for t in index["tiles"])
    print(f"wrote {out_dir}/index.json + {len(index['tiles'])} tiles ({total / 1024:.0f} KB raw)  hash {index['meta']['hash'][:12]}")
    print(f"      campus.json (core, schema 1)  {os.path.getsize(out_dir.parent / 'campus.json') / 1024:.0f} KB  hash {legacy['meta']['hash'][:12]}")
    for k, v in index["meta"]["counts"].items():
        print(f"  {k:11s} {v}")
    print(f"  heights     {index['meta']['heights']}")
    print(f"  {'monument':11s} {'src':5s} {'hsrc':7s} {'kind':10s} {'centre (x, z)':18s} footprint (m)")
    for mo in index["monuments"]:
        xs = [p[0] for p in mo["poly"]]
        zs = [p[1] for p in mo["poly"]]
        span = f"{(max(xs) - min(xs)) * mpu:5.0f} x {(max(zs) - min(zs)) * mpu:3.0f}"
        print(f"  {mo['short']:11s} {mo['src']:5s} {mo.get('hsrc', ''):7s} {mo['kind']:10s} "
              f"({mo['c'][0]:7.1f}, {mo['c'][1]:7.1f})   {span}   h {mo['h'] * mpu:.0f}")
