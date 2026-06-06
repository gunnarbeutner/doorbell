#!/usr/bin/env python3
"""Autoroute kicad/doorbell.kicad_pcb with Freerouting.

Exports a Specctra DSN from the board (pcbnew), runs Freerouting headless to produce a
.ses, then imports the session back and saves the routed board in place. Re-running
gen_pcb.py wipes the routes (fresh ratsnest), so the workflow is: edit design -> regen
board -> route.

Run with KiCad's bundled Python (owns pcbnew); see build.sh. Env:
    FR_PASSES   Freerouting max passes (default 20)
    FREEROUTING path to the freerouting launcher
"""
import os, sys, subprocess, math
HERE = os.path.dirname(os.path.abspath(__file__))
import pcbnew

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
DSN = os.path.join(HERE, "doorbell.dsn")
SES = os.path.join(HERE, "doorbell.ses")
FREEROUTING = os.environ.get("FREEROUTING",
                             "/Applications/freerouting.app/Contents/MacOS/freerouting")
PASSES = os.environ.get("FR_PASSES", "20")

board = pcbnew.LoadBoard(BOARD)
if not pcbnew.ExportSpecctraDSN(board, DSN):
    sys.exit("DSN export failed")
print(f"exported {DSN}")

subprocess.run([FREEROUTING, "-de", DSN, "-do", SES, "-mp", PASSES, "-da"], check=True)

if not pcbnew.ImportSpecctraSES(board, SES):
    sys.exit("SES import failed")

# --- ground pour + stitching vias: GND fill on BOTH copper layers (still a 2-layer
#     board), tied together by a grid of GND vias. Added after routing so the pour
#     floods around the signal traces; the antenna rule-area keep-out forbids fill
#     there, keeping the antenna clear. ---
def MM(v): return pcbnew.ToMM(v)
def Vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))
gnd = board.FindNet("GND")
edges = [d for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
bb = edges[0].GetBoundingBox()
for d in edges[1:]:
    bb.Merge(d.GetBoundingBox())
BL, BR, BT, BB = MM(bb.GetLeft()), MM(bb.GetRight()), MM(bb.GetTop()), MM(bb.GetBottom())

GND_FILL = False                        # TEST: set True for the GND pour + stitching vias
# GND zones on both copper layers
ins = 0.3
corners = [(BL+ins, BT+ins), (BR-ins, BT+ins), (BR-ins, BB-ins), (BL+ins, BB-ins)]
for layer in ((pcbnew.F_Cu, pcbnew.B_Cu) if GND_FILL else ()):
    z = pcbnew.ZONE(board); z.SetLayer(layer); z.SetNet(gnd)
    ch = pcbnew.SHAPE_LINE_CHAIN()
    for (cx, cy) in corners:
        ch.Append(Vmm(cx, cy))
    ch.SetClosed(True); z.AddPolygon(ch); board.Add(z)

# The +5V island (B.Cu) is created in gen_pcb.py so it's a plane during routing and
# Freerouting threads the VBUS pads to it. Here we just keep GND stitching vias out of it.
IX0 = IY0 = IX1 = IY1 = None
v5zones = [z for z in board.Zones() if z.GetNetname() == "+5V"]
if v5zones:
    zb = v5zones[0].GetBoundingBox()
    IX0, IY0, IX1, IY1 = MM(zb.GetLeft()), MM(zb.GetTop()), MM(zb.GetRight()), MM(zb.GetBottom())

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

VIA_R, CLR, PITCH, EDGE = 0.3, 0.6, 8.0, 1.5
def clear(px, py):
    if not (BL+EDGE < px < BR-EDGE and BT+EDGE < py < BB-EDGE):
        return False
    if KX0 < px < KX1 and KY0 < py < KY1:
        return False
    for (l, r, t, bo) in fpboxes:           # keep vias off component footprints
        if l-0.3 < px < r+0.3 and t-0.3 < py < bo+0.3:
            return False
    if IX0 is not None and IX0 - CLR < px < IX1 + CLR and IY0 - CLR < py < IY1 + CLR:
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

board.BuildConnectivity()
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(BOARD, board)
ngnd = sum(1 for f in board.GetFootprints() for p in f.Pads() if p.GetNetname() == "GND")
print(f"routed + GND pour + {nvia} stitching vias -> {BOARD} "
      f"({len(board.GetTracks())} track/via items, {ngnd} GND pads)")
