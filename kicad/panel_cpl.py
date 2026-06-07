#!/usr/bin/env python3
"""JLCPCB CPL for the KiKit panel, with UNIQUE per-instance designators.

The panel is N copies of the board, so KiKit leaves N footprints sharing each refdes (SW1, U2,
...). JLCPCB assembly needs every placement to have a unique designator, so the i-th copy of REF
becomes REF (i==1) or REF-i. Positions are the pad CENTROID (same convention as jlcpcb_cpl.py).
KiKit's frame fiducials / tooling holes are skipped (only real components -- doorbell_design.REF).

Run with KiCad's bundled python (owns pcbnew); see build.sh.
"""
import csv, os
import pcbnew
from doorbell_design import REF

HERE = os.path.dirname(os.path.abspath(__file__))
PANEL = os.path.join(HERE, "fab", "doorbell-panel.kicad_pcb")
OUT = os.path.join(HERE, "fab", "doorbell-panel-cpl.csv")

VALID = {r for r in REF.values() if not r.startswith("#")}   # real component refdes
HANDSOLDER = set()
ROT_FIX = {}


def MM(v):
    return round(pcbnew.ToMM(v), 4)


b = pcbnew.LoadBoard(PANEL)
rows, seen = [], {}
for f in b.GetFootprints():
    ref = f.GetReference()
    if ref not in VALID or ref in HANDSOLDER:
        continue
    xs = [p.GetPosition().x for p in f.Pads()]
    ys = [p.GetPosition().y for p in f.Pads()]
    if not xs:
        continue
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    rot = (f.GetOrientationDegrees() + ROT_FIX.get(ref, 0)) % 360
    layer = "Bottom" if f.IsFlipped() else "Top"
    seen[ref] = seen.get(ref, 0) + 1
    uref = ref if seen[ref] == 1 else f"{ref}-{seen[ref]}"
    rows.append((uref, MM(cx), -MM(cy), layer, rot))   # JLCPCB Y-up

rows.sort(key=lambda r: r[0])
with open(OUT, "w", newline="") as o:
    w = csv.writer(o)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for ref, x, y, layer, rot in rows:
        w.writerow([ref, f"{x:.4f}", f"{y:.4f}", layer, f"{rot:g}"])
print(f"  panel CPL: {len(rows)} placements -> doorbell-panel-cpl.csv")
