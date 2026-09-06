"""Resolve each pack monument to a footprint (by name or proximity) and attach crown recipes."""
from __future__ import annotations

import math
import sys

from .config import M_PER_DEG_LAT, Frame


def attach_monuments(frame: Frame, buildings: list[dict], monuments: list[dict], crowns: dict, strict: bool = True) -> list[dict]:
    # A name maps to its LARGEST footprint: OSM often repeats a building's name on an
    # annex or an entrance canopy, and the monument must land on the main mass.
    by_name: dict[str, int] = {}
    for i, b in enumerate(buildings):
        if b["n"] and (b["n"] not in by_name or buildings[by_name[b["n"]]]["_area"] < b["_area"]):
            by_name[b["n"]] = i
    out = []
    claimed: set[int] = set()
    for mon in monuments:
        idx = None
        if not mon.get("synth"):
            if mon.get("match"):
                idx = by_name.get(mon["match"])
                if idx is None:
                    cands = [j for name, j in by_name.items() if name.startswith(mon["match"])]
                    if cands:
                        idx = max(cands, key=lambda j: buildings[j]["_area"])
            if idx is None and mon.get("at"):
                lat, lng = mon["at"]
                best, best_d = None, 1e9
                for j, b in enumerate(buildings):
                    if b["_area"] < 400 or j in claimed:
                        continue
                    d = math.hypot((b["_lat"] - lat) * M_PER_DEG_LAT, (b["_lng"] - lng) * frame.m_per_deg_lng)
                    if d < best_d:
                        best, best_d = j, d
                if best is not None and best_d < 55.0:
                    idx = best
        if idx is not None and idx in claimed:
            idx = None
        rec = {k: mon.get(k, "") for k in ("id", "short", "name", "kind", "venue", "blurb", "mat")}
        if idx is not None:
            b = buildings[idx]
            rec["poly"] = b["p"]
            rec["h"] = b["h"]
            if mon.get("height"):
                rec["h"] = round(float(mon["height"]) / frame.meters_per_unit, 3)
                b["hsrc"] = "hand"
            cx = sum(p[0] for p in b["p"]) / len(b["p"])
            cz = sum(p[1] for p in b["p"]) / len(b["p"])
            rec["c"] = [round(cx, 3), round(cz, 3)]
            rec["src"] = "osm"
            rec["hsrc"] = b.get("hsrc", "default")
            rec["parts"] = b.get("parts", [])
            claimed.add(idx)
            b["_monument"] = mon["id"]
        elif mon.get("at"):
            dims = mon.get("synth") or (24, 24)
            w = dims[0] / frame.meters_per_unit / 2
            d = dims[1] / frame.meters_per_unit / 2
            h = (dims[2] if len(dims) > 2 else 12.0) / frame.meters_per_unit
            x, z = frame.to_world(*mon["at"])
            rec["poly"] = [(x - w, z - d), (x + w, z - d), (x + w, z + d), (x - w, z + d)]
            rec["h"] = round(h, 3)
            rec["c"] = [round(x, 3), round(z, 3)]
            rec["src"] = "synth"
            rec["hsrc"] = "hand"
            rec["parts"] = []
        else:
            print(f"  ! unresolved monument: {mon['id']}", file=sys.stderr)
            continue
        if mon["id"] in crowns:
            rec["crown"] = crowns[mon["id"]]
        out.append(rec)
    if len(out) != len(monuments):
        missing = {m["id"] for m in monuments} - {m["id"] for m in out}
        msg = f"only {len(out)}/{len(monuments)} monuments resolved; missing: {', '.join(sorted(missing))}"
        if strict:
            sys.exit(msg)
        print(f"  ! {msg}", file=sys.stderr)
    return out
