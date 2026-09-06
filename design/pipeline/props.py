"""
Street furniture and the small surfaces nobody models by hand: benches, bins, bike racks,
hydrants, bollards, flagpoles, fence runs, sports pitches and flights of steps.

This file exists because the campus reads as a massing study until the ground has things on
it at human scale, and it has two halves that disagree with each other on purpose.

The first half takes the survey. Furniture is recognised rather than merely seen — a visitor
knows there is no bench outside their hall — so wherever OpenStreetMap has an opinion, that
opinion wins and is reproduced exactly.

The second half, `generate_props` at the bottom of this file, fills the silence. The survey is
not wrong; it is a survey, and nobody has walked every path in Urbana with a phone. There are
two hundred benches mapped for the whole city and two hundred and eighty cycle racks for nine
thousand buildings, so taking only what is surveyed gives beautifully accurate buildings
standing on empty ground, which reads as unfinished rather than as accurate. Generated
placements follow the rules a grounds department follows, come from a hash of their own
position so the pack stays reproducible, and are dropped wherever a surveyed prop already
stands. An earlier version of this paragraph insisted the opposite — that a prop OpenStreetMap
does not vouch for is simply absent — and that has not been true since the generator landed.

A prop is a point record with a kind, a heading and a scale rather than baked geometry, so a
pack stays in the low thousands of records rather than the low millions of triangles. What the
renderer then does with that record is its own decision, and `tile-bake.js` merges the meshes
into the tile's static batch rather than instancing them; the reasoning is stated there.

The vocabulary in PROP_KINDS is closed on purpose. OpenStreetMap has a long tail of amenity
values and the temptation is to pass anything through and let the renderer guess, which produces
a pack that silently references meshes that do not exist. Anything this file cannot map onto a
kind it owns is dropped without comment, and a new kind is a deliberate edit here plus a mesh on
the client, in that order.
"""
from __future__ import annotations

import math

from .config import ROAD_WIDTH, Frame
from .geom import centroid_latlng, clip_runs, close_ring_from_geom, ensure_ccw, hash01, point_in_ring, ring_area_m2, simplify, walk

# The closed vocabulary. Each entry is a mesh the client is expected to own, so the tuple and
# the renderer's prop atlas move together. Read the kinds as: seating (bench, picnic), refuse
# (bin), cycling (bikerack), safety and control (hydrant, bollard, gate),
# civic fittings (postbox, sign, planter, drinkfountain, flag, artwork), sheltered waiting
# (shelter, busstop), play (playground) and the tall silhouettes (watertower, chimney, mast).
PROP_KINDS = (
    "bench", "bin", "bikerack", "hydrant", "bollard", "picnic", "flag", "shelter",
    "busstop", "artwork", "postbox", "sign", "planter", "drinkfountain", "playground",
    "watertower", "chimney", "mast", "gate",
)

# Deliberately absent: crossing and traffic_signals. A zebra crossing is a pair of endpoints
# and a band width, which is a ground decal (public/gl/decals.js crosswalkDecal), not a point
# prop with a rotation and a scale; a single {x, z, r, s} record cannot express it. Baking
# either as a prop would put a kind in the pack that buildProp answers with null, which is
# precisely the silent mismatch this closed vocabulary exists to prevent.

# The tall things are visible from the far side of the campus. They used to be the only kinds
# that earned the full frame bbox, with everything else clipped to the smaller detail box —
# which, on a twenty-five square kilometre pack, threw away three quarters of the furniture,
# including every bus stop and bike rack in Research Park and the South Farms. A prop record is
# a kind, two coordinates, a rotation and a scale: about sixty bytes, against a pack already
# past two megabytes. The whole-campus set is a rounding error on the download and the
# difference between a campus that looks inhabited to its edges and one that stops.
#
# Only the small ground furniture that a distant viewer could not resolve anyway is still
# clipped, and it is clipped to the CORE box rather than the detail box, which is wider.
LANDMARK_KINDS = ("watertower", "mast", "flag", "chimney")
CLIPPED_KINDS = ("bin", "bollard", "postbox", "drinkfountain")

