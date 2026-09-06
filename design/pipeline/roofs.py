"""Roof shape `r` and ridge line `rr` (plan §B1)."""
from __future__ import annotations

from .config import ROOF_CODES

HOUSING = {"house", "detached", "semidetached_house", "residential", "apartments", "dormitory", "barn", "church"}


def roof_for(tags: dict, btype: str, h_m: float, area_m2: float, lidar_ratio: float | None) -> str:
    """Roof code, best evidence first: the tag, then lidar, then type and era rules."""
    shape = tags.get("roof:shape")
    if shape and shape in ROOF_CODES:
        return ROOF_CODES[shape]
    # lidar_ratio is P95/P50 of the roof surface. A flat roof reads about 1.0;
    # the gap only opens when the surface climbs toward a ridge, so 1.12 is the
    # threshold that separates a real pitch from parapets and rooftop plant.
    # Below 600 m2 a pitched roof is almost always a simple gable; above it,
    # hips are the safer guess and read better from the air.
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
    """Long axis of the minimum-area rotated rectangle, as two endpoints in world units.

    The renderer needs an axis to raise a ridge along, and a real footprint is
    rarely a rectangle. The minimum-area rectangle is the cheapest stand-in that
    respects the building's actual orientation, so an L-shaped hall still gets
    its ridge running the way the roof does rather than along north.

    Returns None rather than raising when shapely is missing or the ring is
    degenerate: roof_for has already committed to a pitched code, and the
    renderer falls back to a flat cap when `rr` is absent.
    """
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
    # Full-length ridge. hipRoofGeometry insets its own ends; a gable wants the
    # ridge to reach the gable walls.
    return [[round(a[0], 2), round(a[1], 2)], [round(b[0], 2), round(b[1], 2)]]
