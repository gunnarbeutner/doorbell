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
    "U1":     (8, 47, 90),    # MCU rot 90° CW, lower-left; antenna overhangs the left edge
    "SW_boot":(23, 41, 0),    # BOOT button (spread apart from RST)
    "SW_en":  (31, 41, 180),  # EN / reset button (spread apart from BOOT)
    "R_boot": (23, 45, 0),    # BOOT pullup, under SW_boot
    "R_en":   (29, 45, 0),    # EN pullup, under SW_en
    "C_en":   (32, 45, 180),  # EN cap, under SW_en
    "U2":     (16, 49.5, 270),# SGM2212 LDO, rotated 90deg CCW; shifted left toward U1
    "R_io8": (4, 39.2, 180),  # GPIO8 strapping pull-up, underneath OK2 (rotated 180°)
    "C_in":   (18, 44, 0),    # LDO input cap (+5V), above U2 toward VIN (right)
    "C_out":  (14, 44, 0),    # LDO output cap (+3V3), above U2 toward VOUT (left)
    "LED1":   (17.5, 41, 90), # power LED, to the left of the BOOT button
    "R_led":  (14.5, 41, 90), # LED series resistor, left of LED1
    "C_dec":  (2.5, 56, 270), # U1 100nF decoupling, south of U1 (vertical)
    "C_3v3":  (5.55, 56, 270),# U1 10uF decoupling, south of U1 (equal spacing in the row)
    # === BOTTOM edge: USB-C + CC pulldowns above its CC pads ===
    "J1":     (25.8, 50, 0),  # USB-C (USB4085 THT) on the bottom edge; moved left to narrow board
    "R_cc1":  (24.5, 50, 90), # CC1 pulldown (manual placement)
    "R_cc2":  (33, 50, 90),   # CC2 pulldown (manual placement)
    # Protection diodes (manual placement): Schottky below U2, ESD array on D+/D- above J1.
    "D_vbus": (16, 56.5, 0),  # SS14 VBUS reverse-protection Schottky (SMA), below U2
    "D_esd":  (28.5, 49.5, 0),# SRV05-4 USB D+/D- ESD array
    # === TOP edge: WF26 terminal, centred above the bus interface ===
    "J2":     (28, 17, 180),  # WF26 6-way screw terminal, top edge (down, closing gap to relays)
    # === Bus interface above U1: optos (left) side-by-side with relays + drivers (right) ===
    "OC2":    (4,  34, 270),  # apartment bell sense (left, moved further down)
    "OC1":    (8,  34, 270),  # house bell sense (left)
    "R_lim1":  (8,  28, 0),    # R1, OC1's own LED limiter (above OC1) -- unshared
    "R_lim2": (4,  28, 0),    # R13, OC2's own LED limiter (above OC2) -- unshared
    "R_em":   (8,  39.2, 0),  # R3, south of OK1 (rotated CW 90°->0°), in the OK1<->U1 gap
    "K2":     (15.5, 27, 270),# chime-suppress relay, rotated CW (nudged left)
    "Q2":     (19.5, 34, 180),# NMOS, swapped with R_pd2 + rotated 180°
    "R_g2":   (12.32, 36.18, 180), # gate series R (R4), rotated flat (CCW); GATE2 pad kept fixed
    "R_pd2":  (11.5, 34, 90), # gate pulldown, swapped with Q2 + rotated 180°
    "D2":     (14.8, 33.6, 0),# flyback, moved north (toward K2 coil)
    "K1":     (27, 27, 270),  # door-opener relay, rotated CW (moved left)
    "Q1":     (31, 34, 180),  # NMOS, swapped with R_pd1 + rotated 180°
    "R_g1":   (23.82, 36.18, 180), # gate series R (R3), rotated flat (CCW); GATE1 pad kept fixed
    "R_pd1":  (23, 34, 90),   # gate pulldown, swapped with Q1 + rotated 180°
    "D1":     (26.3, 33.6, 0),# flyback, moved north (toward K1 coil)
}
MARGIN = 1.0           # board edge margin (mm) on non-flush edges (right edge only)

def vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

board = pcbnew.CreateEmptyBoard()
board.SetCopperLayerCount(4)        # 4-layer stack: F.Cu / In1=+3V3 / In2=GND / B.Cu (GND under B.Cu for the USB pair)
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