# Props whose mesh has a long axis that should follow the path or kerb beside it. A bench set
# at right angles to the walk it serves looks broken in a way a rotated bin never does.
ALIGNED_KINDS = ("bench", "picnic", "busstop", "shelter", "sign", "postbox", "planter", "artwork")

# Props that block or span a way rather than sit beside it, so they take the perpendicular.
CROSS_KINDS = ("gate",)

# Ground furniture that cannot physically be inside a wall, so a hit against a building
# footprint means the node was mapped onto the wrong feature and the prop is dropped. Chimneys
# and masts are deliberately absent: they legitimately stand on roofs.
GROUND_KINDS = ("bench", "bin", "bikerack", "picnic", "planter", "drinkfountain", "hydrant", "bollard")

# Nominal real-world height of each landmark mesh in metres, used to turn an OSM height tag
# into a scale multiplier. These are not plausible real-world figures: they are read off the
# meshes in public/gl/props.js, because a multiplier is only meaningful against the thing it
# multiplies. Guessing them instead was worth up to a 1.6x error — a tagged 40 m mast came out
# at scale 1.0 and rendered 25 m, and the docstring's own worked example was wrong by the same
# factor. A tagged 70 m mast is 70 / 25 = scale 2.8.
NOMINAL_HEIGHT_M = {"flag": 9.0, "watertower": 38.0, "mast": 25.0, "chimney": 24.0}

# Barrier values worth drawing, and the fallback height in metres for each. A fence is a 1.2 m
# park railing, a wall is a 1.8 m boundary you cannot see over, and a hedge is a 1.0 m clipped
# box; these are the heights that make an untagged run look right rather than an average of
# everything OSM calls a fence.
BARRIER_KIND = {
    "fence": "iron", "wall": "wall", "hedge": "hedge",
    "retaining_wall": "wall", "city_wall": "wall",
}

# `fence_type` refines a bare fence into one of the renderer's profiles. The values on the left
# are OSM's; the values on the right are the keys `FENCE_KINDS` in public/gl/props.js declares,
# and that is the whole point of this table — the baked `k` has to name a profile the client
# owns, or a run is drawn with whatever the fallback happens to be. An untagged fence is iron,
# because on this campus a bare `barrier=fence` is almost always the black park railing around
# a quad rather than a chain-link or a picket.
FENCE_TYPE = {
    "railing": "iron", "metal": "iron", "bar": "iron", "palisade": "iron", "spikes": "iron",
    "chain_link": "chain", "chain": "chain", "wire": "chain", "wire_mesh": "chain", "net": "chain",
    "wood": "wood", "split_rail": "rail", "post_and_rail": "rail", "pole": "rail",
    "brick": "wall", "concrete": "wall", "stone": "wall",
}
FENCE_HEIGHT_M = {"iron": 1.2, "chain": 1.8, "wood": 1.1, "rail": 0.9, "wall": 1.8, "hedge": 1.0}

# A height tag outside this band is a tagging error rather than a barrier. The floor is a
# kerb-height rail and the ceiling covers a stadium ball-stop net, which is the tallest thing
# anyone reasonably tags as a fence.
FENCE_HEIGHT_CLAMP_M = (0.4, 6.0)

MIN_FENCE_M = 4.0        # shorter than a parked car; the run is a mapping fragment, not a fence
MIN_STEPS_M = 2.0        # a single step mapped as a way, which the kerb geometry already covers
MIN_PITCH_M2 = 100.0     # a ten-metre square, below which "pitch" means a tagged sliver
SIMPLIFY_M = 1.5         # the same discipline build_roads uses; below a stride length nobody sees the bend
DEFAULT_STEPS_WIDTH_M = 1.6   # a flight two people can pass on, which is the campus standard
STEPS_WIDTH_CLAMP_M = (0.8, 12.0)

# Dedupe grid in world units. 0.1 units is one metre: two benches genuinely a metre apart do
# not exist, but the same bench imported twice from two sources lands within a metre of itself
# almost every time. Rounding the baked position to three decimals would be a centimetre grid,
# which is far too fine to catch a duplicate that moved slightly between imports.
DEDUPE_UNITS = 0.1

