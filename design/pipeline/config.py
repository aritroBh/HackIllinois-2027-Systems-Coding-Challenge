"""
Frame, tables and pack loading for the campus pipeline.

Everything campus-specific comes from the content pack (`event.json`, `monuments.json`,
optional `design/hand/crowns/<id>.json`). The tables here are the generic massing rules
a fork can tune without touching the code paths.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OSM_DIR = ROOT / "design" / "osm"
CACHE_DIR = OSM_DIR / "cache"
HAND_DIR = ROOT / "design" / "hand"
QUERY_DIR = HERE / "queries"

SCHEMA = 2
TILE_UNITS = 50            # 500 m at 10 m/unit
M_PER_DEG_LAT = 111320.0

LEVEL_HEIGHT = 3.8
DEFAULT_HEIGHT = {
    "university": 15.0, "apartments": 17.0, "dormitory": 20.0, "commercial": 12.0,
    "retail": 8.0, "house": 7.0, "detached": 7.0, "semidetached_house": 7.0,
    "residential": 9.0, "garage": 3.5, "roof": 4.0, "industrial": 9.0, "warehouse": 9.0,
    "church": 12.0, "school": 10.0, "hospital": 16.0, "office": 14.0, "hotel": 18.0,
    "greenhouse": 4.5, "barn": 7.0, "farm_auxiliary": 5.0, "shed": 3.0, "yes": 9.0,
}
DEFAULT_LEVELS = {"house": 2, "detached": 2, "semidetached_house": 2, "garage": 1, "shed": 1,
                  "retail": 2, "commercial": 3, "apartments": 4, "dormitory": 5, "university": 4, "yes": 2}
MIN_FOOTPRINT_M2 = 55.0
SIMPLIFY_TOLERANCE_M = 1.1
ROAD_WIDTH = {
    "primary": 16.0, "secondary": 14.0, "tertiary": 12.0,
    "residential": 9.0, "unclassified": 9.0, "service": 5.5,
    "footway": 2.6, "path": 2.2,
}

# Facade material by building type when no tag or landmark says otherwise (facade.py).
FACADE_BY_TYPE = {
    "university": "brick", "school": "brick", "apartments": "brick", "dormitory": "brick",
    "hotel": "precast", "office": "precast", "commercial": "concreteGrey", "retail": "concreteGrey",
    "house": "clapboard", "detached": "clapboard", "semidetached_house": "clapboard", "residential": "clapboard",
    "garage": "concreteGrey", "shed": "clapboard", "industrial": "metalPanel", "warehouse": "metalPanel",
    "barn": "clapboard", "greenhouse": "glass", "farm_auxiliary": "metalPanel", "church": "limestoneGrey",
    "hospital": "precast", "yes": "brick",
}
# Must stay in lockstep with public/gl/materials.js (verify.sh asserts it).
MATERIAL_IDS = {
    "brick": 1, "limestoneGrey": 2, "limestoneBuff": 3, "verdigris": 4, "verdigrisDome": 5, "slate": 6,
    "terracotta": 7, "glass": 8, "concreteRibbed": 9, "asphalt": 10, "asphaltLine": 11, "walk": 12,
    "lawn": 13, "canopy": 14, "water": 15, "ballast": 16, "bronze": 17, "bronzePatina": 18, "granite": 19,
    "whiteTrim": 20, "concreteGrey": 21, "field": 22, "clapboard": 23, "precast": 24, "metalPanel": 25,
    "glassDark": 26, "roofMembrane": 27, "standingSeam": 28,
}
ROOF_CODES = {"flat": "f", "gabled": "g", "hipped": "h", "mansard": "m", "dome": "d", "skillion": "s",
              "half-hipped": "h", "gambrel": "g", "pyramidal": "h", "round": "d", "onion": "d"}


@dataclass
class Frame:
    origin_lat: float
    origin_lng: float
    meters_per_unit: float
    bbox: tuple[float, float, float, float]        # south, west, north, east
    core_bbox: tuple[float, float, float, float]
    detail_bbox: tuple[float, float, float, float] = None  # type: ignore[assignment]
    vscale: float = 2.6

    @property
    def m_per_deg_lng(self) -> float:
        return 111320.0 * math.cos(math.radians(self.origin_lat))

    def to_world(self, lat: float, lng: float) -> tuple[float, float]:
        """WGS84 -> local metric frame. +x east, +z south, in world units."""
        return (
            (lng - self.origin_lng) * self.m_per_deg_lng / self.meters_per_unit,
            -(lat - self.origin_lat) * M_PER_DEG_LAT / self.meters_per_unit,
        )

    def to_latlng(self, x: float, z: float) -> tuple[float, float]:
        return (
            self.origin_lat - z * self.meters_per_unit / M_PER_DEG_LAT,
            self.origin_lng + x * self.meters_per_unit / self.m_per_deg_lng,
        )

    def in_bbox(self, lat: float, lng: float, box=None) -> bool:
        s, w, n, e = box or self.bbox
        return s <= lat <= n and w <= lng <= e


@dataclass
class Pack:
    dir: Path
    event: dict
    frame: Frame
    monuments: list[dict]
    crowns: dict[str, dict]


def configure(pack_dir: Path, core_only: bool = False) -> Pack:
    """Load event.json + monuments.json (+ hand crown recipes) and point the frame at that campus."""
    event_path = pack_dir / "event.json"
    mon_path = pack_dir / "monuments.json"
    for p in (event_path, mon_path):
        if not p.exists():
            sys.exit(f"pack is missing {p}")
    event = json.loads(event_path.read_text())
    monuments = json.loads(mon_path.read_text())["monuments"]
    campus = event.get("campus", {})
    bbox = tuple(float(v) for v in campus["bbox"])
    core = tuple(float(v) for v in campus.get("coreBbox", campus["bbox"]))
    frame = Frame(
        origin_lat=float(campus["origin"][0]), origin_lng=float(campus["origin"][1]),
        meters_per_unit=float(campus.get("metersPerUnit", 10.0)),
        bbox=core if core_only else bbox, core_bbox=core,
        detail_bbox=tuple(float(v) for v in campus.get("detailBbox", campus.get("coreBbox", campus["bbox"]))),
        vscale=float(campus.get("vscale", 2.6)),
    )
    mons = []
    for m in monuments:
        rec = dict(m)
        if "at" in rec:
            rec["at"] = (float(rec["at"][0]), float(rec["at"][1]))
        if "synth" in rec:
            rec["synth"] = tuple(float(v) for v in rec["synth"])
        rec.setdefault("blurb", "")
        mons.append(rec)
    if not mons:
        sys.exit(f"{mon_path} declares no monuments")
    crowns: dict[str, dict] = {}
    for m in mons:
        cp = HAND_DIR / "crowns" / f"{m['id']}.json"
        if cp.exists():
            crowns[m["id"]] = json.loads(cp.read_text())
        elif isinstance(m.get("crown"), dict):
            crowns[m["id"]] = m["crown"]
    return Pack(dir=pack_dir, event=event, frame=frame, monuments=mons, crowns=crowns)
