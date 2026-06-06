#!/usr/bin/env python3
"""Generate kicad/doorbell.kicad_pcb (footprints placed + nets assigned + outline).

Uses KiCad's native `pcbnew` API, so the board is a valid KiCad 10 file with a proper
layer stack. Circuit data (components, nets, footprints) comes from doorbell_design.py;
the PCB-specific placement lives HERE in `PCB_PLACE` (a schematic's layout and a board's
layout are different problems, so the board gets its own deliberate, compact placement).

The board comes out *placed and netted* (full ratsnest) but UNROUTED — route it with
route.py / `build.sh route`. Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import (COMP, REF, FOOTPRINT, NETS, FP_LIB_DIRS,
                             EDGE_FLUSH, ANTENNA_REF)

# ---- PCB placement: ref -> (x_mm, y_mm, rotation_deg) ----
# Two zones split by an isolation gap (~x=44): LOGIC/USB on the left, BUS interface
# (relays + optos + WF26 terminal) on the right. Connectors on opposite edges. The
# ESP32 module's antenna keep-out (top ~8mm, pad-free) faces the TOP board edge and is
# protected by a copper keep-out zone (see below); nothing is placed above U1.
PCB_PLACE = {
    # === LEFT column: USB-C, buttons, power LED ===
    "SW_en":  (8,  14, 0),
    "SW_boot":(8,  23, 0),
    "J1":     (5,  33, 90),   # USB-C on the left edge
    "LED1":   (4,  9,  0),    # power LED, top-left corner
    "R_led":  (9,  9,  0),
    # === TOP edge: ESP32 (antenna -> top edge) + caps + WAGO (both rotated) ===
    "U1":     (24, 17, 0),    # antenna keep-out (top, pad-free) auto-detected -> top edge
    "C_3v3":  (14, 15, 90),   # decoupling at U1's 3V3/GND pins (left side)
    "C_dec":  (14, 11, 90),   # 2nd decoupling, also by the 3V3/GND pins (left side)
    "J2":     (56, 11, 180),  # WF26 spring terminal, horizontal on the top edge
    # === relays side-by-side UNDER the WAGO, drivers in a row below; optos kept ===
    "K1":     (63, 26, 0),    # door-opener relay, under the WAGO (right)
    "Q1":     (59, 33, 0),
    "R_g1":   (63, 33, 0),
    "R_pd1":  (67, 33, 0),
    "D1":     (59, 36, 0),
    "OC1":    (42, 23, 270),  # house bell sense (between U1 and K2, rot 180)
    "K2":     (50, 26, 0),    # chime-suppress relay, under the WAGO (left)
    "Q2":     (46, 33, 0),
    "R_g2":   (50, 33, 0),
    "R_pd2":  (54, 33, 0),
    "D2":     (46, 36, 0),
    "OC2":    (37, 23, 270),  # apartment bell sense (between U1 and K2, rot 180)
    # LDO up underneath U1 (x unchanged); its caps + the rest stay on the bottom row
    "U2":     (18, 31, 180),
    "C_in":   (14, 39, 270),  # LDO input cap, left of C1, +5V pad up (rot CW)
    "C_out":  (26, 31, 0),    # LDO output cap, right of U2 (clear of its pads)
    "C_bulk": (18, 39, 0),    # bulk cap, south of U2
    "R_cc1":  (10.5, 35, 270), # CC1 pulldown, right of J1 (90 CW), vertically aligned
    "R_cc2":  (10.5, 30.43, 90), # CC2 pulldown; CC2 pad aligned to J1 CC2 pad (Y=31.25)
    "R_en":   (3,  13, 0),    # EN resistor, left of the reset button (SW2)
    "C_en":   (3,  16, 180),  # EN cap, left of the reset button (SW2)
    "R_boot": (3,  23, 0),    # to the left of the boot button (SW1)
    "R_lim":  (47, 19, 0),   # R1 north of K2, close to OK1 (nudged right)
    "R_em":   (42, 29, 0),   # R2 underneath OK1 (rotated CCW to horizontal)
}
MARGIN = 4.0           # board edge margin (mm) on non-flush edges

def vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

board = pcbnew.CreateEmptyBoard()

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
    edge_line[edge] = line
    for r in refs:                     # align this part's outer face to the line
        d = line - edge_of(fps[r], edge); p = fps[r].GetPosition()
        if edge in ("left", "right"):
            fps[r].SetPosition(pcbnew.VECTOR2I(p.x + pcbnew.FromMM(d), p.y))
        else:
            fps[r].SetPosition(pcbnew.VECTOR2I(p.x, p.y + pcbnew.FromMM(d)))

# --- antenna copper keep-out = U1's pad-free side, from its final placed geometry ---
u1 = fps[ANTENNA_REF]
fbl, fbr, fbt, fbb = fext(u1)
pl = pr = pt = pb = None
for p in u1.Pads():
    bb = p.GetBoundingBox()
    l, r, t, b = MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())
    pl = l if pl is None else min(pl, l); pr = r if pr is None else max(pr, r)
    pt = t if pt is None else min(pt, t); pb = b if pb is None else max(pb, b)
side = max({"left": pl - fbl, "right": fbr - pr, "top": pt - fbt, "bottom": fbb - pb}.items(),
           key=lambda kv: kv[1])[0]
if side == "top":      ka = (fbl, fbt, fbr, pt)
elif side == "bottom": ka = (fbl, pb, fbr, fbb)
elif side == "left":   ka = (fbl, fbt, pl, fbb)
else:                  ka = (pr, fbt, fbr, fbb)
kx0, ky0, kx1, ky1 = ka

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

zone = pcbnew.ZONE(board)
zone.SetIsRuleArea(True)
zone.SetDoNotAllowZoneFills(True)
zone.SetDoNotAllowTracks(True)
zone.SetDoNotAllowVias(True)
zone.SetDoNotAllowPads(True)
zone.SetLayerSet(pcbnew.LSET.AllCuMask())
chain = pcbnew.SHAPE_LINE_CHAIN()
for (px, py) in [(kx0, ky0), (kx1, ky0), (kx1, ky1), (kx0, ky1)]:
    chain.Append(vmm(px, py))
chain.SetClosed(True)
zone.AddPolygon(chain)
zone.SetZoneName("antenna keep-out")
board.Add(zone)

# +5V island on B.Cu in clear space near the USB-C. Present BEFORE routing so the DSN
# marks +5V as a plane here and Freerouting threads the VBUS pads (and the other +5V
# pins) to it -- the dense connector escape is the router's job, not a hand-drawn neck.
# iz = pcbnew.ZONE(board)
# iz.SetLayer(pcbnew.B_Cu)
# iz.SetNet(nets["+5V"])
# iz.SetAssignedPriority(10)              # win over the GND pour where they overlap
# ich = pcbnew.SHAPE_LINE_CHAIN()
# for (px, py) in [(7.125, 28.7), (8.75, 28.7), (8.75, 35.3), (7.125, 35.3)]:
#     ich.Append(vmm(px, py))
# ich.SetClosed(True)
# iz.AddPolygon(ich)
# iz.SetZoneName("+5V island")
# board.Add(iz)

board.BuildConnectivity()
out = os.path.join(HERE, "doorbell.kicad_pcb")
pcbnew.SaveBoard(out, board)
print(f"wrote {out} | footprints: {len(board.GetFootprints())} | nets: {board.GetNetCount()} "
      f"| board {x1-x0:.0f}x{y1-y0:.0f} mm")
