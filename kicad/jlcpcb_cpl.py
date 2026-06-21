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
# Per-FOOTPRINT rotation offset (deg, CCW+) ADDED to the footprint orientation so the exported CPL
# matches JLCPCB's library part orientation. Keyed by footprint (lib:name), NOT refdes: the correction
# is a property of the land pattern, so every instance of a footprint inherits it and renumbering can't
# desync it (a single part can't carry two different offsets). Values confirmed against JLCPCB's
# Confirm-Parts-Placement preview. Resistors/caps/buttons are symmetric -> rotation-agnostic; the
# easyeda2kicad footprints (the PhotoMOS gaqw/gaqy, the db125 terminal, the 2N7002DW dual, …) come
# from the LCSC library already JLCPCB-oriented -> no offset. The corrections below are all KiCad-
# standard / PCM_JLCPCB land patterns that sit rotated vs JLCPCB's library part.
ROT_FIX = {
    "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm":  180,   # LTV-217 SOP-4 optos (OC1/OC2): JLCPCB pin 1 is 180° off KiCad
    "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y": -90,   # G6K-2F-Y relay: KiCad-std footprint sits 90° CW off JLCPCB lib
}


def MM(v):
    return round(pcbnew.ToMM(v), 4)


b = pcbnew.LoadBoard(BOARD)
rows = []
used = set()
for f in b.GetFootprints():
    ref = f.GetReference()
    if ref in HANDSOLDER or getattr(f, "IsDNP", lambda: False)():
        continue
    if f.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_POS_FILES:   # fiducials, mounting holes etc. -- not placed
        continue
    xs = [p.GetPosition().x for p in f.Pads()]
    ys = [p.GetPosition().y for p in f.Pads()]
    if not xs:
        continue
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    fpid = f.GetFPID().GetUniStringLibId()
    if fpid in ROT_FIX:
        used.add(fpid)
    rot = (f.GetOrientationDegrees() + ROT_FIX.get(fpid, 0)) % 360
    layer = "Bottom" if f.IsFlipped() else "Top"
    rows.append((ref, MM(cx), -MM(cy), layer, rot))   # JLCPCB CPL uses Y-up (negate KiCad Y)

stale = sorted(set(ROT_FIX) - used)
if stale:
    print(f"  WARNING: ROT_FIX has no placed footprint for: {stale} (stale key?)")

rows.sort(key=lambda r: r[0])
with open(OUT, "w", newline="") as o:
    w = csv.writer(o)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for ref, x, y, layer, rot in rows:
        w.writerow([ref, f"{x:.4f}", f"{y:.4f}", layer, f"{rot:g}"])
print(f"  CPL: {len(rows)} placements (pad-centroid) -> doorbell-cpl.csv")
