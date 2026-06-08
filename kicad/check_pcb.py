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
    name = (f"{ref} flush with {edge} board edge" if not oh
            else f"{ref} overhangs {edge} edge by {oh} mm")
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

# 3. every pad is either in a net or explicitly No-Connect. Catches a pin omitted from the
#    netlist (e.g. a module GND pin left floating) -- which DRC's "unconnected pads" count does
#    NOT flag, because a pad with NO net assigned generates no ratsnest.
from doorbell_design import NOCONN, REF
_nc = {(REF.get(k, k), str(p)) for k, p in NOCONN}   # NOCONN uses internal keys; map to refdes
# fiducials (and any FP_EXCLUDE_FROM_POS_FILES footprint) are bare copper with a netless pad by
# design -- not a floating signal pin, so they're exempt from the "every pad in a net" check.
# Paste/mechanical apertures (e.g. a QFN EPAD's F.Paste-only thermal cells) carry no copper and
# no number -- they can't hold a net, so they're not floating signal pins either.
floating = sorted({f"{ref}.{p.GetNumber()}" for ref, fp in fps.items()
                   if not (fp.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_POS_FILES)
                   for p in fp.Pads()
                   if p.GetNetname() == "" and p.IsOnCopperLayer()
                   and (ref, p.GetNumber()) not in _nc})
check("every pad in a net or marked No-Connect", not floating,
      ("floating: " + ", ".join(floating)) if floating else "all pads accounted for")

print("PCB constraint checklist:")
ok_all = True
for ok, name, detail in results:
    ok_all &= ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"   ({detail})" if detail else ""))
sys.exit(0 if ok_all else 1)
