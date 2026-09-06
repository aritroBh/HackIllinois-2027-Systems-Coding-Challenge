"""Pure geometry helpers on world-unit rings (x east, z south)."""
from __future__ import annotations

import math
import sys


def centroid_latlng(geom: list[dict]) -> tuple[float, float]:
    pts = geom
    if len(pts) > 2 and pts[0]["lat"] == pts[-1]["lat"] and pts[0]["lon"] == pts[-1]["lon"]:
        pts = pts[:-1]
    return (sum(p["lat"] for p in pts) / len(pts), sum(p["lon"] for p in pts) / len(pts))


def signed_area(pts) -> float:
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * z1 - x1 * z0
    return a / 2.0


def ring_area_m2(pts, mpu: float) -> float:
    return abs(signed_area(pts)) * mpu ** 2


def ensure_ccw(pts):
    return pts if signed_area(pts) > 0 else pts[::-1]


def ensure_cw(pts):
    return pts if signed_area(pts) < 0 else pts[::-1]


def simplify(pts, tol_units: float):
    """Douglas-Peucker on an open polyline.

    OSM traces carry far more vertices than a 10 m-per-unit model can show, and
    they are the pack's dominant byte cost. Dropping anything within
    `tol_units` of the chord is invisible at render scale and roughly halves a
    tile.
    """
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
            d = math.hypot(px - x0, pz - z0) if norm < 1e-9 else abs(dz * px - dx * pz + x1 * z0 - z1 * x0) / norm
            if d > best_d:
                best_i, best_d = i, d
        if best_d > tol_units:
            keep.add(best_i)
            rec(lo, best_i, keep)
            rec(best_i, hi, keep)

    keep = {0, len(pts) - 1}
    # rec() recurses once per kept vertex in the worst case, and a traced creek
    # or rail line runs to thousands of points. The default 1000 frames is not
    # enough for those.
    sys.setrecursionlimit(10000)
    rec(0, len(pts) - 1, keep)
    return [pts[i] for i in sorted(keep)]


def close_ring_from_geom(frame, geom: list[dict]):
    ring = [frame.to_world(p["lat"], p["lon"]) for p in geom]
    if len(ring) > 1 and math.dist(ring[0], ring[-1]) < 1e-6:
        ring = ring[:-1]
    return ring


def point_in_ring(x: float, z: float, ring) -> bool:
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


def walk(pts, step: float):
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
    h = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - math.floor(h)


def assemble_rings(ways: list[list[dict]]) -> list[list[dict]]:
    """Chain multipolygon member ways into closed rings on shared node coordinates.

    A relation's members arrive as unordered open ways that may run either
    direction, so the ring has to be walked end to end and segments reversed as
    they attach. Matching is on the exact lat/lon pair because `out geom` echoes
    a shared node's coordinates identically in every way that uses it, and
    member elements carry no node ids to match on instead.

    An unclosed chain is dropped rather than force-closed: the buildings that
    need this (ECEB, the Main Library, MNTL) are all properly closed relations,
    and a bad ring would put a mass across the campus rather than nothing.
    """
    segs = [list(w) for w in ways if len(w) >= 2]
    rings: list[list[dict]] = []

    def key(p: dict):
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
                break
        if len(cur) >= 4 and key(cur[0]) == key(cur[-1]):
            rings.append(cur)
    return rings


def clip_runs(frame, geom, box):
    """Split a lat/lng polyline into the runs of consecutive vertices inside `box`, in world units.

    Vertices outside the box are dropped, not intersected, so a run ends at the
    last vertex inside rather than on the boundary. A road can therefore stop up
    to one segment short of the edge. That is invisible on a bbox that already
    extends past anything the camera reaches, and it keeps this free of the
    special cases a real line clip needs on a polyline that re-enters the box.
    """
    s, w, n, e = box
    runs, cur = [], []
    for pt in geom:
        if s <= pt["lat"] <= n and w <= pt["lon"] <= e:
            cur.append(frame.to_world(pt["lat"], pt["lon"]))
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def clip_polyline_box(pts, x0, z0, x1, z1):
    """Split a world-unit polyline into runs inside an axis-aligned box (tile clipping).

    Vertex-drop, like clip_runs: a run ends at the last vertex inside the box
    rather than on the boundary, and a segment that spans the box end to end
    without a vertex in it yields nothing at all. Unlike clip_runs, this one
    cuts at tile seams rather than at the edge of the world, so the shortfall is
    a visible break in the road, not an off-camera detail. Making the seams meet
    means clipping each segment against the four edges instead, the way
    clip_ring_box already does for rings.
    """
    runs, cur = [], []
    for x, z in pts:
        if x0 <= x <= x1 and z0 <= z <= z1:
            cur.append((x, z))
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def clip_ring_box(ring, x0, z0, x1, z1):
    """Sutherland-Hodgman clip of a ring against an axis-aligned box.

    Four half-plane passes, each keeping the inside vertices and inserting the
    crossing point where an edge leaves or enters. A concave ring clipped this
    way can come back with a zero-width bridge along the box edge, which is
    harmless here: the result only ever becomes a flat lawn or parking decal.
    """
    def clip(poly, inside, intersect):
        out = []
        if not poly:
            return out
        prev = poly[-1]
        for cur in poly:
            if inside(cur):
                if not inside(prev):
                    out.append(intersect(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(intersect(prev, cur))
            prev = cur
        return out

    def ix(p, q, x):
        t = (x - p[0]) / (q[0] - p[0]) if q[0] != p[0] else 0.0
        return (x, p[1] + (q[1] - p[1]) * t)

    def iz(p, q, z):
        t = (z - p[1]) / (q[1] - p[1]) if q[1] != p[1] else 0.0
        return (p[0] + (q[0] - p[0]) * t, z)

    poly = list(ring)
    poly = clip(poly, lambda p: p[0] >= x0, lambda p, q: ix(p, q, x0))
    poly = clip(poly, lambda p: p[0] <= x1, lambda p, q: ix(p, q, x1))
    poly = clip(poly, lambda p: p[1] >= z0, lambda p, q: iz(p, q, z0))
    poly = clip(poly, lambda p: p[1] <= z1, lambda p, q: iz(p, q, z1))
    # Drop consecutive duplicates.
    out = []
    for p in poly:
        if not out or math.dist(out[-1], p) > 1e-6:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) < 1e-6:
        out.pop()
    return out if len(out) >= 3 else []


def bbox_of(pts):
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return min(xs), min(zs), max(xs), max(zs)
