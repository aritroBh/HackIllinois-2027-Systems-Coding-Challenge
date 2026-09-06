#!/usr/bin/env python3
"""
Compatibility shim: the bake now lives in the `design/pipeline` package.

    python3 design/build-campus.py --pack DIR            → python3 -m design.pipeline build --pack DIR
    python3 design/build-campus.py --pack DIR --check    → python3 -m design.pipeline check --pack DIR
    python3 design/build-campus.py --pack DIR --fetch    → fetch, then build
    python3 design/build-campus.py --pack DIR --core-only
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from design.pipeline.__main__ import main  # noqa: E402


def translate(argv):
    pack = None
    flags = set()
    passthrough = []
    it = iter(argv)
    for a in it:
        if a == "--pack":
            pack = next(it, None)
        elif a in ("--check", "--fetch", "--core-only", "--no-lidar", "--legacy-cache", "--ci"):
            flags.add(a)
        else:
            passthrough.append(a)
    common = ["--pack", pack] if pack else []
    if "--fetch" in flags:
        rc = main(["fetch"] + common)
        if rc:
            return rc
    if "--check" in flags:
        return main(["check"] + common + [f for f in ("--ci", "--no-lidar", "--legacy-cache") if f in flags])
    return main(["build"] + common + [f for f in ("--core-only", "--no-lidar", "--legacy-cache") if f in flags] + passthrough)


if __name__ == "__main__":
    sys.exit(translate(sys.argv[1:]))