# --- 4-layer inner planes: In1.Cu = solid +3V3, In2.Cu = solid GND. GND is on In2 (adjacent to
#     B.Cu) so a USB D+/D- pair routed on B.Cu references the GND plane. Components reach the
#     planes through vias; +5V stays a (short) surface trace. Filled in route.py. ---
def add_plane(layer, netname):
    z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(nets[netname])
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for (cx, cy) in [(x0+0.3, y0+0.3), (x1-0.3, y0+0.3), (x1-0.3, y1-0.3), (x0+0.3, y1-0.3)]:
        ch.Append(vmm(cx, cy))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)
add_plane(pcbnew.In1_Cu, "+3V3")
add_plane(pcbnew.In2_Cu, "GND")

# --- pre-stitch every surface (SMD) GND/+3V3 pad to its inner plane with an offset via + a
#     short F.Cu stub. The planes are LT_POWER, so the autorouter won't via to them itself;
#     we make those connections here so Freerouting only has to route signals on F.Cu/B.Cu.
#     (THT power/GND pads already pass through the planes, so they're skipped.) ---
PLANE_OF = {"GND": pcbnew.In2_Cu, "+3V3": pcbnew.In1_Cu}
def _pc(p):                            # pad centre (mm) + bounding-circle radius (covers corners)
    bb = p.GetBoundingBox()
    return (MM((bb.GetLeft()+bb.GetRight())/2.0), MM((bb.GetTop()+bb.GetBottom())/2.0),
            (MM(bb.GetRight()-bb.GetLeft())**2 + MM(bb.GetBottom()-bb.GetTop())**2)**0.5/2.0)
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

# --- assembly fiducials: 3 global optical reference marks (1 mm copper / 2 mm mask opening),
#     grown inward from three corners (top-left, bottom-left, bottom-right). Three points (the
#     top-right is deliberately left empty) form an asymmetric triangle, so the pick-and-place
#     camera can resolve board orientation unambiguously. JLCPCB adds its own panel/rail fiducials
#     during assembly regardless, so these are belt-and-suspenders local references -- they cost
#     nothing and are good practice. Placed AFTER the stitch vias so the search avoids every pad
#     AND via; the footprint is bare copper (no net) and excluded from BOM + CPL (it is not a
#     placed part). This board is densely packed, so a fiducial must NOT land under a component
#     body -- the search clears every footprint's COURTYARD (not just its pads), so e.g. it won't
#     sit in the gap between J1's USB-C pad rows (under the connector shell). It walks a 0.5 mm grid
#     inward from each corner and takes the first spot that sits >=2 mm inside the board edge and
#     clears every courtyard by >=1.4 mm, every pad by >=1.5 mm, and every via -- which on this
#     layout lands them near the corners where room exists (the true BR/TR corners are full of
#     J1/J2, so those marks pull inboard). ---
FID_LIB = FP_LIB_DIRS["Fiducial"]
# Obstacles: per-pad bounding circles (mask-bridge clearance) + stitch vias + per-footprint
# COURTYARD rectangles (so a fiducial never lands under a part body). The fiducial's own courtyard
# is ~1.3 mm half-extent, so the 1.4 mm courtyard clearance also keeps DRC courtyard-overlap clean.
_fid_obst = list(_obs) + [(vx, vy, 0.25) for (vx, vy) in _svias]   # pads (r) + stitch vias (0.5mm)
def _crtyd_rect(f):
    cy = f.GetCourtyard(pcbnew.F_CrtYd)
    bb = cy.BBox() if (cy and cy.OutlineCount()) else f.GetBoundingBox(False, False)
    return (MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom()))
_fid_rects = [_crtyd_rect(f) for f in board.GetFootprints()]   # only real parts placed so far
def _rect_dist(px, py, l, r, t, bo):
    dx = max(l-px, 0.0, px-r); dy = max(t-py, 0.0, py-bo)
    return (dx*dx + dy*dy) ** 0.5
def _fid_clear(fx, fy):
    if not (x0+2.0 < fx < x1-2.0 and y0+2.0 < fy < y1-2.0): return False
    if any(((fx-ox)**2+(fy-oy)**2)**0.5 <= orad+1.5 for ox, oy, orad in _fid_obst): return False
    return all(_rect_dist(fx, fy, *R) >= 1.4 for R in _fid_rects)
