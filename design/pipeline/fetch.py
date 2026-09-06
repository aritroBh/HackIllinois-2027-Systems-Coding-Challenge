"""
Source fetch + cache.

Overpass is queried per sub-box of the pack bbox (a 4×4 grid by default) with the
query templates in `queries/`, retrying with backoff on 429/504. Each response is cached
under design/osm/cache/<query>_<row>_<col>.json (gitignored) and listed in
design/osm/manifest.json with the URL, the query hash and the response sha256, so a build
can say exactly what it was built from.

`load(query)` returns the merged, deduplicated element list for a query from the cache;
when no sub-box files exist it falls back to the legacy single-file design/osm/<query>.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import CACHE_DIR, OSM_DIR, QUERY_DIR, ROOT

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
MANIFEST = OSM_DIR / "manifest.json"
QUERIES = ("buildings", "extra", "detail", "props")

FETCH_HINT = """Refresh the cache with:

  python3 -m design.pipeline fetch --pack content/<pack>

(one POST per query per sub-box, cached under design/osm/cache/)."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sub_boxes(bbox, grid: int):
    s, w, n, e = bbox
    dlat = (n - s) / grid
    dlng = (e - w) / grid
    for r in range(grid):
        for c in range(grid):
            yield r, c, (s + r * dlat, w + c * dlng, s + (r + 1) * dlat, w + (c + 1) * dlng)


def _post(query_text: str, out: Path, attempts: int = 4) -> dict:
    fd, tmp = tempfile.mkstemp(dir=out.parent, suffix=".part")
    os.close(fd)
    delay = 20
    for attempt in range(1, attempts + 1):
        try:
            subprocess.run(
                ["curl", "-sS", "-f", "-X", "POST", "--data-binary", query_text, OVERPASS_URL, "-o", tmp],
                check=True,
            )
            with open(tmp) as fh:
                data = json.load(fh)
            if "elements" not in data:
                raise ValueError(f"no 'elements' in response: {json.dumps(data)[:200]}")
            if data.get("remark"):
                print(f"  overpass remark: {data['remark']}", file=sys.stderr)
            os.replace(tmp, out)
            return data
        except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as err:
            if attempt == attempts:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise RuntimeError(f"fetch failed after {attempts} attempts: {err}") from err
            print(f"  retry {attempt}/{attempts - 1} in {delay}s ({err})", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 120)
    raise RuntimeError("unreachable")


def fetch(bbox, grid: int = 4, queries=QUERIES, pause: float = 3.0) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    manifest = _read_manifest_raw()
    files = {e["file"]: e for e in manifest.get("files", [])}
    for name in queries:
        tpl = (QUERY_DIR / f"{name}.overpass.tpl").read_text()
        for r, c, box in sub_boxes(bbox, grid):
            out = CACHE_DIR / f"{name}_{r}_{c}.json"
            q = tpl.replace("{bbox}", ",".join(f"{v:.5f}" for v in box))
            qhash = hashlib.sha256(q.encode()).hexdigest()
            prev = files.get(out.name)
            if out.exists() and prev and prev.get("query_sha256") == qhash:
                print(f"cached  {out.name}")
                continue
            print(f"fetching {name} [{r},{c}] {box} ...", flush=True)
            data = _post(q, out)
            files[out.name] = {
                "file": out.name, "url": OVERPASS_URL, "query": f"{name}.overpass.tpl", "bbox": list(box),
                "query_sha256": qhash, "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bytes": os.path.getsize(out), "sha256": sha256_file(out), "elements": len(data["elements"]),
            }
            print(f"  {files[out.name]['bytes'] / 1024:.0f} KB, {files[out.name]['elements']} elements")
            _write_manifest({"source": "OpenStreetMap contributors (ODbL 1.0)", "files": sorted(files.values(), key=lambda e: e["file"])})
            time.sleep(pause)
    print(f"wrote {MANIFEST.relative_to(ROOT)}")


def _read_manifest_raw() -> dict:
    if not MANIFEST.exists():
        return {}
    return json.loads(MANIFEST.read_text())


def _write_manifest(doc: dict) -> None:
    MANIFEST.write_text(json.dumps(doc, indent=1))


def read_manifest() -> dict[str, dict]:
    return {e["file"]: e for e in _read_manifest_raw().get("files", [])}


def load(name: str) -> list[dict]:
    """Merged, deduplicated, sorted elements for a query from the sub-box cache (or legacy file)."""
    parts = sorted(CACHE_DIR.glob(f"{name}_*_*.json")) if CACHE_DIR.exists() else []
    if not parts:
        legacy = OSM_DIR / f"{name}.json"
        if not legacy.exists():
            sys.exit(f"missing {legacy} and no {CACHE_DIR}/{name}_*.json\n\n{FETCH_HINT}")
        parts = [legacy]
    seen: set[tuple[str, int]] = set()
    elements: list[dict] = []
    for p in parts:
        with open(p) as fh:
            for e in json.load(fh)["elements"]:
                k = (e.get("type", ""), e.get("id", 0))
                if k in seen:
                    continue
                seen.add(k)
                elements.append(e)
    elements.sort(key=lambda e: (e.get("type", ""), e.get("id", 0)))
    return elements


def load_legacy(name: str) -> list[dict]:
    """The pre-pipeline single-file cache (design/osm/<name>.json), for reproducing old bakes."""
    legacy = OSM_DIR / f"{name}.json"
    if not legacy.exists():
        sys.exit(f"missing {legacy}\n\n{FETCH_HINT}")
    with open(legacy) as fh:
        elements = json.load(fh)["elements"]
    elements.sort(key=lambda e: (e.get("type", ""), e.get("id", 0)))
    return elements


def sources() -> list[dict]:
    manifest = read_manifest()
    fetched = sorted(e["fetched_at"] for e in manifest.values() if e.get("fetched_at"))
    osm = {"name": "OpenStreetMap contributors, via Overpass API", "licence": "ODbL 1.0"}
    if fetched:
        osm["fetchedAt"] = fetched[-1]
    if manifest:
        h = hashlib.sha256("".join(sorted(e["sha256"] for e in manifest.values())).encode()).hexdigest()
        osm["sha256"] = h
    return [osm]
