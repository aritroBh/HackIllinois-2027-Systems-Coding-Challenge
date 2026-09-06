"""
Optional lidar backend.

The plan's production path downloads the public USGS LAZ tiles for the bbox
(IL_8County_PlusChampaign_B3_QL1_2019, public domain), decodes them with laspy[lazrs] and
rasterises a first-return DSM and a class-2 DTM at 1 m. That step is manual and heavy
(1–2 GB); this module consumes the result when it exists and says so when it does not:

  design/osm/lidar/grid.json   {"x0","z0","res","w","h"}  raster frame in world units
  design/osm/lidar/dsm.npy     float32 (h, w) first-return maximum, metres
  design/osm/lidar/dtm.npy     float32 (h, w) class-2 minimum, metres

`sample(ring)` returns (height_m, p95_over_p50) for a world-unit ring, or None when the
raster is absent or covers fewer than 200 cells of the footprint. Heights are rejected
outside 2.5–120 m by heights.py. See design/pipeline/README.md for the rasterisation
recipe.
"""
from __future__ import annotations

import json
from pathlib import Path

from .config import OSM_DIR

LIDAR_DIR = OSM_DIR / "lidar"


class Lidar:
    def __init__(self, grid: dict, dsm, dtm, mpu: float):
        self.grid = grid
        self.dsm = dsm
        self.dtm = dtm
        self.mpu = mpu

    @classmethod
    def load(cls, mpu: float, enabled: bool = True):
        if not enabled:
            return None
        g = LIDAR_DIR / "grid.json"
        if not (g.exists() and (LIDAR_DIR / "dsm.npy").exists() and (LIDAR_DIR / "dtm.npy").exists()):
            return None
        import numpy as np  # local import: numpy is only needed when the cache exists
        grid = json.loads(g.read_text())
        return cls(grid, np.load(LIDAR_DIR / "dsm.npy"), np.load(LIDAR_DIR / "dtm.npy"), mpu)

    def sample(self, ring) -> tuple[float, float] | None:
        import numpy as np
        from shapely.geometry import Polygon
        poly = Polygon(ring)
        if not poly.is_valid or poly.is_empty:
            return None
        inset = poly.buffer(-1.0 / self.mpu)
        if inset.is_empty:
            inset = poly
        outer = poly.buffer(5.0 / self.mpu).difference(poly)
        res = self.grid["res"] / self.mpu  # raster cell in world units
        x0, z0 = self.grid["x0"], self.grid["z0"]
        minx, minz, maxx, maxz = outer.bounds
        c0, c1 = max(0, int((minx - x0) / res)), min(self.grid["w"], int((maxx - x0) / res) + 1)
        r0, r1 = max(0, int((minz - z0) / res)), min(self.grid["h"], int((maxz - z0) / res) + 1)
        if c1 <= c0 or r1 <= r0:
            return None
        from shapely import contains_xy
        cols = np.arange(c0, c1)
        rows = np.arange(r0, r1)
        cx = x0 + (cols + 0.5) * res
        cz = z0 + (rows + 0.5) * res
        gx, gz = np.meshgrid(cx, cz)
        inside = contains_xy(inset, gx.ravel(), gz.ravel()).reshape(gx.shape)
        around = contains_xy(outer, gx.ravel(), gz.ravel()).reshape(gx.shape)
        roof = self.dsm[r0:r1, c0:c1][inside]
        ground = self.dtm[r0:r1, c0:c1][around]
        roof = roof[np.isfinite(roof)]
        ground = ground[np.isfinite(ground)]
        if roof.size < 200 or ground.size < 50:
            return None
        p95 = float(np.percentile(roof, 95))
        p50 = float(np.percentile(roof, 50))
        base = float(np.median(ground))
        h = p95 - base
        ratio = (p95 - base) / max(0.5, p50 - base)
        return h, ratio