# Grid cell for the spatial indexes, in world units. Ten units is a hundred metres, which is
# the same bucket size build_greenery settled on and keeps each cell to a handful of members.
CELL = 10.0

# Cell and radius for the path-tangent lookup. Two units is twenty metres, so the 3x3 block
# around a prop always contains everything within the twenty-metre search radius. Beyond that a
# bench is out in the middle of a lawn and no path implies an orientation for it.
TANGENT_CELL = 2.0
TANGENT_RADIUS_UNITS = 1.5


def _tags(e) -> dict:
    """OSM elements sometimes carry a null tags key, so never trust `.get('tags', {})` alone."""
    t = e.get("tags")
    return t if isinstance(t, dict) else {}


def _geom_points(e) -> list[dict]:
    """Vertices with usable coordinates. A malformed vertex is dropped rather than raised on."""
    g = e.get("geometry")
    if not isinstance(g, list):
        return []
    return [p for p in g if isinstance(p, dict) and isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float))]


def _metres(raw) -> float | None:
    """Parse an OSM length tag. Feet-and-inches notation is refused rather than guessed at."""
    if raw is None:
        return None
    s = str(raw).strip().lower().removesuffix("m").strip()
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) and v > 0 else None


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _length_m(pts, mpu: float) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) * mpu


def _kind_for(tags: dict) -> str | None:
    """Map OSM tags onto PROP_KINDS, or return None so the element is skipped.

    Ordered most specific first. Three families are deliberately missing because another module
    already owns them and a second record here would double them in the bake: trees, street
    lamps and fountains belong to detail.py, and historic=monument belongs to monuments.py,
    which places the named landmarks by hand.
    """
    amenity = tags.get("amenity")
    if amenity == "bench":
        return "bench"
    if amenity in ("waste_basket", "waste_disposal"):
        return "bin"
    if amenity == "bicycle_parking":
        return "bikerack"
    if amenity == "shelter":
        return "shelter"
    if amenity == "post_box":
        return "postbox"
    if amenity == "drinking_water":
        return "drinkfountain"

    leisure = tags.get("leisure")
    if leisure == "picnic_table":
        return "picnic"
    if leisure == "playground":
        return "playground"

    if tags.get("emergency") == "fire_hydrant":
        return "hydrant"

    barrier = tags.get("barrier")
    if barrier == "bollard":
        return "bollard"
    if barrier in ("gate", "lift_gate", "swing_gate"):
        return "gate"

    highway = tags.get("highway")
    if highway == "bus_stop":
        return "busstop"

    if tags.get("tourism") == "artwork" or tags.get("historic") == "memorial":
        return "artwork"
    if tags.get("tourism") == "information":
        return "sign"

    man_made = tags.get("man_made")
    if man_made == "flagpole":
        return "flag"
    if man_made == "water_tower":
        return "watertower"
    if man_made == "chimney":
        return "chimney"
    if man_made == "mast":
        return "mast"
    if man_made == "tower" and tags.get("tower:type") == "communication":
        return "mast"
    if man_made == "planter":
        return "planter"

    return None


def _scale_for(kind: str, tags: dict) -> float:
    """Turn whatever the survey says about size into a multiplier on the nominal mesh."""
    if kind in NOMINAL_HEIGHT_M:
        h = _metres(tags.get("height"))
        if h is not None:
            # Clamped hard: a mis-tagged 300 m flagpole would otherwise dominate the skyline.
            return round(_clamp(h / NOMINAL_HEIGHT_M[kind], 0.4, 3.0), 3)
    if kind == "bikerack":
        try:
            cap = int(str(tags.get("capacity", "")).strip())
        except ValueError:
            cap = 0
        if cap > 0:
            # The rack mesh holds ten bikes, so capacity divided by ten is its length in racks.
            return round(_clamp(cap / 10.0, 0.6, 2.5), 3)
    return 1.0