def _fid_maskwin_keepout(fx, fy):
    # Minimal fence: keep autorouted F.Cu tracks/vias out of the fiducial's 2 mm mask WINDOW so no
    # foreign-net copper gets exposed in its aperture (a solder-mask bridge). F.Cu ONLY -- the mask
    # is front-side, so B.Cu / inner planes are left free; an all-layer keepout starved the dense
    # autorouting and broke a net. r = mask radius (1.0) + 0.1 margin. Pads allowed (the fiducial's
    # own pad sits here); pours are irrelevant on F.Cu (signals-only, no F.Cu plane).
    z = pcbnew.ZONE(board); z.SetIsRuleArea(True); z.SetLayer(pcbnew.F_Cu)
    z.SetDoNotAllowTracks(True); z.SetDoNotAllowVias(True)
    z.SetDoNotAllowPads(False); z.SetDoNotAllowFootprints(False); z.SetDoNotAllowZoneFills(False)
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for k in range(24):
        a = math.radians(k*15)
        ch.Append(vmm(fx+1.1*math.cos(a), fy+1.1*math.sin(a)))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)
def _place_fiducial(ref, cx, cy):              # cx,cy = the board corner to grow inward from
    sx, sy = (1 if cx == x0 else -1), (1 if cy == y0 else -1)
    for total in range(5, 60):                 # prefer spots closest to the corner (small dx+dy)
        for i in range(2, total-1):
            fx, fy = cx + sx*i*0.5, cy + sy*(total-i)*0.5
            if _fid_clear(fx, fy):
                fp = pcbnew.FootprintLoad(FID_LIB, "Fiducial_1mm_Mask2mm")
                fp.SetReference(ref); fp.SetValue("FID")
                fp.Reference().SetVisible(False)       # keep silk out of the fiducial clear area
                # Courtyard is KEPT (cleared of every part by >=1.4 mm above) so DRC courtyard-
                # overlap catches any future regression that puts a fiducial under a component.
                # The stock fiducial pad carries a 0.6 mm LOCAL clearance override. Freerouting
                # (driven from the DSN) does not honour per-pad local clearance on a netless pad,
                # so it routes to the 0.2 mm board default and KiCad's DRC then flags 0.2-0.6 mm
                # "violations" against the override. Drop the override (inherit the 0.2 mm board
                # clearance the router actually used) instead of fencing the fiducial off with a
                # keepout -- a keepout steals routing channels on this dense board and the
                # autorouter then fails to complete a net. 1.5 mm placement clearance keeps real
                # copper comfortably clear regardless.
                for _p in fp.Pads():
                    _p.SetLocalClearance(0)            # 0 => inherit board/net clearance
                fp.SetPosition(vmm(fx, fy))
                fp.SetAttributes(fp.GetAttributes() | pcbnew.FP_EXCLUDE_FROM_POS_FILES
                                 | pcbnew.FP_EXCLUDE_FROM_BOM)   # bare copper, not a placed part
                board.Add(fp)
                _fid_maskwin_keepout(fx, fy)
                _fid_rects.append(_crtyd_rect(fp))     # keep the next fiducial off this one
                return (fx, fy)
    raise RuntimeError(f"no clear fiducial location found for {ref}")
_fids = [_place_fiducial("FID1", x0, y0),      # top-left
         _place_fiducial("FID2", x0, y1),      # bottom-left
         _place_fiducial("FID3", x1, y1)]      # bottom-right (top-right left empty -> asymmetric)
print(f"  fiducials: {len(_fids)} placed at " + ", ".join(f"({x:.1f},{y:.1f})" for x, y in _fids))

# NOTE: J1 is now the GCT USB4085 -- a 2-row THROUGH-HOLE Type-C. VBUS (A4/A9 front row,
# B4/B9 back row) and the data pair land on plated thru-holes the router reaches from either
# layer, so the old single-row HRO part's "+5V bridge" (off-pad vias east of the NPTH pegs,
# joined on B.Cu) is no longer needed -- Freerouting joins the +5V holes directly.

