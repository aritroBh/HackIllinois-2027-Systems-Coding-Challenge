"""
Height fusion (plan §B1). Order, with the source recorded as `hsrc`:

  tag      OSM `height=*`
  lidar    P95 of first returns inside the footprint (inset 1 m) minus the median ground
           around it, from the cached DSM/DTM rasters (lidar.py) — when the cache exists
  levels   OSM `building:levels` × 3.8 m + 1.2 m
  default  per building type, with a nudge for big unlevelled halls

`lv` (floors) is the tag when present, else the height divided by a storey.
"""
from __future__ import annotations

from .config import DEFAULT_HEIGHT, DEFAULT_LEVELS, LEVEL_HEIGHT


def _tag_height(tags: dict) -> float | None:
    raw = tags.get("height")
    if not raw:
        return None
    try:
        s = str(raw).lower().replace("m", "").strip()
        if s.endswith("ft") or "'" in s:
            return float(s.replace("ft", "").replace("'", "").strip()) * 0.3048
        return float(s)
    except ValueError:
        return None


def _tag_levels(tags: dict) -> int | None:
    lv = tags.get("building:levels")
    if not lv:
        return None
    try:
        return int(float(str(lv).split(";")[0].strip()))
    except ValueError:
        return None


def resolve(tags: dict, btype: str, area_m2: float, lidar_h: float | None = None) -> tuple[float, str, int]:
    """Return (height_m, hsrc, levels)."""
    levels = _tag_levels(tags)
    h = _tag_height(tags)
    if h is not None and 2.0 <= h <= 200.0:
        return h, "tag", levels or max(1, round((h - 1.2) / LEVEL_HEIGHT))
    if lidar_h is not None and 2.5 <= lidar_h <= 120.0:
        return lidar_h, "lidar", levels or max(1, round((lidar_h - 1.2) / LEVEL_HEIGHT))
    # The 1.2 m is everything above the top floor slab: parapet, plant screen,
    # the taller ground storey. Without it a levels-derived height lands
    # consistently short against the tagged and lidar heights beside it.
    if levels:
        return levels * LEVEL_HEIGHT + 1.2, "levels", levels
    h = DEFAULT_HEIGHT.get(btype, 9.0)
    # A footprint this big is an arena, a plant or a large hall, never the small
    # shed the type default assumes.
    if area_m2 > 3000:
        h = max(h, 16.0)
    return h, "default", DEFAULT_LEVELS.get(btype, max(1, round((h - 1.2) / LEVEL_HEIGHT)))