def _spin(osm_id: str, x: float, z: float) -> float:
    """A stable pseudo-random heading for a prop with nothing to align to.

    Facing everything north is the giveaway of a generated world: a hundred identical benches
    in parade order. The seed mixes the OSM id, which survives the prop moving slightly between
    imports, with the baked position, which keeps two nodes sharing an id family from landing on
    the same angle. The last nine digits of the id are taken so the value stays exactly
    representable as a float and the bake is reproducible on any platform.
    """
    digits = "".join(c for c in str(osm_id) if c.isdigit())
    seed = float(int(digits[-9:])) if digits else 0.0
    return hash01(seed, x + z) * 360.0


def _dist2_to_segment(px, pz, x0, z0, x1, z1):
    """Squared distance from a point to a segment, and the segment's unit tangent."""
    dx, dz = x1 - x0, z1 - z0
    seg2 = dx * dx + dz * dz
    if seg2 < 1e-12:
        return (px - x0) ** 2 + (pz - z0) ** 2, None
    t = _clamp(((px - x0) * dx + (pz - z0) * dz) / seg2, 0.0, 1.0)
    cx, cz = x0 + dx * t, z0 + dz * t
    inv = 1.0 / math.sqrt(seg2)
    return (px - cx) ** 2 + (pz - cz) ** 2, (dx * inv, dz * inv)


