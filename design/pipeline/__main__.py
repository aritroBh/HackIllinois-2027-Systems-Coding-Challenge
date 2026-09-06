"""
Campus pipeline CLI.

  python3 -m design.pipeline build --pack content/hackillinois-2027 [--core-only] [--no-lidar] [--legacy-cache]
  python3 -m design.pipeline fetch --pack content/hackillinois-2027 [--grid 4]
  python3 -m design.pipeline check --pack content/hackillinois-2027 [--ci]
  python3 -m design.pipeline stats --pack content/hackillinois-2027

`check` validates the committed pack offline (schema, per-tile sha256, monument ids, index
hash); without `--ci` it also rebuilds to a scratch directory from the cache and compares
`meta.hash`. `--core-only` builds the core bbox only (the legacy frame) and is the default
when the whole-campus cache has not been fetched yet.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from . import bake, fetch as F, schema
from .config import ROOT, configure


def _pack_dir(arg: str) -> Path:
    p = Path(arg)
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    if not p.is_dir():
        sys.exit(f"pack directory not found: {p}")
    return p


def cmd_build(args) -> int:
    pack = configure(_pack_dir(args.pack), core_only=args.core_only)
    out_dir = Path(args.out).resolve() if args.out else pack.dir / "campus"
    model = bake.assemble(pack, strict=not args.core_only or args.strict, legacy_cache=args.legacy_cache, use_lidar=not args.no_lidar)
    index = bake.write_tiled(model, out_dir, core_only=args.core_only)
    legacy = bake.legacy_doc(model)
    bake.write_legacy(legacy, out_dir.parent / "campus.json")
    bake.report(index, legacy, out_dir, pack.frame.meters_per_unit)
    return 0


def cmd_fetch(args) -> int:
    pack = configure(_pack_dir(args.pack))
    F.fetch(pack.frame.bbox, grid=args.grid)
    return 0


def cmd_check(args) -> int:
    pack = configure(_pack_dir(args.pack))
    out_dir = pack.dir / "campus"
    errors = schema.validate(out_dir, {m["id"] for m in pack.monuments})
    legacy_path = pack.dir / "campus.json"
    if legacy_path.exists():
        committed = json.loads(legacy_path.read_text())
        if committed["meta"].get("hash") != bake.content_hash(committed):
            errors.append("campus.json meta.hash does not match its own content (edited by hand?)")
    else:
        errors.append("campus.json missing")
    for e in errors:
        print(f"check: {e}", file=sys.stderr)
    if errors:
        return 1
    print(f"check: OK — {out_dir.relative_to(ROOT)} validates ({json.loads((out_dir / 'index.json').read_text())['meta']['hash'][:12]})")
    if args.ci:
        return 0
    # Full mode: rebuild to scratch and compare hashes.
    committed_index = json.loads((out_dir / "index.json").read_text())
    core_only = bool(committed_index["meta"].get("coreOnly"))
    pack = configure(pack.dir, core_only=core_only)
    with tempfile.TemporaryDirectory() as tmp:
        model = bake.assemble(pack, strict=True, legacy_cache=args.legacy_cache, use_lidar=not args.no_lidar)
        rebuilt = bake.write_tiled(model, Path(tmp) / "campus", core_only=core_only)
        legacy = bake.legacy_doc(model)
    if rebuilt["meta"]["hash"] != committed_index["meta"]["hash"]:
        print(f"check: FAIL — committed index {committed_index['meta']['hash'][:12]} != rebuilt {rebuilt['meta']['hash'][:12]}; "
              f"rebuild with: python3 -m design.pipeline build --pack {args.pack}", file=sys.stderr)
        return 1
    committed_legacy = json.loads(legacy_path.read_text())
    if legacy["meta"]["hash"] != committed_legacy["meta"]["hash"]:
        print(f"check: FAIL — campus.json {committed_legacy['meta']['hash'][:12]} != rebuilt {legacy['meta']['hash'][:12]}", file=sys.stderr)
        return 1
    print(f"check: OK — rebuild matches ({rebuilt['meta']['hash'][:12]})")
    return 0


def cmd_stats(args) -> int:
    pack = configure(_pack_dir(args.pack))
    index = json.loads((pack.dir / "campus" / "index.json").read_text())
    total = sum(t["bytes"] for t in index["tiles"])
    print(f"{index['meta']['pack']}: {len(index['tiles'])} tiles, {total / 1024:.0f} KB raw, hash {index['meta']['hash'][:12]}")
    print(f"  counts  {index['meta']['counts']}")
    print(f"  heights {index['meta']['heights']}")
    big = sorted(index["tiles"], key=lambda t: -t["bytes"])[:5]
    for t in big:
        print(f"  tile ({t['x']:>3},{t['z']:>3}) {t['bytes'] / 1024:5.0f} KB  buildings {t['counts']['buildings']:4d}  trees {t['counts']['trees']:4d}  maxH {t['maxH']}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m design.pipeline", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--pack", default=str(ROOT / "content" / "hackillinois-2027"))
    b = sub.add_parser("build", parents=[common])
    b.add_argument("--core-only", action="store_true", help="build campus.coreBbox only")
    b.add_argument("--no-lidar", action="store_true")
    b.add_argument("--legacy-cache", action="store_true", help="read design/osm/<query>.json instead of the sub-box cache")
    b.add_argument("--strict", action="store_true")
    b.add_argument("--out", default=None, help="override the campus/ output directory")
    f = sub.add_parser("fetch", parents=[common])
    f.add_argument("--grid", type=int, default=4)
    c = sub.add_parser("check", parents=[common])
    c.add_argument("--ci", action="store_true", help="validate the committed pack only; never rebuild or fetch")
    c.add_argument("--no-lidar", action="store_true")
    c.add_argument("--legacy-cache", action="store_true")
    sub.add_parser("stats", parents=[common])
    args = ap.parse_args(argv)
    return {"build": cmd_build, "fetch": cmd_fetch, "check": cmd_check, "stats": cmd_stats}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
