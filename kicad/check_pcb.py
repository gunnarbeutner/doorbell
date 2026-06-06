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
from doorbell_design import EDGE_FLUSH, ANTENNA_REF

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

# 1. flush constraints
for ref, edge in EDGE_FLUSH.items():
    fp = fps.get(ref)
    if fp is None:
        check(f"{ref} present", False, "footprint missing"); continue
    e, be = edge_of(fp, edge), board_edge[edge]
    check(f"{ref} flush with {edge} board edge", abs(e - be) <= TOL,
          f"part {e:.2f} mm vs edge {be:.2f} mm")

# 2. antenna copper keep-out present and at the board edge
ko = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowZoneFills()]
check(f"{ANTENNA_REF} antenna copper keep-out present", len(ko) >= 1,
      f"{len(ko)} rule-area keep-out(s)")
if ko:
    zb = ko[0].GetBoundingBox()
    edge_dists = {"top": abs(MM(zb.GetTop()) - BT), "bottom": abs(MM(zb.GetBottom()) - BB),
                  "left": abs(MM(zb.GetLeft()) - BL), "right": abs(MM(zb.GetRight()) - BR)}
    check("antenna keep-out reaches a board edge", min(edge_dists.values()) <= TOL,
          "nearest edge gap %.2f mm" % min(edge_dists.values()))

# 3. every footprint inside the board outline
outside = []
for ref, fp in fps.items():
    l, r, t, bo = fext(fp)
    if l < BL - TOL or r > BR + TOL or t < BT - TOL or bo > BB + TOL:
        outside.append(ref)
check("all footprints inside the board outline", not outside,
      ("outside: " + ", ".join(outside)) if outside else f"board {BR-BL:.1f}x{BB-BT:.1f} mm")

print("PCB constraint checklist:")
ok_all = True
for ok, name, detail in results:
    ok_all &= ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"   ({detail})" if detail else ""))
sys.exit(0 if ok_all else 1)