def _tangent_index(frame: Frame, elements):
    """Bucket every road and path segment in the frame so a prop can find the way beside it.

    Built from whatever highways happen to be in `elements`. If the caller passes an extract
    with no ways in it the index is simply empty and every prop falls back to a hashed heading,
    which is a degraded look rather than a failure.

    Iterated through `_sorted_elements` for the same reason everything else in this module is.
    `_nearest_tangent` breaks a tie with a strict comparison, so the first segment inserted
    wins, and ties are routine: at a T-junction the closest point on both ways is the node they
    share. Taking Overpass's order would then give a bench beside that junction a heading that
    depends on which way the server happened to list first, and the tile hash would churn
    between builds that fetched the same data.
    """
    grid: dict[tuple[int, int], list] = {}
    for e in _sorted_elements(elements):
        if e.get("type") != "way" or _tags(e).get("highway") not in ROAD_WIDTH:
            continue
        geom = _geom_points(e)
        if len(geom) < 2:
            continue
        for run in clip_runs(frame, geom, frame.bbox):
            for i in range(len(run) - 1):
                (x0, z0), (x1, z1) = run[i], run[i + 1]
                if math.dist(run[i], run[i + 1]) < 1e-9:
                    continue
                seg = (x0, z0, x1, z1)
                for gx in range(int(min(x0, x1) // TANGENT_CELL), int(max(x0, x1) // TANGENT_CELL) + 1):
                    for gz in range(int(min(z0, z1) // TANGENT_CELL), int(max(z0, z1) // TANGENT_CELL) + 1):
                        grid.setdefault((gx, gz), []).append(seg)
    return grid


def _nearest_tangent(grid, x: float, z: float):
    """Unit tangent of the closest way segment within TANGENT_RADIUS_UNITS, or None."""
    if not grid:
        return None
    kx, kz = int(x // TANGENT_CELL), int(z // TANGENT_CELL)
    best_d2, best_t = TANGENT_RADIUS_UNITS ** 2, None
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            for seg in grid.get((kx + dx, kz + dz), ()):
                d2, tan = _dist2_to_segment(x, z, *seg)
                if tan is not None and d2 < best_d2:
                    best_d2, best_t = d2, tan
    return best_t


def _rotation(kind: str, osm_id: str, x: float, z: float, grid) -> float:
    """Heading in degrees, measured clockwise from +x (east) in the xz plane.

    Clockwise because z runs south, so atan2(z, x) already gives the sense the renderer wants
    and no sign flip has to be remembered on the client. Aligned props take the path's bearing,
    props that block a way take its perpendicular, and everything else spins on its hash.
    """
    tan = _nearest_tangent(grid, x, z) if kind in ALIGNED_KINDS or kind in CROSS_KINDS else None
    if tan is None:
        return _spin(osm_id, x, z) % 360.0
    heading = math.degrees(math.atan2(tan[1], tan[0]))
    if kind in CROSS_KINDS:
        return (heading + 90.0) % 360.0
    # Which side of the path the bench sits on is not recorded, and a whole avenue of benches
    # facing the same way is as obviously generated as an avenue facing north. A deterministic
    # coin flip on the hash puts roughly half of them on each side.
    if hash01(x, z) > 0.5:
        heading += 180.0
    return heading % 360.0


def _footprint_grid(buildings):
    """Bucket building rings for the inside-a-wall test. Accepts records or bare rings."""
    grid: dict[tuple[int, int], list] = {}
    for b in buildings or ():
        ring = b.get("p") if isinstance(b, dict) else b
        if not ring or len(ring) < 3:
            continue
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        for gx in range(int(min(xs) // CELL), int(max(xs) // CELL) + 1):
            for gz in range(int(min(zs) // CELL), int(max(zs) // CELL) + 1):
                grid.setdefault((gx, gz), []).append(ring)
    return grid


def _inside_building(grid, x: float, z: float) -> bool:
    return any(point_in_ring(x, z, r) for r in grid.get((int(x // CELL), int(z // CELL)), ()))


def _sorted_elements(elements):
    """Iterate in OSM id order so dedupe keeps the same winner on every run.

    The bake is content-addressed, so an input list that arrives in a different order from one
    fetch to the next would otherwise churn the tile hashes without changing the campus.
    """
    def key(e):
        try:
            return (str(e.get("type")), int(e.get("id", 0)))
        except (TypeError, ValueError):
            return (str(e.get("type")), 0)
    return sorted((e for e in elements if isinstance(e, dict)), key=key)


def _run_id(osm_id, i: int) -> str:
    """Ways clipped into several runs need distinct ids; the first run keeps the plain form."""
    return f"w{osm_id}" if i == 0 else f"w{osm_id}#{i}"


def build_props(frame: Frame, elements, buildings=None):
    """Returns a dict of baked prop layers keyed by layer name.

    Always returns all four keys. An empty layer is emitted as an empty list rather than
    omitted, because the client and the schema both index the layers by name and a missing key
    turns a campus with no fences into a crash instead of a campus with no fences.
    """
    mpu = frame.meters_per_unit
    tol = SIMPLIFY_M / mpu
    tangents = _tangent_index(frame, elements)
    footprints = _footprint_grid(buildings)

    props: list[dict] = []
    fences: list[dict] = []
    pitches: list[dict] = []
    steps: list[dict] = []
    seen: set[tuple[str, int, int]] = set()

    def add_point(pid: str, kind: str, x: float, z: float, tags: dict) -> None:
        # Dedupe on kind plus a one-metre grid. An imported node that also exists in the local
        # survey would otherwise stand as two benches back to back in the same spot.
        key = (kind, round(x / DEDUPE_UNITS), round(z / DEDUPE_UNITS))
        if key in seen:
            return
        if kind in GROUND_KINDS and _inside_building(footprints, x, z):
            return
        seen.add(key)
        props.append({
            "id": pid,
            "k": kind,
            # Three decimals is a millimetre at ten metres per unit: far past what anyone can
            # see, and the point at which the JSON stops depending on float formatting.
            "x": round(x, 3),
            "z": round(z, 3),
            # Rounded first, then wrapped. Wrapping first and rounding after turns 359.96 into
            # a clean 360.0, which is the same direction as 0 and outside the half-open range
            # the schema and the renderer both assume.
            "r": round(_rotation(kind, pid, x, z, tangents), 1) % 360.0,
            "s": round(_scale_for(kind, tags), 3),
        })

    for e in _sorted_elements(elements):
        tags = _tags(e)
        osm_id = e.get("id")
        if osm_id is None:
            continue
        etype = e.get("type")

        if etype == "node":
            lat, lng = e.get("lat"), e.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                continue
            kind = _kind_for(tags)
            if kind is None:
                continue
            # The whole frame for the landmarks, the detail bbox for the furniture. A bench out
            # in the South Farms is bytes that no player will ever be close enough to resolve,
            # whereas the water tower out there is a horizon feature people navigate by.
            box = frame.detail_bbox if kind in CLIPPED_KINDS else frame.bbox
            if not frame.in_bbox(lat, lng, box):
                continue
            x, z = frame.to_world(lat, lng)
            add_point(f"n{osm_id}", kind, x, z, tags)
            continue

        if etype != "way":
            continue

        geom = _geom_points(e)
        if len(geom) < 2:
            # A one-node way, which Overpass does produce after a bad edit. Skipped quietly.
            continue

        barrier = BARRIER_KIND.get(tags.get("barrier"))
        if barrier == "iron":
            # A bare `barrier=fence` becomes iron railing; `fence_type` refines it into one of
            # the renderer's other profiles when the surveyor bothered to say. Only a fence is
            # refined: a `fence_type` on a wall or a hedge is a tagging accident and following
            # it would turn a stone boundary into chain-link.
            barrier = FENCE_TYPE.get(tags.get("fence_type"), "iron")
        if barrier:
            # Fences are the highest-value linear detail on the map — they are what stops one
            # lawn bleeding into the next — so they are kept across the whole frame rather than
            # only in the core.
            for i, run in enumerate(clip_runs(frame, geom, frame.bbox)):
                if _length_m(run, mpu) < MIN_FENCE_M:
                    continue
                pts = simplify(run, tol)
                if len(pts) < 2:
                    continue
                h_m = _metres(tags.get("height")) or FENCE_HEIGHT_M[barrier]
                fences.append({
                    "id": _run_id(osm_id, i),
                    "k": barrier,
                    # Heights are world units like everything else, so a 1.2 m fence is 0.12.
                    "h": round(_clamp(h_m, *FENCE_HEIGHT_CLAMP_M) / mpu, 3),
                    "p": [[round(x, 3), round(z, 3)] for x, z in pts],
                })
            continue

        if tags.get("highway") == "steps":
            for i, run in enumerate(clip_runs(frame, geom, frame.bbox)):
                if _length_m(run, mpu) < MIN_STEPS_M:
                    continue
                pts = simplify(run, tol)
                if len(pts) < 2:
                    continue
                w_m = _metres(tags.get("width")) or DEFAULT_STEPS_WIDTH_M
                steps.append({
                    "id": _run_id(osm_id, i),
                    "w": round(_clamp(w_m, *STEPS_WIDTH_CLAMP_M) / mpu, 3),
                    "p": [[round(x, 3), round(z, 3)] for x, z in pts],
                })
            continue

        if tags.get("leisure") == "pitch":
            # Pitches get the full frame rather than the detail bbox: they are large flat
            # colour fields that read from a long way off, and the area gate below already
            # throws away the slivers. leisure=track is left to detail.build_lawns, which
            # already bakes it as a "field" lawn; drawing it here as well would z-fight.
            lat, lng = centroid_latlng(geom)
            if not frame.in_bbox(lat, lng):
                continue
            ring = simplify(close_ring_from_geom(frame, geom), tol)
            if len(ring) < 3 or ring_area_m2(ring, mpu) < MIN_PITCH_M2:
                continue
            raw = str(tags.get("sport", "")).split(";")[0].strip().lower()
            sport = "".join(c for c in raw if c.isalnum() or c == "_") or "multi"
            pitches.append({
                "id": f"w{osm_id}",
                "sport": sport,
                "p": [[round(x, 3), round(z, 3)] for x, z in ensure_ccw(ring)],
            })
            continue

        # Anything left that maps to a point kind was surveyed as an area: a playground, a
        # bike shelter, a piece of artwork on a plinth. One prop at the centroid is the honest
        # reading of that, since we have no mesh that stretches to fill a ring.
        kind = _kind_for(tags)
        if kind is None:
            continue
        lat, lng = centroid_latlng(geom)
        box = frame.detail_bbox if kind in CLIPPED_KINDS else frame.bbox
        if not frame.in_bbox(lat, lng, box):
            continue
        x, z = frame.to_world(lat, lng)
        add_point(f"w{osm_id}", kind, x, z, tags)

    # Sorted by id so the layer order depends on the survey and not on dict iteration.
    props.sort(key=lambda p: p["id"])
    fences.sort(key=lambda f: f["id"])
    pitches.sort(key=lambda p: p["id"])
    steps.sort(key=lambda s: s["id"])
    return {"props": props, "fences": fences, "pitches": pitches, "steps": steps}


# ---------------------------------------------------------------------------
# Generated furniture
# ---------------------------------------------------------------------------

# What a surveyed campus looks like versus what a real one does.
#
# OpenStreetMap has 201 benches for the whole of Urbana-Champaign. The real campus has one
# every fifty metres along every quad path, a bin at every junction, and a bike rack outside
# every door. The survey is not wrong; it is a survey, and nobody has walked every path with a
# phone. Baking only what is surveyed gives a campus with beautifully accurate buildings
# standing on empty ground, which reads as unfinished rather than as accurate.
#
# So the pipeline generates the rest, exactly as it already generates street trees and lamps
# from the path network (`detail.build_greenery`). The rules below are the ones a grounds
# department actually follows, and every placement is derived from a hash of its own position,
# so two builds of the same data produce the same campus and the pack hash stays meaningful.
#
# A generated prop is never placed where a surveyed one already is: `merge_props` drops any
# generated placement within a few metres of a real one, so the survey always wins and the
# generator only fills silence.

# Metres between generated benches along a footway. Fifty is the spacing that reads as "there
# is somewhere to sit" without turning a path into a waiting room.
BENCH_SPACING_M = 52.0
# How far off the path centreline a bench sits, in metres. Two metres clears a three-metre walk
# and leaves the bench on the grass rather than in the way.
BENCH_OFFSET_M = 2.1
# Metres between generated bins. Sparser than benches: a bin every path is litter management,
# a bin every fifty metres is a landfill.
BIN_SPACING_M = 118.0
# Bike racks cluster at buildings, not along paths. This is the distance from a footprint edge
# at which one is placed.
RACK_OFFSET_M = 4.5
# Only buildings above this footprint area get a generated rack. A shed does not have a rack.
RACK_MIN_AREA_M2 = 900.0


def _ring_area_and_centroid(ring):
    """Shoelace area and centroid of a closed ring, in whatever units the ring is in."""
    a = 0.0
    cx = 0.0
    cz = 0.0
    n = len(ring)
    for i in range(n):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % n]
        cross = x0 * z1 - x1 * z0
        a += cross
        cx += (x0 + x1) * cross
        cz += (z0 + z1) * cross
    if abs(a) < 1e-12:
        return 0.0, ring[0][0], ring[0][1]
    return a / 2.0, cx / (3.0 * a), cz / (3.0 * a)


def generate_props(frame: Frame, roads, lawns, buildings):
    """Furniture the survey does not have, placed by the rules a grounds department uses.

    Takes the same inputs `detail.build_greenery` does, and for the same reason: the footway
    network is where people walk, the lawns are where furniture is allowed to stand, and the
    building footprints are where it must not.
    """
    mpu = frame.meters_per_unit
    walks = [r["p"] for r in roads if r["f"]]
    lawn_rings = [l["p"] for l in lawns if l["k"] in ("lawn", "field")]
    footprints = [b["p"] for b in buildings]

    # The same grid-bucketed containment test build_greenery uses. Thousands of rings against
    # tens of thousands of candidate points is quadratic without it.
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

    out = []

    def emit(kind, x, z, heading):
        # Never inside a building, and never off the pack.
        if hit(bld_grid, x, z):
            return
        out.append({
            "id": f"g{kind[0]}{int(round(x * 1000))}_{int(round(z * 1000))}",
            "k": kind,
            "x": round(x, 3),
            "z": round(z, 3),
            # Same wrap-after-round rule as the surveyed path above.
            "r": round(heading, 1) % 360.0,
            "s": 1.0,
        })

    # Benches and bins along the footways, on the grass side, facing the path.
    for pts in walks:
        for x, z, tx, tz in walk(pts, BENCH_SPACING_M / mpu):
            nx, nz = -tz, tx
            # A bench faces the path, so its long axis runs along it: the tangent heading.
            heading = math.degrees(math.atan2(tx, -tz))
            for side in (1, -1):
                px = x + nx * (BENCH_OFFSET_M / mpu) * side
                pz = z + nz * (BENCH_OFFSET_M / mpu) * side
                # Only where there is actually grass to stand on, and only on one side, chosen
                # by the position hash so a path does not become an avenue of facing benches.
                if not hit(lawn_grid, px, pz):
                    continue
                if hash01(px * 1.7, pz * 2.3) > 0.42:
                    continue
                emit("bench", px, pz, heading + (0 if side > 0 else 180))
                break
        for x, z, tx, tz in walk(pts, BIN_SPACING_M / mpu):
            nx, nz = -tz, tx
            px = x + nx * (BENCH_OFFSET_M / mpu)
            pz = z + nz * (BENCH_OFFSET_M / mpu)
            if hit(lawn_grid, px, pz) and hash01(pz * 3.7, px * 1.1) > 0.35:
                emit("bin", px, pz, hash01(px, pz) * 360.0)

    # One bike rack per substantial building, on the side facing the nearest footway. Racks are
    # the single most characteristic object on an American campus and OSM has 288 of them for
    # nine thousand buildings.
    walk_points = [pt for pts in walks for pt in pts]
    for b in buildings:
        ring = b["p"]
        area_units, cx, cz = _ring_area_and_centroid(ring)
        if abs(area_units) * mpu * mpu < RACK_MIN_AREA_M2:
            continue
        # Nearest path point, searched over a subsample: exact is not worth the time here, and
        # the subsample is deterministic.
        best = None
        best_d = 1e18
        for pt in walk_points[:: max(1, len(walk_points) // 4000)]:
            d = (pt[0] - cx) ** 2 + (pt[1] - cz) ** 2
            if d < best_d:
                best_d, best = d, pt
        if best is None or best_d > (140.0 / mpu) ** 2:
            continue
        dx, dz = best[0] - cx, best[1] - cz
        length = math.hypot(dx, dz)
        if length < 1e-6:
            continue
        dx, dz = dx / length, dz / length
        # Step out from the centroid towards the path until we leave the footprint, then a
        # little further, which lands the rack just outside the wall the door is in.
        step = 1.0 / mpu
        px, pz = cx, cz
        for _ in range(400):
            px += dx * step
            pz += dz * step
            if not point_in_ring(px, pz, ring):
                break
        px += dx * (RACK_OFFSET_M / mpu)
        pz += dz * (RACK_OFFSET_M / mpu)
        emit("bikerack", px, pz, math.degrees(math.atan2(dz, dx)) + 90.0)

    out.sort(key=lambda p: p["id"])
    return out


# How close a generated prop may come to a surveyed one before it is dropped, in metres. Twelve
# is a little over a bench length: close enough that two would read as a pair placed on purpose
# rather than as a duplicate, and far enough that a surveyed bench does not suppress the whole
# path it sits on.
MERGE_RADIUS_M = 12.0


def merge_props(surveyed, generated, mpu: float):
    """Surveyed props win; generated ones fill the silence between them.

    Bucketed by a grid at the merge radius, so this stays linear in the number of props rather
    than quadratic. At a few thousand of each the difference is a second per build, which is
    the sort of thing that quietly makes a pipeline unpleasant to iterate on.
    """
    r = MERGE_RADIUS_M / mpu
    grid: dict[tuple[int, int], list] = {}
    for p in surveyed:
        grid.setdefault((int(p["x"] // r), int(p["z"] // r)), []).append(p)

    kept = []
    for g in generated:
        gx, gz = int(g["x"] // r), int(g["z"] // r)
        clash = False
        for i in (gx - 1, gx, gx + 1):
            for j in (gz - 1, gz, gz + 1):
                for p in grid.get((i, j), ()):
                    if p["k"] != g["k"]:
                        continue
                    if (p["x"] - g["x"]) ** 2 + (p["z"] - g["z"]) ** 2 < r * r:
                        clash = True
                        break
                if clash:
                    break
            if clash:
                break
        if not clash:
            kept.append(g)
            grid.setdefault((gx, gz), []).append(g)
    return sorted(surveyed + kept, key=lambda p: p["id"])
