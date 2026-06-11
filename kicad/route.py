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
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import GROUPS, REF

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
DSN = os.path.join(HERE, "doorbell.dsn")
SES = os.path.join(HERE, "doorbell.ses")
# Default to the repo's patched build (v2.2.4 + degenerate-polyline guard, see
# tools/freerouting-npe-fix.patch): stock v2.2.4 NPEs on this board's locked wiring.
_TOOLS_FR = os.path.join(HERE, "..", "tools", "freerouting")
FREEROUTING = os.environ.get(
    "FREEROUTING",
    _TOOLS_FR if os.path.exists(_TOOLS_FR)
    else "/Applications/freerouting.app/Contents/MacOS/freerouting")
PASSES = os.environ.get("FR_PASSES", "20")

board = pcbnew.LoadBoard(BOARD)

# --- Pre-fill inner planes before DSN export so Freerouting sees solid GND/+3V3 copper
#     on In2/In1 and connects pads to them with short via stubs instead of long surface
#     traces.  The DSN export includes the filled zone copper as pre-existing wiring.
#     Zones are re-filled after the SES import to incorporate the new routing. ---
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

# Fully hand-routed? If the locked pre-routes + inner planes already satisfy every
# connection, skip Freerouting entirely — there is nothing for it to add, and the
# DSN -> Freerouting -> SES round-trip is the flakiest part of the pipeline.
board.BuildConnectivity()
try:
    _unrouted = board.GetConnectivity().GetUnconnectedCount(False)
except TypeError:                       # older API: no aVisibleOnly argument
    _unrouted = board.GetConnectivity().GetUnconnectedCount()

def _autoroute():
    if not pcbnew.ExportSpecctraDSN(board, DSN):
        sys.exit("DSN export failed")
    _patch_and_route()
    if not pcbnew.ImportSpecctraSES(board, SES):
        sys.exit("SES import failed")

def _patch_and_route():
    _inject_net_classes()
    subprocess.run([FREEROUTING, "-de", DSN, "-do", SES, "-mp", PASSES, "-da", "-mt", "1",
                    "--router.optimizer.enabled=true"], check=True)

# Inject net class rules into the DSN so Freerouting knows which layers each net
# belongs on. GND/+3V3 are restricted to their inner-plane layers — Freerouting
# places short vias from outer pads to reach them. USB_DP/USB_DM are restricted
# to B.Cu to keep the differential pair on one uninterrupted layer.
# Syntax: (circuit (use_layer "layer")) inside the class.
# Each net must belong to exactly one class, so remove them from kicad_default first.
# GND is allowed on F.Cu + In2.Cu + B.Cu; +3V3 on F.Cu + In1.Cu + B.Cu.
# B.Cu must be included because the only via is a full through-hole (F.Cu→In1→In2→B.Cu):
# omitting B.Cu makes the via illegal for GND/+3V3 and Freerouting falls back to flat
# F.Cu traces, never reaching the inner planes.  Signal nets (kicad_default) are
# restricted to outer layers only so they cannot pollute In1/In2.  Post-route,
# _add_plane() floods the remaining In1/In2 copper as solid pours.
# Per-class track width (µm, DSN units): nets without a width fall back to the global
# (rule (width 200)) from the structure section, i.e. 0.2 mm. +5V feeds the LDO (ESP32
# WiFi-TX peaks ~350 mA) plus three relay coils; the P-bus nets carry the chime solenoid
# current through K3's NC contact — both get 0.5 mm.
NET_CLASSES = [
    # name        nets                                            layers                      width_um
    ("gnd_plane",  ["GND"],             ["F.Cu", "In2.Cu", "B.Cu"], None),
    ("v3v3_plane", ["+3V3"],            ["F.Cu", "In1.Cu", "B.Cu"], None),
    # both sides of the TPD2S017 (connector-side + ESP-side) stay on outer layers
    ("usb_diff",   ["USB_DP","USB_DM","USB_DP_ESP","USB_DM_ESP"], ["F.Cu", "B.Cu"], None),
    ("power",      ["+5V"],                                       ["F.Cu", "B.Cu"], 500),
    # every net galvanically tied to the WF26 bus (bus potential): the P-bus itself, the
    # ÖT bridge (K2 contact <-> R16), and the opto sense legs up to the LED (switch
    # outputs, LED cathode/limiter nodes, limiter returns). NOT bus potential: OCx_OUT /
    # OC_EMIT (opto transistor side), SEC_A/SEC_B (behind T1's isolation), GATE1/_PRE
    # (K3's interlock pole switches 3.3V only).
    ("bus",        ["P1","P2","P3","P4","P5","IN_P4","OT_BRIDGE",
                    "OC1_JP","OC2_JP","OC3_JP",
                    "OC1_CATH","OC2_CATH","OC3_CATH",
                    "OC1_RET","OC2_RET","OC3_RET"],               ["F.Cu", "B.Cu"], 500),
]
RECLASSED = {n for _, nets, _, _ in NET_CLASSES for n in nets}

