#!/usr/bin/env python3
"""Finalize kicad/doorbell.kicad_pcb: inner planes, groups, thieving, density report.

The board is fully hand-routed by gen_pcb.py. After the
inner planes are filled, any remaining unrouted connection FAILS the build -- the
missing copper must be added to gen_pcb.py, not invented by a tool.

Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import GROUPS, REF

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")

board = pcbnew.LoadBoard(BOARD)

# --- Inner planes: In1 = +3V3, In2 = GND, filled before the connectivity check so
#     through-via plane bonds count as routed copper. ---
def _add_plane(layer, netname):
    net = board.FindNet(netname)
    z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(net)
    bb2 = board.GetBoardEdgesBoundingBox()
    ins = 0.3
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for cx, cy in [(pcbnew.ToMM(bb2.GetLeft())+ins, pcbnew.ToMM(bb2.GetTop())+ins),
                   (pcbnew.ToMM(bb2.GetRight())-ins, pcbnew.ToMM(bb2.GetTop())+ins),
                   (pcbnew.ToMM(bb2.GetRight())-ins, pcbnew.ToMM(bb2.GetBottom())-ins),
                   (pcbnew.ToMM(bb2.GetLeft())+ins, pcbnew.ToMM(bb2.GetBottom())-ins)]:
        ch.Append(pcbnew.VECTOR2I(pcbnew.FromMM(cx), pcbnew.FromMM(cy)))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)
_add_plane(pcbnew.In1_Cu, "+3V3")
_add_plane(pcbnew.In2_Cu, "GND")
board.BuildConnectivity()
pcbnew.ZONE_FILLER(board).Fill(board.Zones())

# The board must be fully hand-routed: pre-routes + planes satisfy every
# connection, or the build fails here with the offending nets.
board.BuildConnectivity()
try:
    _unrouted = board.GetConnectivity().GetUnconnectedCount(False)
except TypeError:                       # older API: no aVisibleOnly argument
    _unrouted = board.GetConnectivity().GetUnconnectedCount()

if _unrouted == 0:
    print("0 unrouted connections -- board is fully hand-routed")
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
             + "\nAll routing is hand-placed -- add the missing pre-route in gen_pcb.py.")

# --- Subassembly groups: add each member footprint by refdes. ---
_grp_map = {}
for _gname, _keys in GROUPS.items():
    _grp = pcbnew.PCB_GROUP(board)
    _grp.SetName(_gname)
    for _k in _keys:
        _fp = board.FindFootprintByReference(REF[_k])
        if _fp is not None:
            _grp.AddItem(_fp)
    board.Add(_grp)
    _grp_map[_gname] = _grp
# Add BOOT/RST silkscreen labels (PCB_TEXT) into their groups.
for _drawing in board.GetDrawings():
    if isinstance(_drawing, pcbnew.PCB_TEXT) and _drawing.GetText() in ("BOOT", "RST"):
        _grp_map.get(_drawing.GetText(), pcbnew.PCB_GROUP(board)).AddItem(_drawing)
print(f"  groups: {len(GROUPS)} subassemblies")

# --- ground pour + stitching vias on F.Cu / B.Cu ---
def MM(v): return pcbnew.ToMM(v)
def Vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))
gnd = board.FindNet("GND")
edges = [d for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
bb = edges[0].GetBoundingBox()
for d in edges[1:]:
    bb.Merge(d.GetBoundingBox())
BL, BR, BT, BB = MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())

GND_FILL = False
ins = 0.3
corners = [(BL+ins, BT+ins), (BR-ins, BT+ins), (BR-ins, BB-ins), (BL+ins, BB-ins)]
for layer in ((pcbnew.F_Cu, pcbnew.B_Cu) if GND_FILL else ()):
    z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(gnd)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)  # solid fill — reflow assembled, no thermal relief needed
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for (cx, cy) in corners:
        ch.Append(Vmm(cx, cy))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)

# obstacles (avoid all pads; keep clear of NON-GND tracks/vias, keep-out, board edge)
pads = [(MM(p.GetPosition().x), MM(p.GetPosition().y), MM(max(p.GetSize().x, p.GetSize().y))/2.0)
        for f in board.GetFootprints() for p in f.Pads()]
fpboxes = []
for _f in board.GetFootprints():
    _bb = _f.GetBoundingBox(False, False)
    fpboxes.append((MM(_bb.GetLeft()), MM(_bb.GetRight()), MM(_bb.GetTop()), MM(_bb.GetBottom())))
segs, ovias = [], []
for t in board.GetTracks():
    if t.GetNetname() == "GND":
        continue
    if t.Type() == pcbnew.PCB_VIA_T:
        ovias.append((MM(t.GetPosition().x), MM(t.GetPosition().y), MM(t.GetWidth())/2.0))
    else:
        s, e = t.GetStart(), t.GetEnd()
        segs.append((MM(s.x), MM(s.y), MM(e.x), MM(e.y), MM(t.GetWidth())/2.0))
ko = [z for z in board.Zones() if z.GetIsRuleArea()]
kb = ko[0].GetBoundingBox() if ko else None
KX0, KY0, KX1, KY1 = ((MM(kb.GetLeft())-0.5, MM(kb.GetTop())-0.5,
                       MM(kb.GetRight())+0.5, MM(kb.GetBottom())+0.5) if kb else (1, 1, -1, -1))

def dseg(px, py, ax, ay, bx, by):
    dx, dy = bx-ax, by-ay
    if dx == 0 and dy == 0:
        return math.hypot(px-ax, py-ay)
    t = max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))

VIA_R, CLR, PITCH, EDGE = 0.3, 0.6, 4.0, 1.5
def clear(px, py):
    if not (BL+EDGE < px < BR-EDGE and BT+EDGE < py < BB-EDGE):
        return False
    if KX0 < px < KX1 and KY0 < py < KY1:
        return False
    for (l, r, t, bo) in fpboxes:           # keep vias off component footprints
        if l-0.3 < px < r+0.3 and t-0.3 < py < bo+0.3:
            return False
    for (x, y, r) in pads:
        if math.hypot(px-x, py-y) < VIA_R + r + CLR:
            return False
    for (x, y, r) in ovias:
        if math.hypot(px-x, py-y) < VIA_R + r + CLR:
            return False
    for (x0, y0, x1, y1, hw) in segs:
        if dseg(px, py, x0, y0, x1, y1) < VIA_R + hw + CLR:
            return False
    return True

nvia = 0
yy = BT + EDGE + 1.0
while GND_FILL and yy < BB - EDGE:
    xx = BL + EDGE + 1.0
    while xx < BR - EDGE:
        if clear(xx, yy):
            v = pcbnew.PCB_VIA(board)
            v.SetPosition(Vmm(xx, yy)); v.SetDrill(pcbnew.FromMM(0.3)); v.SetWidth(pcbnew.FromMM(0.6))
            v.SetNet(gnd); board.Add(v); nvia += 1
        xx += PITCH
    yy += PITCH

# --- Copper thieving: two overlapping zones per outer layer, same board-outline polygon.
#     Priority 1 (GND): fills open areas and connects to GND — acts as a partial ground plane.
#     Priority 0 (no-net): fills whatever GND can't reach (under ICs, tight spots) for plating
#     uniformity. Isolated no-net islands are intentional; ISLAND_REMOVAL_MODE_NEVER suppresses
#     the isolated_copper DRC warning. The antenna keepout (DoNotAllowZoneFills) blocks both
#     zones from entering the RF clear area automatically. ---
_THIEVE_CLR  = 0.5   # mm clearance from signal copper
_THIEVE_MINW = 0.15  # mm minimum island width
_gnd_net = board.FindNet("GND")
_no_net  = board.FindNet("")
_bb2 = board.GetBoardEdgesBoundingBox()
_thieve_corners = [
    (pcbnew.ToMM(_bb2.GetLeft()),  pcbnew.ToMM(_bb2.GetTop())),
    (pcbnew.ToMM(_bb2.GetRight()), pcbnew.ToMM(_bb2.GetTop())),
    (pcbnew.ToMM(_bb2.GetRight()), pcbnew.ToMM(_bb2.GetBottom())),
    (pcbnew.ToMM(_bb2.GetLeft()),  pcbnew.ToMM(_bb2.GetBottom())),
]
for _layer, _lname in ((pcbnew.F_Cu, "F"), (pcbnew.B_Cu, "B")):
    for _net, _priority, _suffix in ((_gnd_net, 1, "gnd"), (_no_net, 0, "float")):
        _tz = pcbnew.ZONE(board)
        _tz.SetLayer(_layer)
        _tz.SetNet(_net)
        _tz.SetAssignedPriority(_priority)
        _tz.SetFillMode(pcbnew.ZONE_FILL_MODE_POLYGONS)
        _tz.SetLocalClearance(pcbnew.FromMM(_THIEVE_CLR))
        _tz.SetMinThickness(pcbnew.FromMM(_THIEVE_MINW))
        _tz.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
        _tz.SetIsRuleArea(False)
        _tz.SetZoneName(f"thieving_{_lname}_{_suffix}")
        if _net == _no_net:
            _tz.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_NEVER)
        _tch = pcbnew.SHAPE_LINE_CHAIN()
        for _cx, _cy in _thieve_corners:
            _tch.Append(Vmm(_cx, _cy))
        _tch.SetClosed(True); _tz.AddPolygon(_tch); board.Add(_tz)
print(f"  copper thieving: F.Cu + B.Cu GND+float zones added (clearance {_THIEVE_CLR} mm, min width {_THIEVE_MINW} mm)")

board.BuildConnectivity()
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(BOARD, board)
ngnd = sum(1 for f in board.GetFootprints() for p in f.Pads() if p.GetNetname() == "GND")
print(f"routed + inner planes + {nvia} stitching vias -> {BOARD} "
      f"({len(board.GetTracks())} track/via items, {ngnd} GND pads)")

# --- Copper density report (pre-thieve = routed+planes only; post = +thieving fill) ---
# Zones account for fills (inner planes, thieving); tracks/vias/pads are separate objects.
# Outer layers have no zones before thieving, so routing copper must be summed explicitly.
# Track area = length×width (rectangle); via area = π r²; pad area = size.x×size.y (approx).
_IU2 = pcbnew.FromMM(1) ** 2          # IU² per mm²
_bba = board.GetBoardEdgesBoundingBox()
_board_area = pcbnew.ToMM(_bba.GetWidth()) * pcbnew.ToMM(_bba.GetHeight())
_COPPER_LAYERS = [
    (pcbnew.F_Cu,   "F.Cu "),
    (pcbnew.In1_Cu, "In1  "),
    (pcbnew.In2_Cu, "In2  "),
    (pcbnew.B_Cu,   "B.Cu "),
]

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

print(f"  copper density (board {_board_area:.0f} mm²)  [pre-thieve → post-thieve]:")
for _lid, _lname in _COPPER_LAYERS:
    _routing = _routing_copper_mm2(_lid)
    _pre  = _routing + sum(z.GetFilledArea() / _IU2 for z in board.Zones()
                           if z.GetLayer() == _lid and not z.GetZoneName().startswith("thieving"))
    _post = _routing + sum(z.GetFilledArea() / _IU2 for z in board.Zones()
                           if z.GetLayer() == _lid)
    print(f"    {_lname} {_pre:6.0f} mm² ({100*_pre/_board_area:5.1f}%)  →  "
          f"{_post:6.0f} mm² ({100*_post/_board_area:5.1f}%)")

# --- Float-thieving DRC: floating islands are intentional (they fill pockets the GND
#     thieve can't reach), but only as slivers. Any float island ≥ _FLOAT_MAX_AREA mm²,
#     or longer than _FLOAT_MAX_SIDE mm (thin slivers can dodge the area test), FAILS
#     the build. The fix is a hand-placed GND stitching via in gen_pcb.py (the pocket
#     then joins the GND thieve on the next fill) or shrinking the pocket -- vias are
#     never auto-placed. ---
_FLOAT_MAX_AREA, _FLOAT_MAX_SIDE = 2.0, 10.0
_nfloat, _failures = 0, []
for _z in board.Zones():
    if not _z.GetZoneName().endswith("_float"):
        continue
    _polys = _z.GetFilledPolysList(_z.GetLayer())
    for _i in range(_polys.OutlineCount()):
        _nfloat += 1
        _outline = _polys.Outline(_i)
        _ibb = _outline.BBox()
        _w, _h = pcbnew.ToMM(_ibb.GetWidth()), pcbnew.ToMM(_ibb.GetHeight())
        _area = abs(_outline.Area()) / pcbnew.FromMM(1) ** 2
        if _area >= _FLOAT_MAX_AREA or max(_w, _h) >= _FLOAT_MAX_SIDE:
            _failures.append(f"{_z.GetZoneName()} {_w:.1f}×{_h:.1f} mm ({_area:.1f} mm²) at "
                             f"x={pcbnew.ToMM(_ibb.GetLeft()):.1f} "
                             f"y={pcbnew.ToMM(_ibb.GetTop()):.1f}")
if _failures:
    sys.exit(f"ERROR: {len(_failures)} float-thieving island(s) over the sliver limit "
             f"(≥ {_FLOAT_MAX_AREA} mm² or ≥ {_FLOAT_MAX_SIDE} mm):\n  "
             + "\n  ".join(_failures)
             + "\nStitch the pocket to GND with a hand-placed via in gen_pcb.py "
               "or shrink it.")
print(f"  float-thieving: {_nfloat} islands, all under {_FLOAT_MAX_AREA} mm² "
      f"/ {_FLOAT_MAX_SIDE} mm")
