"""Roof shape `r` and ridge line `rr` (plan §B1)."""
from __future__ import annotations

from .config import ROOF_CODES

HOUSING = {"house", "detached", "semidetached_house", "residential", "apartments", "dormitory", "barn", "church"}


def roof_for(tags: dict, btype: str, h_m: float, area_m2: float, lidar_ratio: float | None) -> str:
    shape = tags.get("roof:shape")
    if shape and shape in ROOF_CODES:
        return ROOF_CODES[shape]
    if lidar_ratio is not None and lidar_ratio > 1.12:
        return "g" if area_m2 < 600 else "h"
    if btype in HOUSING and area_m2 < 400:
        return "g"
    if btype in {"house", "detached", "semidetached_house", "barn", "church"}:
        return "h"
    if btype == "university" and area_m2 < 1500 and h_m < 14:
        return "h"
    return "f"


def ridge_for(ring) -> list[list[float]] | None:
    """Long axis of the minimum-area rotated rectangle, as two endpoints in world units."""
    try:
        import warnings
        from shapely.geometry import Polygon
        poly = Polygon(ring)
        if not poly.is_valid or poly.area < 1e-6:
            return None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            rect = poly.minimum_rotated_rectangle
        if rect.geom_type != "Polygon":
            return None
        pts = list(rect.exterior.coords)[:4]
    except Exception:
        return None
    if len(pts) < 4:
        return None
    import math
    e0 = math.dist(pts[0], pts[1])
    e1 = math.dist(pts[1], pts[2])
    if e0 >= e1:
        a = ((pts[0][0] + pts[3][0]) / 2, (pts[0][1] + pts[3][1]) / 2)
        b = ((pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2)
    else:
        a = ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
        b = ((pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2)
    # Pull the ridge in a little so hips read as hips.
    return [[round(a[0], 2), round(a[1], 2)], [round(b[0], 2), round(b[1], 2)]]