def _inject_net_classes():
    with open(DSN) as f: dsn = f.read()

    # Relax the routing clearance/track that Freerouting honours from KiCad's default 0.2mm/0.2mm
    # to JLCPCB's published fine-pitch capability (0.127mm clearance / 0.15mm track) -- the same
    # fab limit the board already allows for J1. The default 0.2mm clearance acts as a too-wide
    # keepout halo around every pad and makes the 0.40mm-pitch ES8311 (U3) un-escapable (a 0.6mm
    # via can't sit beside a fine-pitch pin). The (clearance 50 (type smd_smd)) entry is left
    # untouched.
    dsn = re.sub(r'\(clearance 200\)', '(clearance 127)', dsn)

    # Remove reclassed nets (USB_DP/USB_DM) from kicad_default, and restrict ALL nets
    # (including GND/+3V3) to the outer copper layers only.  In1.Cu (+3V3) and In2.Cu
    # (GND) are filled as solid copper pours after routing; Freerouting must not place
    # signal traces there.  Through-hole vias still drill through all 4 layers, so their
    # barrels connect GND/+3V3 pads to the inner-plane pours automatically.
    def _patch_default(m):
        block = m.group(0)
        for net in RECLASSED:
            block = re.sub(r'(?<=\s)' + re.escape(net) + r'(?=[\s\n])', '', block)
        # Prepend use_layer directives before the existing use_via entry.
        block = re.sub(
            r'(\s*)\(use_via ',
            r'\1(use_layer "F.Cu")\1(use_layer "B.Cu")\1(use_via ',
            block,
        )
        return block
    dsn = re.sub(r'\(class kicad_default.*?\)', _patch_default, dsn, flags=re.DOTALL)

    # Build new class entries (net names unquoted, matching kicad_default style)
    via_m = re.search(r'\(use_via "([^"]+)"', dsn)
    via_name = via_m.group(1) if via_m else "Via[0-3]_600:300_um"
    def _class_entry(name, nets, layers, width_um=None):
        nets_str = " ".join(nets)
        layers_str = "\n        ".join(f'(use_layer "{l}")' for l in layers)
        rule_str = f'\n      (rule (width {width_um}))' if width_um else ''
        return (f'    (class {name} {nets_str}\n'
                f'      (circuit\n'
                f'        {layers_str}\n'
                f'        (use_via "{via_name}")\n'
                f'      ){rule_str}\n'
                f'    )')

    injection = "\n".join(_class_entry(*c) for c in NET_CLASSES)
    # Insert inside the (network ...) block, before its closing ) which sits just
    # before the (wiring ...) section.
    dsn = re.sub(r'(\n  \)\n\s*\(wiring)', "\n" + injection + r'\1', dsn)
    with open(DSN, 'w') as f: f.write(dsn)
    print(f"exported {DSN} (injected {len(NET_CLASSES)} net class rule(s))")

if _unrouted == 0:
    print("0 unrouted connections -- board is fully hand-routed; skipping Freerouting")
else:
    print(f"{_unrouted} unrouted connection(s) -> Freerouting")
    _autoroute()

# --- Subassembly groups: created HERE (post-route) so they never reach the Specctra DSN export --
#     groups on the board confuse the DSN export and break the autoroute. Add them to the routed
#     board by finding each member footprint by refdes. ---
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
