#!/usr/bin/env python3
"""Verify kicad/doorbell.kicad_pcb — the board is authored in KiCad (authoritative).

A **read-only** checker for the rules KiCad's own DRC can't express. It:
  * refills existing zones in memory (never writes the board, creates no copper),
  * fails if any connection is left unrouted (after the plane/zone fill),
  * fails if any floating copper-thieving island exceeds the sliver limit
    (area >= 2 mm^2, or longest side >= 10 mm — thin slivers dodge the area test),
  * and prints a copper-density report.
Fill + save zones in KiCad before running the fab export (this script does not).

Inner planes and copper-thieving zones live in the .kicad_pcb — draw/edit them in
KiCad. To fix an over-limit float island: drop a hand-placed GND stitching via on
the pocket in KiCad (it then joins the GND thieve on the next fill), or shrink it.

Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
board = pcbnew.LoadBoard(BOARD)

# Refill existing zones (inner planes + thieving) IN MEMORY so plane-via bonds
# count as routed copper and float islands can be measured. This never writes the
# board and creates no copper — zones/planes/groups are authored in KiCad.
board.BuildConnectivity()
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
board.BuildConnectivity()

# --- connectivity: every net must be fully routed in KiCad ---
try:
    _unrouted = board.GetConnectivity().GetUnconnectedCount(False)
except TypeError:                       # older API: no aVisibleOnly argument
    _unrouted = board.GetConnectivity().GetUnconnectedCount()
if _unrouted == 0:
    print("0 unrouted connections -- board is fully routed")
else:
    _names = set()
    try:
        _conn = board.GetConnectivity()
        for _nc in range(1, board.GetNetCount()):
            _rn = _conn.GetRatsnestForNet(_nc)
            if _rn is not None and _rn.GetEdges():
                _names.add(board.FindNet(_nc).GetNetname())
    except Exception:
        pass
    sys.exit(f"ERROR: {_unrouted} unrouted connection(s)"
             + (f" on net(s): {', '.join(sorted(_names))}" if _names else "")
             + "\nRoute the missing connection(s) in KiCad.")

# --- copper density report ---
_IU2 = pcbnew.FromMM(1) ** 2
_bba = board.GetBoardEdgesBoundingBox()
_board_area = pcbnew.ToMM(_bba.GetWidth()) * pcbnew.ToMM(_bba.GetHeight())
_COPPER_LAYERS = [(pcbnew.F_Cu, "F.Cu "), (pcbnew.In1_Cu, "In1  "),
                  (pcbnew.In2_Cu, "In2  "), (pcbnew.B_Cu, "B.Cu ")]

def _routing_copper_mm2(lid):
    area = 0.0
    for _t in board.GetTracks():
        if _t.Type() == pcbnew.PCB_VIA_T:
            if _t.IsOnLayer(lid):
                _r = _t.GetWidth() / 2.0
                area += math.pi * _r * _r
        elif _t.GetLayer() == lid:
            area += float(_t.GetLength()) * _t.GetWidth()
    for _fp in board.GetFootprints():
        for _pad in _fp.Pads():
            if _pad.IsOnLayer(lid):
                _sz = _pad.GetSize()
                area += float(_sz.x) * float(_sz.y)
    return area / _IU2

print(f"  copper density (board {_board_area:.0f} mm²):")
for _lid, _lname in _COPPER_LAYERS:
    _routing = _routing_copper_mm2(_lid)
    _filled = sum(z.GetFilledArea() / _IU2 for z in board.Zones() if z.GetLayer() == _lid)
    _tot = _routing + _filled
    print(f"    {_lname} {_tot:6.0f} mm² ({100*_tot/_board_area:5.1f}%)")

# --- float-thieving sliver limit (KiCad DRC can't express the length test) ---
# A floating (no-net) copper zone on an outer layer fills pockets the GND thieve
# can't reach, but only as slivers. Any float island >= _FLOAT_MAX_AREA mm^2 or
# longer than _FLOAT_MAX_SIDE mm FAILS the build. Fix: hand-place a GND stitching
# via on the pocket in KiCad, or shrink it.
_FLOAT_MAX_AREA, _FLOAT_MAX_SIDE = 2.0, 10.0
_OUTER = (pcbnew.F_Cu, pcbnew.B_Cu)
_nfloat, _failures = 0, []
for _z in board.Zones():
    if _z.GetIsRuleArea() or _z.GetLayer() not in _OUTER or _z.GetNetname() != "":
        continue                         # float thieve = a no-net copper zone on an outer layer
    _polys = _z.GetFilledPolysList(_z.GetLayer())
    for _i in range(_polys.OutlineCount()):
        _nfloat += 1
        _outline = _polys.Outline(_i)
        _ibb = _outline.BBox()
        _w, _h = pcbnew.ToMM(_ibb.GetWidth()), pcbnew.ToMM(_ibb.GetHeight())
        _area = abs(_outline.Area()) / pcbnew.FromMM(1) ** 2
        if _area >= _FLOAT_MAX_AREA or max(_w, _h) >= _FLOAT_MAX_SIDE:
            _failures.append(f"{_z.GetZoneName() or 'no-net zone'} {_w:.1f}×{_h:.1f} mm "
                             f"({_area:.1f} mm²) at x={pcbnew.ToMM(_ibb.GetLeft()):.1f} "
                             f"y={pcbnew.ToMM(_ibb.GetTop()):.1f}")
if _failures:
    sys.exit(f"ERROR: {len(_failures)} float-thieving island(s) over the sliver limit "
             f"(≥ {_FLOAT_MAX_AREA} mm² or ≥ {_FLOAT_MAX_SIDE} mm):\n  "
             + "\n  ".join(_failures)
             + "\nStitch the pocket to GND with a hand-placed via in KiCad, or shrink it.")
print(f"  float-thieving: {_nfloat} islands, all under {_FLOAT_MAX_AREA} mm² / {_FLOAT_MAX_SIDE} mm")

print("verified (read-only) -- no changes written")
