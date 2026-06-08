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
import os, sys, subprocess, math, re
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

# Inject net class rules into the DSN so Freerouting knows which layers each net
# belongs on. GND/+3V3 are restricted to their inner-plane layers — Freerouting
# places short vias from outer pads to reach them. USB_DP/USB_DM are restricted
# to B.Cu to keep the differential pair on one uninterrupted layer.
# Syntax: (circuit (use_layer "layer")) inside the class.
# Each net must belong to exactly one class, so remove them from kicad_default first.
NET_CLASSES = [
    ("gnd_plane",  ["GND"],             ["F.Cu", "In2.Cu"]),
    ("v3v3_plane", ["+3V3"],            ["F.Cu", "In1.Cu"]),
    ("usb_diff",   ["USB_DP","USB_DM"], ["F.Cu", "B.Cu"]),
]
RECLASSED = {n for _, nets, _ in NET_CLASSES for n in nets}

with open(DSN) as f: dsn = f.read()

# Remove reclassed nets from kicad_default only (bare tokens in the class header,
# not from the (net ...) definitions elsewhere in the DSN).
# Also restrict kicad_default nets to F.Cu + B.Cu (no inner layers for signals).
def _patch_default(m):
    block = m.group(0)
    for net in RECLASSED:
        block = re.sub(r'(?<=\s)' + re.escape(net) + r'(?=[\s\n])', '', block)
    block = re.sub(r'\(use_via',
                   '(use_layer "F.Cu")\n        (use_layer "B.Cu")\n        (use_via',
                   block)
    return block
dsn = re.sub(r'\(class kicad_default.*?\)', _patch_default, dsn, flags=re.DOTALL)

# Build new class entries (net names unquoted, matching kicad_default style)
via_m = re.search(r'\(use_via "([^"]+)"', dsn)
via_name = via_m.group(1) if via_m else "Via[0-3]_600:300_um"
def _class_entry(name, nets, layers):
    nets_str = " ".join(nets)
    layers_str = "\n        ".join(f'(use_layer "{l}")' for l in layers)
    return (f'    (class {name} {nets_str}\n'
            f'      (circuit\n'
            f'        {layers_str}\n'
            f'        (use_via "{via_name}")\n'
            f'      )\n'
            f'    )')

injection = "\n".join(_class_entry(*c) for c in NET_CLASSES)
# Insert inside the (network ...) block, before its closing ) which sits just
# before the (wiring ...) section.
dsn = re.sub(r'(\n  \)\n\s*\(wiring)', "\n" + injection + r'\1', dsn)
with open(DSN, 'w') as f: f.write(dsn)
print(f"exported {DSN} (injected {len(NET_CLASSES)} net class rule(s))")

subprocess.run([FREEROUTING, "-de", DSN, "-do", SES, "-mp", PASSES, "-da"], check=True)

if not pcbnew.ImportSpecctraSES(board, SES):
    sys.exit("SES import failed")

# --- inner planes: poured after routing; fill leaves clearance gaps around any
#     signal traces Freerouting placed on In1/In2. ---
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

board.BuildConnectivity()
pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(BOARD, board)
ngnd = sum(1 for f in board.GetFootprints() for p in f.Pads() if p.GetNetname() == "GND")
print(f"routed + inner planes + {nvia} stitching vias -> {BOARD} "
      f"({len(board.GetTracks())} track/via items, {ngnd} GND pads)")
