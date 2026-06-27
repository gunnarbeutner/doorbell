#!/usr/bin/env python3
"""Verify kicad/doorbell.kicad_pcb — the board is authored in KiCad (authoritative).

A **read-only** checker for the rules KiCad's own DRC can't express. It:
  * refills existing zones in memory (never writes the board, creates no copper),
  * fails if any connection is left unrouted (after the plane/zone fill),
    pinpointing each isolated zone island (location + the pad it strands) so the
    GND stitch site is obvious rather than just naming the board corner,
  * fails if a floating copper-thieving island is BOTH over the sliver limit
    (area >= 2 mm^2, or longest side >= 10 mm) AND wide enough to host a GND
    stitching via — pockets too narrow to take a via are unavoidable and pass,
  * and prints a copper-density report.
Fill + save zones in KiCad before running the fab export (this script does not).

Inner planes and copper-thieving zones live in the .kicad_pcb — draw/edit them in
KiCad. To fix a stitchable over-limit float island: drop a hand-placed GND stitching
via on the pocket in KiCad (it then joins the GND thieve on the next fill), or shrink
it. A too-narrow sliver can't take a via at all — shrink the thieving zone if it must go.

Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys, math
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcbnew

BOARD = os.path.join(ROOT, "kicad", "doorbell.kicad_pcb")
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
    # Localize the unrouted copper so the fix site is obvious. KiCad's own locators
    # are no help from this Python binding: ratsnest GetEdges() returns an untyped
    # swig object, FillIsolatedIslandsMap() wants a std::map passed by reference
    # (not constructible here), and kicad-cli's DRC reports a zone's anchor CORNER,
    # not the offending island. So find it geometrically. The netted zones are GND
    # pours stitched to the inner planes by vias, so a filled island reaches the
    # plane system only if it holds a via on its net (vias bridge layers) or a
    # through-hole pad of its net. An island with neither floats -- together with
    # any SMD pad sitting on it -- and needs a hand-placed stitching via.
    def _contains(_outline, _pt):
        _ps = pcbnew.SHAPE_POLY_SET(); _ps.AddOutline(_outline); return _ps.Contains(_pt)
    _vias = [(t.GetPosition(), t.GetNetname()) for t in board.GetTracks()
             if t.Type() == pcbnew.PCB_VIA_T]
    _pads = [(p.GetPosition(), p.GetNetname(), p.GetAttribute(),
              f"{fp.GetReference()}.{p.GetPadName()}")
             for fp in board.GetFootprints() for p in fp.Pads()]
    _stranded = []
    for _z in board.Zones():
        if _z.GetIsRuleArea() or not _z.GetNetname():
            continue
        _net, _lid = _z.GetNetname(), _z.GetLayer()
        _polys = _z.GetFilledPolysList(_lid)
        for _i in range(_polys.OutlineCount()):
            _o = _polys.Outline(_i)
            if any(_n == _net and _contains(_o, _p) for _p, _n in _vias):
                continue                       # a net via bridges this island to the planes
            if any(_n == _net and _a == pcbnew.PAD_ATTRIB_PTH and _contains(_o, _p)
                   for _p, _n, _a, _d in _pads):
                continue                       # a through-hole net pad bridges layers
            _smd = [_d for _p, _n, _a, _d in _pads if _n == _net and _contains(_o, _p)]
            _bb = _o.BBox(); _c = _bb.GetCenter()
            _area = abs(_o.Area()) / pcbnew.FromMM(1) ** 2
            _stranded.append(
                f"{_z.GetZoneName() or 'zone'} [{_net}] island on {board.GetLayerName(_lid)}: "
                f"{_area:.1f} mm² ({pcbnew.ToMM(_bb.GetWidth()):.1f}×{pcbnew.ToMM(_bb.GetHeight()):.1f} mm) "
                f"at ({pcbnew.ToMM(_c.x):.2f}, {pcbnew.ToMM(_c.y):.2f}) mm"
                + (f", strands pad(s) {', '.join(_smd)}" if _smd else "")
                + f" -- stitch to {_net} with a via here")
    _msg = f"ERROR: {_unrouted} unrouted connection(s)"
    if _stranded:
        _msg += " -- isolated zone island(s):\n  " + "\n  ".join(_stranded)
        if len(_stranded) != _unrouted:
            _msg += (f"\n  (localized {len(_stranded)} island(s); {_unrouted} unrouted total -- "
                     "any remainder is non-zone copper, inspect the ratsnest in KiCad)")
    else:
        _msg += " (not in a zone island -- inspect the ratsnest in KiCad)"
    sys.exit(_msg + "\nRoute the missing connection(s) in KiCad.")

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

# --- float-thieving sliver limit (KiCad DRC can't express this) ---
# A floating (no-net) copper zone on an outer layer fills pockets the GND thieve
# can't reach. An island only matters if it's significant (area >= _FLOAT_MAX_AREA
# mm^2 or longest side >= _FLOAT_MAX_SIDE mm) AND can actually be tied to GND — i.e.
# a stitching via plus its float clearance on each side fits inside it. We test that
# by eroding the island by the via's stitch radius (via_pad/2 + float clearance): if
# anything survives, a via fits and the island FAILS the build (stitch it). If the
# erosion empties it, the pocket is narrower than any via can reclaim — an unavoidable
# thieving by-product — so it passes (shrink the thieving zone if it must go).
_FLOAT_MAX_AREA, _FLOAT_MAX_SIDE = 2.0, 10.0
_OUTER = (pcbnew.F_Cu, pcbnew.B_Cu)
_VIA_PAD = pcbnew.ToMM(board.GetDesignSettings().GetCurrentViaSize())   # stitch via pad Ø
_STRAT, _MAXERR = pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, pcbnew.FromMM(0.01)
_nfloat, _failures, _slivers = 0, [], []
for _z in board.Zones():
    if _z.GetIsRuleArea() or _z.GetLayer() not in _OUTER or _z.GetNetname() != "":
        continue                         # float thieve = a no-net copper zone on an outer layer
    _clr = pcbnew.ToMM(_z.GetLocalClearance())          # float keeps this clear of GND copper
    _stitch_w = _VIA_PAD + 2 * _clr                     # min pocket width a stitch via needs
    _r_erode = pcbnew.FromMM(_VIA_PAD / 2 + _clr)       # inscribed radius that via demands
    _polys = _z.GetFilledPolysList(_z.GetLayer())
    for _i in range(_polys.OutlineCount()):
        _nfloat += 1
        _outline = _polys.Outline(_i)
        _ibb = _outline.BBox()
        _w, _h = pcbnew.ToMM(_ibb.GetWidth()), pcbnew.ToMM(_ibb.GetHeight())
        _area = abs(_outline.Area()) / pcbnew.FromMM(1) ** 2
        if _area < _FLOAT_MAX_AREA and max(_w, _h) < _FLOAT_MAX_SIDE:
            continue                     # small enough to ignore
        _eroded = pcbnew.SHAPE_POLY_SET()
        _eroded.AddOutline(_outline)
        _eroded.Deflate(_r_erode, _STRAT, _MAXERR)      # shrink by the via's stitch radius
        _desc = (f"{_z.GetZoneName() or 'no-net zone'} {_w:.1f}×{_h:.1f} mm "
                 f"({_area:.1f} mm²) at x={pcbnew.ToMM(_ibb.GetLeft()):.1f} "
                 f"y={pcbnew.ToMM(_ibb.GetTop()):.1f}")
        if _eroded.OutlineCount() > 0:                  # a via fits → stitchable → must fix
            _failures.append(_desc)
        else:                                           # narrower than a via can reclaim
            _slivers.append(f"{_desc} — too narrow to stitch (needs ≥ {_stitch_w:.1f} mm)")
if _failures:
    sys.exit(f"ERROR: {len(_failures)} stitchable float-thieving island(s) over the sliver limit "
             f"(≥ {_FLOAT_MAX_AREA} mm² or ≥ {_FLOAT_MAX_SIDE} mm):\n  "
             + "\n  ".join(_failures)
             + "\nStitch the pocket to GND with a hand-placed via in KiCad, or shrink it.")
print(f"  float-thieving: {_nfloat} islands, all under {_FLOAT_MAX_AREA} mm² / "
      f"{_FLOAT_MAX_SIDE} mm or too narrow to stitch")
for _s in _slivers:
    print(f"    accepted sliver: {_s}")

print("verified (read-only) -- no changes written")
