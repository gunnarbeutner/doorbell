#!/usr/bin/env python3
"""Generate kicad/doorbell.kicad_pcb (footprints placed + nets assigned + outline).

Uses KiCad's native `pcbnew` API, so the board is a valid KiCad 10 file with a proper
layer stack. Circuit data (components, nets, footprints) comes from doorbell_design.py;
the PCB-specific placement lives HERE in `PCB_PLACE` (a schematic's layout and a board's
layout are different problems, so the board gets its own deliberate, compact placement).

The board comes out *placed and netted* (full ratsnest) but UNROUTED — route it with
route.py / `build.sh route`. Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys, math
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import (COMP, REF, FOOTPRINT, NETS, FP_LIB_DIRS,
                             EDGE_FLUSH, EDGE_OVERHANG)

# ---- PCB placement: ref -> (x_mm, y_mm, rotation_deg) ----
# LOGIC/USB section in the lower-left: the ESP32-C3 with its LDO / boot+reset / LED / decoupling
# support clustered just above it, and the USB-C centred on the bottom edge. BUS interface
# (WF26 terminal, optos, bell-sense R, relays + drivers) on the right. The ESP32 antenna
# overhangs the left board edge (off-board), so no copper keep-out is needed.
PCB_PLACE = {
    # === LOWER-LEFT: ESP32-C3 + its power / boot / LED support clustered just ABOVE it ===
    "U1":     (8, 50, 90),    # MCU rot 90° CW, lower-left; antenna overhangs the left edge
    "SW_boot":(5,  24, 0),    # BOOT button
    "SW_en":  (12, 24, 0),    # EN / reset button
    "R_boot": (5,  28, 0),
    "R_en":   (12, 28, 0),
    "C_en":   (16, 28, 180),
    "U2":     (18, 55, 0),    # AMS1117 LDO, in the gap between U1 and J1 (rotated CCW again -> 0°)
    "C_bulk": (18, 44.5, 0),  # 5V bulk cap, above U2
    "C_in":   (15, 48.5, 90), # LDO input cap, above U2
    "C_out":  (21, 48.5, 90), # LDO output cap, above U2
    "LED1":   (5,  38, 0),    # power LED
    "R_led":  (10, 38, 0),
    "C_dec":  (2.5, 59, 270), # U1 100nF decoupling, south of U1 (vertical)
    "C_3v3":  (6, 59, 270),   # U1 10uF decoupling, south of U1 (vertical)
    # === BOTTOM edge: USB-C (centred) + CC pulldowns above its CC pads ===
    "J1":     (30, 53, 0),    # USB-C (USB4085 THT), middle of bottom edge; mouth overhangs down. x re-centred below
    "R_cc1":  (29, 51, 90),   # CC1 pulldown, above J1.A5
    "R_cc2":  (37, 57.5, 270),# CC2 pulldown, right of J1 (rotated 180°)
    # === RIGHT / TOP: BUS interface (WF26 terminal, optos, bell-sense R, relays + drivers) ===
    "J2":     (53, 11, 180),  # WF26 6-way screw terminal, top edge
    "OC2":    (26, 13, 270),  # apartment bell sense
    "OC1":    (30, 13, 270),  # house bell sense
    "R_lim":  (26, 20, 0),    # shared opto cathode limiter
    "R_em":   (30, 20, 0),    # shared opto emitter
    "K2":     (39, 26, 0),    # chime-suppress relay
    "Q2":     (35, 33, 0),
    "R_g2":   (39, 33, 0),
    "R_pd2":  (43, 33, 0),
    "D2":     (35, 36, 0),
    "K1":     (52, 26, 0),    # door-opener relay
    "Q1":     (48, 33, 0),
    "R_g1":   (52, 33, 0),
    "R_pd1":  (56, 33, 0),
    "D1":     (48, 36, 0),
}
MARGIN = 4.0           # board edge margin (mm) on non-flush edges

def vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

board = pcbnew.CreateEmptyBoard()
board.SetCopperLayerCount(4)        # 4-layer stack: F.Cu / In1=GND / In2=+3V3 / B.Cu
board.SetLayerType(pcbnew.In1_Cu, pcbnew.LT_POWER)   # plane layers -> autorouter keeps
board.SetLayerType(pcbnew.In2_Cu, pcbnew.LT_POWER)   # signals on F.Cu / B.Cu only

nets = {}
for name in NETS:
    ni = pcbnew.NETINFO_ITEM(board, name)
    board.Add(ni)
    nets[name] = ni
pad_net = {(ref, pad): name for name, pins in NETS.items() for (ref, pad) in pins}

placed = []
fps = {}
for ref, libname in FOOTPRINT.items():
    nick, name = libname.split(":", 1)
    fp = pcbnew.FootprintLoad(FP_LIB_DIRS[nick], name)
    if fp is None:
        raise RuntimeError(f"footprint not found: {libname}")
    fp.SetReference(REF[ref])
    fp.SetValue(COMP[ref][2])
    x, y, rot = PCB_PLACE[ref]
    fp.SetPosition(vmm(x, y))
    fp.SetOrientationDegrees(rot)
    board.Add(fp)
    for pad in fp.Pads():
        key = (ref, pad.GetNumber())
        if key in pad_net:
            pad.SetNet(nets[pad_net[key]])
    placed.append((x, y))
    fps[ref] = fp

# On 4 layers the LDO's GND/heat reaches the inner planes through its thermal vias, so its
# bottom (B.Cu) thermal pad is redundant -- drop it to free B.Cu under U2 for the USB pair.
for _p in list(fps["U2"].Pads()):
    if _p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD and _p.IsOnLayer(pcbnew.B_Cu) and not _p.IsOnLayer(pcbnew.F_Cu):
        fps["U2"].Remove(_p)

def MM(v): return pcbnew.ToMM(v)
def fext(fp):                          # footprint extents WITHOUT silk text (mm)
    bb = fp.GetBoundingBox(False, False)
    return MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())
def edge_of(fp, edge):
    l, r, t, b = fext(fp)
    return {"left": l, "right": r, "top": t, "bottom": b}[edge]

# --- enforce EDGE_FLUSH: slide each flush part so its outer face lands on a common
#     line, and pin the board edge to that line (so the part is flush, no margin) ---
by_edge = defaultdict(list)
for ref, edge in EDGE_FLUSH.items():
    by_edge[edge].append(ref)
edge_line = {}
for edge, refs in by_edge.items():
    exts = [edge_of(fps[r], edge) for r in refs]
    line = min(exts) if edge in ("left", "top") else max(exts)
    edge_line[edge] = line             # board edge stays at the flush line
    sign = -1 if edge in ("left", "top") else 1     # outward direction (for overhang)
    for r in refs:                     # slide part flush to the line, or `oh` mm beyond it
        target = line + sign * EDGE_OVERHANG.get(r, 0.0)
        d = target - edge_of(fps[r], edge); p = fps[r].GetPosition()
        if edge in ("left", "right"):
            fps[r].SetPosition(pcbnew.VECTOR2I(p.x + pcbnew.FromMM(d), p.y))
        else:
            fps[r].SetPosition(pcbnew.VECTOR2I(p.x, p.y + pcbnew.FromMM(d)))

# --- board outline: tight bbox + margin on free edges, pinned on flush edges ---
L = edge_line.get("left",   min(fext(f)[0] for f in fps.values()) - MARGIN)
R = edge_line.get("right",  max(fext(f)[1] for f in fps.values()) + MARGIN)
T = edge_line.get("top",    min(fext(f)[2] for f in fps.values()) - MARGIN)
B = edge_line.get("bottom", max(fext(f)[3] for f in fps.values()) + MARGIN)
x0, y0, x1, y1 = L, T, R, B
rect = pcbnew.PCB_SHAPE(board)
rect.SetShape(pcbnew.SHAPE_T_RECT)
rect.SetStart(vmm(x0, y0)); rect.SetEnd(vmm(x1, y1))
rect.SetLayer(pcbnew.Edge_Cuts)
rect.SetWidth(pcbnew.FromMM(0.15))
board.Add(rect)

# --- 4-layer inner planes: In1.Cu = solid GND, In2.Cu = +3V3. Components reach them through
#     vias the autorouter places; +5V stays a (short) surface trace. Filled in route.py. ---
def add_plane(layer, netname):
    z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(nets[netname])
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for (cx, cy) in [(x0+0.3, y0+0.3), (x1-0.3, y0+0.3), (x1-0.3, y1-0.3), (x0+0.3, y1-0.3)]:
        ch.Append(vmm(cx, cy))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)
add_plane(pcbnew.In1_Cu, "GND")
add_plane(pcbnew.In2_Cu, "+3V3")

# --- pre-stitch every surface (SMD) GND/+3V3 pad to its inner plane with an offset via + a
#     short F.Cu stub. The planes are LT_POWER, so the autorouter won't via to them itself;
#     we make those connections here so Freerouting only has to route signals on F.Cu/B.Cu.
#     (THT power/GND pads already pass through the planes, so they're skipped.) ---
PLANE_OF = {"GND": pcbnew.In1_Cu, "+3V3": pcbnew.In2_Cu}
def _pc(p):                            # pad centre (mm) + half its larger extent
    bb = p.GetBoundingBox()
    return (MM((bb.GetLeft()+bb.GetRight())/2.0), MM((bb.GetTop()+bb.GetBottom())/2.0),
            max(MM(bb.GetRight()-bb.GetLeft()), MM(bb.GetBottom()-bb.GetTop()))/2.0)
_obs = [_pc(p) for f in board.GetFootprints() for p in f.Pads()]
_svias, _nstitch = [], 0
def _clear(vx, vy):                    # via (0.5mm) site clear of all pads, prior stitch vias, edge
    if not (x0+0.6 < vx < x1-0.6 and y0+0.6 < vy < y1-0.6): return False
    if any(((vx-ox)**2+(vy-oy)**2)**0.5 < 0.25+orad+0.25 for ox, oy, orad in _obs): return False
    if any(((vx-px)**2+(vy-py)**2)**0.5 < 0.7 for px, py in _svias): return False
    return True
for f in board.GetFootprints():
    for p in f.Pads():
        net = p.GetNetname()
        if net not in PLANE_OF or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
            continue
        pcx, pcy, pr = _pc(p); d = pr + 0.25 + 0.35
        for ang in (0, 90, 180, 270, 45, 135, 225, 315):
            vx, vy = pcx + d*math.cos(math.radians(ang)), pcy + d*math.sin(math.radians(ang))
            if _clear(vx, vy):
                v = pcbnew.PCB_VIA(board); v.SetPosition(vmm(vx, vy))
                v.SetDrill(pcbnew.FromMM(0.3)); v.SetWidth(pcbnew.FromMM(0.5)); v.SetNet(nets[net]); board.Add(v)
                t = pcbnew.PCB_TRACK(board); t.SetLayer(pcbnew.F_Cu); t.SetWidth(pcbnew.FromMM(0.2))
                t.SetStart(vmm(pcx, pcy)); t.SetEnd(vmm(vx, vy)); t.SetNet(nets[net]); board.Add(t)
                _svias.append((vx, vy)); _nstitch += 1
                break
        else:
            print(f"  WARN: no clear plane-stitch via for {f.GetReference()}.{p.GetNumber()} ({net})")
print(f"  plane stitching: {_nstitch} vias")

# NOTE: J1 is now the GCT USB4085 -- a 2-row THROUGH-HOLE Type-C. VBUS (A4/A9 front row,
# B4/B9 back row) and the data pair land on plated thru-holes the router reaches from either
# layer, so the old single-row HRO part's "+5V bridge" (off-pad vias east of the NPTH pegs,
# joined on B.Cu) is no longer needed -- Freerouting joins the +5V holes directly.

# Centre J1 on the bottom edge: shift in x so its BOUNDING BOX (not its origin -- the USB4085
# footprint puts the origin at pad A1, ~3 mm off the bbox centre) sits centred between the
# board's left/right edges.
_jl, _jr, _jt, _jb = fext(fps["J1"])
_pj = fps["J1"].GetPosition()
fps["J1"].SetPosition(pcbnew.VECTOR2I(_pj.x + pcbnew.FromMM((x0 + x1) / 2.0 - (_jl + _jr) / 2.0), _pj.y))

# J1 overhangs the bottom edge, so its default reference text lands off-board. Put it just
# ABOVE the connector body (inboard) instead.
jl, jr, jt, jb = fext(fps["J1"])
j1ref = fps["J1"].Reference()
j1ref.SetPosition(vmm((jl + jr) / 2.0, jt - 1.2))
j1ref.SetTextAngleDegrees(0)

# Overhanging parts (EDGE_OVERHANG) run their silkscreen off / across the board edge they
# overhang (silk_edge_clearance). Drop the silk graphics that extend past that edge; the fab
# clips off-board silk anyway and the part body is self-evident from its pads.
for _ref in EDGE_OVERHANG:
    _edge = EDGE_FLUSH[_ref]
    for _it in list(fps[_ref].GraphicalItems()):
        if _it.GetLayer() not in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            continue
        _b = _it.GetBoundingBox()
        if ((_edge == "left"   and MM(_b.GetLeft())   < x0) or
            (_edge == "right"  and MM(_b.GetRight())  > x1) or
            (_edge == "top"    and MM(_b.GetTop())    < y0) or
            (_edge == "bottom" and MM(_b.GetBottom()) > y1)):
            fps[_ref].Remove(_it)

board.BuildConnectivity()
out = os.path.join(HERE, "doorbell.kicad_pcb")
pcbnew.SaveBoard(out, board)
print(f"wrote {out} | footprints: {len(board.GetFootprints())} | nets: {board.GetNetCount()} "
      f"| board {x1-x0:.0f}x{y1-y0:.0f} mm")
