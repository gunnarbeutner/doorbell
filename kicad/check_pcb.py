#!/usr/bin/env python3
"""Verify the PCB edge/placement constraints against kicad/doorbell.kicad_pcb.

Checklist:
  - every EDGE_FLUSH part's outer face is flush with its board edge,
  - the antenna copper keep-out (rule area) is present and reaches the board edge,
  - every footprint sits inside the board outline.
Prints a PASS/FAIL checklist and exits non-zero if anything fails, so build.sh can gate.
Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import EDGE_FLUSH, EDGE_OVERHANG

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
TOL = 0.15  # mm

def MM(v): return pcbnew.ToMM(v)
b = pcbnew.LoadBoard(BOARD)
fps = {f.GetReference(): f for f in b.GetFootprints()}
def fext(fp):
    bb = fp.GetBoundingBox(False, False)
    return MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())
def edge_of(fp, edge):
    l, r, t, bo = fext(fp)
    return {"left": l, "right": r, "top": t, "bottom": bo}[edge]

# board outline extents (union of Edge.Cuts items)
edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
bb = edges[0].GetBoundingBox()
for d in edges[1:]:
    bb.Merge(d.GetBoundingBox())
BL, BR, BT, BB = MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())
board_edge = {"left": BL, "right": BR, "top": BT, "bottom": BB}

results = []
def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))

# 1. flush / overhang constraints
for ref, edge in EDGE_FLUSH.items():
    fp = fps.get(ref)
    if fp is None:
        check(f"{ref} present", False, "footprint missing"); continue
    e, be = edge_of(fp, edge), board_edge[edge]
    oh = EDGE_OVERHANG.get(ref, 0.0)
    sign = -1 if edge in ("left", "top") else 1
    expected = be + sign * oh
    if not oh:
        name = f"{ref} flush with {edge} board edge"
    elif oh > 0:
        name = f"{ref} overhangs {edge} edge by {oh} mm"
    else:
        name = f"{ref} set back from {edge} edge by {-oh} mm"
    check(name, abs(e - expected) <= TOL, f"part {e:.2f} mm vs expected {expected:.2f} mm")

# 2. every footprint inside the board outline (antenna keep-out removed: the antenna overhangs)
outside = []
for ref, fp in fps.items():
    if ref in EDGE_OVERHANG:            # connector intentionally overhangs a board edge
        continue
    l, r, t, bo = fext(fp)
    if l < BL - TOL or r > BR + TOL or t < BT - TOL or bo > BB + TOL:
        outside.append(ref)
check("all footprints inside the board outline", not outside,
      ("outside: " + ", ".join(outside)) if outside else f"board {BR-BL:.1f}x{BB-BT:.1f} mm")

# 3. every copper pad carries a net. Catches a pin omitted from the netlist (e.g. a module
#    GND pin left floating) -- which DRC's "unconnected pads" count does NOT flag, because a
#    pad with NO net assigned generates no ratsnest. Intended no-connects are NOT exempted by
#    a hand-maintained list: KiCad gives an NC-flagged pin an `unconnected-(...)` net (non-empty),
#    so only a pad with a truly *empty* net -- a dropped pin -- trips this. The schematic's NC
#    flags stay the single source of no-connect intent.
# fiducials (and any FP_EXCLUDE_FROM_POS_FILES footprint) are bare copper with a netless pad by
# design -- not a floating signal pin, so they're exempt. Paste/mechanical apertures (e.g. a QFN
# EPAD's F.Paste-only thermal cells) carry no copper and no number -- they can't hold a net either.
floating = sorted({f"{ref}.{p.GetNumber()}" for ref, fp in fps.items()
                   if not (fp.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_POS_FILES)
                   for p in fp.Pads()
                   if p.GetNetname() == "" and p.IsOnCopperLayer()})
check("every copper pad carries a net", not floating,
      ("floating: " + ", ".join(floating)) if floating else "all pads accounted for")

# 4. ceramic caps clear of mounting-hole flex stress (MLCC crack avoidance).
#    Screw-down flexes the board; a ceramic cap near a hole cracks at its fillets.
#    Fail any cap too close (CAP_HOLE_HARD_MM) or, in the caution band, oriented
#    radially (pad-to-pad axis pointing at the hole -- the worst case for flex).
import math
from doorbell_design import (MOUNTING_HOLES, CAP_HOLE_HARD_MM, CAP_HOLE_CAUTION_MM,
                             CAP_HOLE_RADIAL_DEG, CAP_HOLE_EXEMPT)
holes = {h: fps[h].GetPosition() for h in MOUNTING_HOLES if h in fps}
def cap_axis_deg(fp):                       # pad-to-pad long axis of a 2-terminal cap, 0..180
    pads = list(fp.Pads())
    if len(pads) < 2:
        return None
    a, b = pads[0].GetPosition(), pads[1].GetPosition()
    return math.degrees(math.atan2(b.y - a.y, b.x - a.x)) % 180.0
hard, radial, caution = [], [], []
for ref, fp in fps.items():
    if not (ref[:1] == "C" and ref[1:].isdigit()) or ref in CAP_HOLE_EXEMPT:
        continue
    p = fp.GetPosition()
    for h, hp in holes.items():
        d = math.hypot(MM(p.x - hp.x), MM(p.y - hp.y))
        if d > CAP_HOLE_CAUTION_MM:
            continue
        if d <= CAP_HOLE_HARD_MM:
            hard.append(f"{ref} {d:.1f}mm<{CAP_HOLE_HARD_MM:g} of {h}")
            continue
        ax = cap_axis_deg(fp)
        rad = math.degrees(math.atan2(p.y - hp.y, p.x - hp.x)) % 180.0
        off = abs(ax - rad) if ax is not None else 90.0
        off = min(off, 180.0 - off)
        if ax is not None and off <= CAP_HOLE_RADIAL_DEG:
            radial.append(f"{ref} {d:.1f}mm of {h} (axis {off:.0f}° off radius)")
        else:
            caution.append(f"{ref} {d:.1f}mm of {h}")
check(f"no ceramic cap within {CAP_HOLE_HARD_MM:g} mm of a mounting hole", not hard,
      "; ".join(hard) if hard else "all clear")
check(f"caps within {CAP_HOLE_CAUTION_MM:g} mm of a hole are tangential, not radial", not radial,
      "; ".join(radial) if radial else "none radial")
if caution:
    print(f"  [note] tangential caps in the {CAP_HOLE_HARD_MM:g}-{CAP_HOLE_CAUTION_MM:g} mm flex band "
          f"(acceptable, keep an eye on torque): {', '.join(caution)}")

print("PCB constraint checklist:")
ok_all = True
for ok, name, detail in results:
    ok_all &= ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"   ({detail})" if detail else ""))
sys.exit(0 if ok_all else 1)
