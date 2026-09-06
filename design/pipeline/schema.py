"""Structural validation of a built pack (CI `check` mode never needs the network)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .config import MATERIAL_IDS


def validate(out_dir: Path, monument_ids: set[str]) -> list[str]:
    errors: list[str] = []
    idx_path = out_dir / "index.json"
    if not idx_path.exists():
        return [f"missing {idx_path}"]
    index = json.loads(idx_path.read_text())
    meta = index.get("meta", {})
    if meta.get("schema") != 2:
        errors.append("index.meta.schema must be 2")
    for k in ("origin", "metersPerUnit", "vscale", "tileUnits", "bbox", "coreBbox", "sources", "hash"):
        if k not in meta:
            errors.append(f"index.meta missing {k}")
    ids = {m["id"] for m in index.get("monuments", [])}
    if ids != monument_ids:
        errors.append(f"monument ids differ from the pack: missing {sorted(monument_ids - ids)}, extra {sorted(ids - monument_ids)}")
    for mo in index.get("monuments", []):
        if not mo.get("kind") or not mo.get("poly") or len(mo["poly"]) < 3:
            errors.append(f"monument {mo.get('id')} lacks kind/poly")
    seen = set()
    for t in index.get("tiles", []):
        p = out_dir / t["file"]
        if not p.exists():
            errors.append(f"tile file missing: {t['file']}")
            continue
        body = p.read_bytes()
        if hashlib.sha256(body).hexdigest() != t["sha256"]:
            errors.append(f"tile sha256 mismatch: {t['file']}")
        if len(body) != t["bytes"]:
            errors.append(f"tile byte count mismatch: {t['file']}")
        key = (t["x"], t["z"])
        if key in seen:
            errors.append(f"duplicate tile {key}")
        seen.add(key)
        doc = json.loads(body)
        for b in doc.get("buildings", []):
            ring = b.get("p", [])
            if len(ring) < 3:
                errors.append(f"{t['file']}: building {b.get('id')} ring too short")
                continue
            a = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
            if a <= 0:
                errors.append(f"{t['file']}: building {b.get('id')} ring not CCW")
            if not (0.2 < b.get("h", 0) <= 15):
                errors.append(f"{t['file']}: building {b.get('id')} height {b.get('h')} out of (0.2, 15]")
            if b.get("m") not in MATERIAL_IDS:
                errors.append(f"{t['file']}: building {b.get('id')} material {b.get('m')} unknown")
            if b.get("r") not in ("f", "g", "h", "m", "d", "s"):
                errors.append(f"{t['file']}: building {b.get('id')} roof {b.get('r')} unknown")
            cx = sum(p[0] for p in ring) / len(ring)
            cz = sum(p[1] for p in ring) / len(ring)
            x0, z0, x1, z1 = t["bbox"]
            if not (x0 - 1e-6 <= cx <= x1 + 1e-6 and z0 - 1e-6 <= cz <= z1 + 1e-6):
                errors.append(f"{t['file']}: building {b.get('id')} centroid outside its tile")
    # Recompute the index hash.
    want = meta.get("hash")
    m2 = {k: v for k, v in meta.items() if k not in ("hash", "builtAt")}
    from .bake import _canon
    have = hashlib.sha256(_canon({"meta": m2, "monuments": index.get("monuments", []), "tiles": [t["sha256"] for t in index.get("tiles", [])]})).hexdigest()
    if want != have:
        errors.append("index.meta.hash does not match its own content (edited by hand?)")
    return errors
