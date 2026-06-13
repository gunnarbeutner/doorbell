#!/usr/bin/env python3
"""JLCPCB CPL (pick & place) from the routed PCB.

Mid X / Mid Y are each part's PAD CENTROID, not the footprint origin. KiCad's pos export (and
the footprint anchor) sit at pin 1 / pad A1 for many connectors and modules -- several mm from
the body centre -- which throws JLCPCB's placement off (e.g. the WF26 terminal lands ~9 mm out,
the USB-C ~3 mm). Using the pad centroid puts every part where JLCPCB expects it.

Run with KiCad's bundled python (owns pcbnew); see build.sh.
"""
import csv, os
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
OUT = os.path.join(HERE, "fab", "doorbell-cpl.csv")

HANDSOLDER = set()        # parts hand-soldered after SMT assembly (excluded from the CPL)
# Per-ref rotation offset (deg, CCW+) ADDED to the footprint orientation so the exported CPL
# matches JLCPCB's library part orientation. All values below were confirmed against JLCPCB's
# Confirm-Parts-Placement preview. Resistors/caps/buttons are symmetric -> rotation-agnostic.
ROT_FIX = {
    "OK1": 180, "OK2": 180, "OK3": 180,   # LTV-217 SOP-4 optos: JLCPCB pin 1 is 180° off KiCad
    "Q1": 180,  "Q2": 180,  "Q3": 180,    # 2N7002 SOT-23: classic JLCPCB 180° offset
    "K1": -90,  "K2": -90,  "K3": -90,    # G6K relay: 90° clockwise
}


def MM(v):
    return round(pcbnew.ToMM(v), 4)


b = pcbnew.LoadBoard(BOARD)
rows = []
for f in b.GetFootprints():
    ref = f.GetReference()
    if ref in HANDSOLDER or getattr(f, "IsDNP", lambda: False)():
        continue
    if f.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_POS_FILES:   # fiducials etc. -- not placed parts
        continue
    xs = [p.GetPosition().x for p in f.Pads()]
    ys = [p.GetPosition().y for p in f.Pads()]
    if not xs:
        continue
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    rot = (f.GetOrientationDegrees() + ROT_FIX.get(ref, 0)) % 360
    layer = "Bottom" if f.IsFlipped() else "Top"
    rows.append((ref, MM(cx), -MM(cy), layer, rot))   # JLCPCB CPL uses Y-up (negate KiCad Y)

rows.sort(key=lambda r: r[0])
with open(OUT, "w", newline="") as o:
    w = csv.writer(o)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for ref, x, y, layer, rot in rows:
        w.writerow([ref, f"{x:.4f}", f"{y:.4f}", layer, f"{rot:g}"])
print(f"  CPL: {len(rows)} placements (pad-centroid) -> doorbell-cpl.csv")