# Place J2 (WF26 screw terminal) toward the RIGHT: align its right edge ~2 mm inside the board's
# right edge (frees the upper-left corner for the product name). J1 is placed explicitly.
_jl, _jr, _jt, _jb = fext(fps["J2"])
_pj = fps["J2"].GetPosition()
fps["J2"].SetPosition(pcbnew.VECTOR2I(_pj.x + pcbnew.FromMM((x1 - 2.0) - _jr), _pj.y))

# J2 (WF26 terminal) per-screw labels on the front silk so the bus lines are unambiguous when
# wiring in the wall: pad n -> net Pn; pad 6 = IN-P4, the line-4 return to the WF26's terminal 4.
_J2_LBL = {"1": "P1", "2": "P2", "3": "P3", "4": "P4", "5": "P5", "6": "IN4"}
for _p in fps["J2"].Pads():
    _lbl = _J2_LBL.get(_p.GetNumber())
    if not _lbl:
        continue
    _pp = _p.GetPosition()
    _jt2 = pcbnew.PCB_TEXT(board)
    _jt2.SetText(_lbl)
    _jt2.SetLayer(pcbnew.F_SilkS)
    _jt2.SetPosition(pcbnew.VECTOR2I(_pp.x, _pp.y + pcbnew.FromMM(4.6)))   # in the gap below J2 body silk, above K1
    _jt2.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
    _jt2.SetTextThickness(pcbnew.FromMM(0.12))
    board.Add(_jt2)

# Hide J2's own reference: 30/35 parts already hide their refdes, and J2's "J2" was the one
# sitting in the pin-label row -- the only refdes exposed once the slots are populated. The
# P1..P5/IN4 functional labels are what matter at this connector; "J2" still lives in the BOM/CPL.
fps["J2"].Reference().SetVisible(False)

# J1 overhangs the bottom edge, so its default reference text lands off-board. Put it just
# ABOVE the connector body (inboard) instead.
jl, jr, jt, jb = fext(fps["J1"])
j1ref = fps["J1"].Reference()
# D5 (ESD array) sits above J1; put the J1 label underneath the connector (bottom strip).
j1ref.SetPosition(vmm(28.8, 58.3))
j1ref.SetTextAngleDegrees(0)

# Relays sit close together; the default side-placed refdes overlaps the neighbour's body
# silk. Centre each relay's reference on its own body instead.
for _k in ("K1", "K2"):
    _kl, _kr, _kt, _kb = fext(fps[_k])
    _kref = fps[_k].Reference()
    _kref.SetPosition(vmm((_kl + _kr) / 2.0, (_kt + _kb) / 2.0))
    _kref.SetTextAngleDegrees(0)

# Silkscreen labels above the user-facing buttons.
for _sw, _txt in (("SW_boot", "BOOT"), ("SW_en", "RST")):
    _sl, _sr, _st, _sb = fext(fps[_sw])
    _lab = pcbnew.PCB_TEXT(board)
    _lab.SetText(_txt)
    _lab.SetLayer(pcbnew.F_SilkS)
    _lab.SetPosition(vmm((_sl + _sr) / 2.0, _st - 1.0))
    _lab.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.0), pcbnew.FromMM(1.0)))
    _lab.SetTextThickness(pcbnew.FromMM(0.15))
    board.Add(_lab)

# Product name on the front silkscreen, in the freed upper-left corner.
_pn = pcbnew.PCB_TEXT(board)
_pn.SetText("Doorbell Ctrl V4")
_pn.SetLayer(pcbnew.F_SilkS)
_pn.SetPosition(vmm(4.4, 19))
_pn.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.0), pcbnew.FromMM(1.0)))
_pn.SetTextThickness(pcbnew.FromMM(0.15))
_pn.SetTextAngleDegrees(90)   # rotated CCW (reads bottom-to-top)
board.Add(_pn)

# Board revision + date, parallel to the product name (also reads bottom-to-top).
_rd = pcbnew.PCB_TEXT(board)
_rd.SetText("rev A  2026-06-07")
_rd.SetLayer(pcbnew.F_SilkS)
_rd.SetPosition(vmm(6.6, 19))
_rd.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
_rd.SetTextThickness(pcbnew.FromMM(0.13))
_rd.SetTextAngleDegrees(90)
board.Add(_rd)

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
