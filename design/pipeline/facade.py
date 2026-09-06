"""Facade material `m` and optional colour `c` (plan §B1)."""
from __future__ import annotations

import re

from .config import FACADE_BY_TYPE, MATERIAL_IDS

TAG_MATERIAL = {
    "brick": "brick", "stone": "limestoneGrey", "limestone": "limestoneBuff", "sandstone": "limestoneBuff",
    "glass": "glass", "concrete": "concreteGrey", "metal": "metalPanel", "steel": "metalPanel",
    "wood": "clapboard", "timber": "clapboard", "plaster": "precast", "stucco": "precast",
    "cement_block": "concreteGrey", "vinyl": "clapboard", "terracotta": "terracotta",
}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
NAMED = {"white": "#f2efe6", "red": "#8b3a2f", "brown": "#6b4a32", "grey": "#8a8d94", "gray": "#8a8d94",
         "beige": "#d6c9ad", "tan": "#cdb58a", "yellow": "#d8c26a", "black": "#2a2b30", "blue": "#6d86a8", "green": "#5f7a5a"}


def facade_for(tags: dict, btype: str, h_m: float, name: str | None) -> tuple[str, str | None]:
    mat = tags.get("building:material")
    m = TAG_MATERIAL.get(str(mat).lower()) if mat else None
    if not m:
        # No tag, so guess from era and use. The two rules that earn their keep
        # on this campus: anything tall and recent is a curtain wall, and the
        # pre-1930 university buildings are brick except for the ceremonial ones
        # (libraries, auditoria, named halls), which are limestone-faced.
        # Everything else falls to the type table.
        start = tags.get("start_date") or tags.get("construction_date") or ""
        year = int(start[:4]) if start[:4].isdigit() else None
        if year and year >= 1990 and h_m > 30:
            m = "glass"
        elif btype == "university" and year and year < 1930:
            m = "limestoneBuff" if (name or "").lower().endswith(("library", "auditorium", "hall")) else "brick"
        else:
            m = FACADE_BY_TYPE.get(btype, "brick")
    if m not in MATERIAL_IDS:
        m = "brick"
    c = None
    col = tags.get("building:colour")
    if col:
        col = str(col).strip().lower()
        if HEX.match(col):
            c = col
        elif col in NAMED:
            c = NAMED[col]
    return m, c
