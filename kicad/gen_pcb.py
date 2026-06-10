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
                             EDGE_FLUSH, EDGE_OVERHANG, ANTENNA_REF)

# ---- PCB placement: ref -> (x_mm, y_mm, rotation_deg) ----
# LOGIC/USB section in the lower-left: the ESP32 with its LDO / boot+reset / LED / decoupling
# support clustered just above it, and the USB-C centred on the bottom edge. BUS interface
# (WF26 terminal, optos, bell-sense R, relays + drivers) on the right. The ESP32 antenna
# overhangs the left board edge (off-board), so no copper keep-out is needed.
PCB_PLACE = {
    # === LOWER-LEFT: ESP32 + its power / boot / LED support ===
    "U1":     (13, 53.7, 180),  # WROOM, rot 180° (antenna faces south, flush bottom)
    "SW_boot":(8.500, 40, 180),  # BOOT button, CW from vertical → horizontal, above U1
    "R_boot": (13.500, 40, 180),  # BOOT pullup, right of SW_boot (was above → right after CW)
    "SW_en":  (22, 40, 0),    # RST button, right of BOOT group
    "R_en":   (17, 39, 0),    # EN pullup, above SW_en
    "C_en":   (17, 41, 180),  # EN cap, below SW_en
    "U2":     (44.5, 44.0, 180), # SGM2212 LDO; rotated CW
    "R_io8":  (24.2, 52.05, 270), # GPIO8 pull-up; right of U1 east face
    "C_in":   (43.25, 48.25, 0), # LDO input cap (C2)
    "C_out":  (41.5, 38.75, 270), # LDO output cap (C4)
    "LED1":   (48.0, 18.5, 90), # power LED; right of J2
    "R_led":  (48.0, 15.5, 270), # LED series resistor; right of J2
    "C_dec":  (24.2, 61.2, 270),  # 100nF decoupling; just clear of U1's east courtyard
    "C_3v3":  (25.75, 61.2, 270),  # 10uF decoupling; same row, next to C_dec
    # === BOTTOM edge: USB-C + CC pulldowns above its CC pads ===
    "J1":     (44.1, 60, 0),  # USB-C (USB4105: SMD pads, THT shell stakes); A9/B4 VBUS
                              # column at x=46.5, in line with F1 pin 1 and its via
    "R_cc1":  (49.21, 59.75, 90), # CC1 pulldown
    "R_cc2":  (47.93, 59.75, 90), # CC2 pulldown
    # Protection diodes: Schottky below U2, ESD array on D+/D- above J1.
    "D_vbus": (44.25, 51, 0), # SS14 VBUS reverse-protection Schottky
    "D_esd":  (44, 59.25, 0),# TPD2S017 USB D+/D- flow-through ESD clamp
    "D_tvs":  (43, 54, 180), # SMF5.0A VBUS TVS
    "F_vbus": (46.5, 55.25, 90), # 1A VBUS fuse
    # === TOP edge: WF26 terminal, centred above the bus interface ===
    "J2":     (28, 17, 180),  # WF26 6-way screw terminal, top edge (down, closing gap to relays)
    # === Polarity switches: DPDT SMD slide switches, 9 mm pitch, Y=18 left of J2.
    #     Y=18 keeps the ±4.3 mm-extent SMD footprint inside the board outline. ===
    # rotated 180°: pads map 1↔6/2↔5/3↔4 onto the same spots, matching the JP/RET
    # pin swap in doorbell_design.py — copper layout identical to rot 0.
    "SW_OC3": (2,  18, 180),
    "SW_OC2": (8,  18, 180),
    "SW_OC1": (14, 18, 180),
    # === Bus interface above U1: optos (left) side-by-side with relays + drivers (right) ===
    "OC3":    (2.74, 33.5, 270),   # apartment bell sense; opto block centered in UL quadrant
    "OC2":    (6.74, 33.5, 270),   # house bell sense; opto block centered in UL quadrant
    "OC1":    (10.74, 33.5, 270),  # session-sense opto; right of OC2 in the bell-sense row
    "R_lim1": (6.74, 23.25, 0),    # R1, OC2's own LED limiter (above OC2) -- unshared
    "R_lim2": (2.74, 23.25, 0),    # R2, OC3's own LED limiter (above OC3) -- unshared
    "R_lim3": (10.74, 23.25, 0),   # R17, OC1's LED limiter (above OC1)
    # Opto LED reverse-voltage clamps (1N4148W anti-parallel): between R_lim and opto, same column.
    # Rotated 270->90 with the 2026-06-10 net-pin swap (pads keep their previous XY positions).
    "D_oc3":  (2.74, 26.5, 90),
    "D_oc2":  (6.74, 26.5, 90),
    "D_oc1":  (10.74, 26.5, 90),
    "R_em":   (0, 35.82, 90),      # R3, emitter common resistor
    "K3":     (19.5, 27, 270),# chime-suppress relay, shifted +4mm right to clear OC1 column
    "Q3":     (23.5, 34, 180),# NMOS, swapped with R_pd3 + rotated 180°
    "R_g3":   (14.75, 36.5, 0),   # gate series R; rotated 180°, Y adjusted
    "R_pd3":  (15.5, 34, 90), # gate pulldown, swapped with Q3 + rotated 180°
    "D3":     (18.8, 33.6, 0),# flyback, moved north (toward K3 coil)
    "K2":     (31, 27, 270),  # door-opener relay, rotated CW
    "Q2":     (35, 34, 180),  # NMOS, swapped with R_pd2 + rotated 180°
    "R_g2":   (26.25, 36.5, 0),   # gate series R; rotated 180°, Y adjusted
    "R_pd2":  (27, 34, 90),   # gate pulldown, swapped with Q2 + rotated 180°
    "D2":     (30.3, 33.6, 0),# flyback, moved north (toward K2 coil)
    "R_ot":   (21.25, 20.5, 270), # ÖT bridge 2.2k: above K3 (top of relay body)
    # === K1 (PTT placeholder) relay + driver: same spacing as K3→K2 (11.5 mm) ===
    "K1":     (42.5, 27, 270),
    "Q1":     (46.5, 34, 180),
    "R_g1":   (13.5, 34, 90),
    "R_pd1":  (38.5, 34, 90),
    "D1":     (41.8, 33.6, 0),
    # === Audio codec (ES8388) cluster: open right region (x>70); board grows rightward.
    #     Provisional placement — reorganise later. ===
    # ES8311 rot 180. Support passives packed tight against the edge carrying their U3 pin, each
    # oriented so its U3-connected pad faces inward (rot: 0=pad1 W, 90=pad1 S, 180=pad1 E, 270=pad1 N).
    # West edge (I2S 6-9 -> U1) kept clear. Sides at rot180: N=CCLK/MCLK/PVDD/DVDD/DGND,
    # E=CE/CDATA/MIC1P/MIC1N/VMID, S=AVDD/OUTP/OUTN/DACVREF/ADCVREF.
    "U3":     (78, 22, 180),
    # Passives sit ~2 mm off U3's pad toes -- a clear ring for the pin escapes/vias -- then ring out.
    # NORTH row: PVDD/DVDD decoupling + SCL pull-up (pad-to-U3 faces south)
    "C_dv":   (76.8, 17.3, 90), "C_pv": (78.0, 17.3, 90), "R_scl": (79.2, 17.3, 270),
    "R_ce":   (27.25, 43.25, 180), # CE addr pull-down (10k to GND)
    # EAST column: VMID + MIC coupling + SDA pull-up (pad-to-U3 faces west)
    "R_sda": (82.7, 20.3, 180), "C_mp": (82.7, 21.6, 0), "C_mn": (82.7, 22.9, 0), "C_vmid": (82.7, 24.2, 0),
    # SOUTH row: AVDD decoupling/bulk + OUT coupling + DAC/ADC refs (pad-to-U3 faces north),
    # nudged right to clear T1 on the left.
    "C_av":   (76.1, 27.2, 270), "C_avb": (77.3, 27.2, 270), "C_op": (78.5, 27.2, 270),
    "C_on":   (79.7, 27.2, 270), "C_vref": (80.9, 27.2, 270), "C_aref": (82.1, 27.2, 270),
    # isolation transformer to the LEFT of U3, rotated clockwise (vertical). Winding A faces the
    # bus (P1/P5) to the west; secondary reaches the OUT/MIC coupling caps.
    "T1":     (69, 30, 270),
}
MARGIN = 1.0           # board edge margin (mm) on non-flush edges (right edge only)

def vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

board = pcbnew.CreateEmptyBoard()
board.SetCopperLayerCount(4)        # 4-layer stack: F.Cu / In1 / In2 / B.Cu
board.SetLayerType(pcbnew.In1_Cu, pcbnew.LT_MIXED)
board.SetLayerType(pcbnew.In2_Cu, pcbnew.LT_MIXED)

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

# --- Rotate the whole audio sub-block (codec U3 + its support passives, NOT T1) 180 deg as a
#     rigid body, then place it BELOW T1. Relative orientations are preserved, so the pad-facing
#     packing survives. Done here -- before the EP-via / edge logic -- so they follow U3's new pos.
_TOMM = pcbnew.ToMM
_AUDIO_BLK = ["U3", "C_dv", "C_pv", "R_scl", "C_vmid", "C_mp", "C_mn", "R_sda",
              "C_av", "C_avb", "C_op", "C_on", "C_vref", "C_aref"]
_acx = sum(_TOMM(fps[k].GetPosition().x) for k in _AUDIO_BLK) / len(_AUDIO_BLK)
_acy = sum(_TOMM(fps[k].GetPosition().y) for k in _AUDIO_BLK) / len(_AUDIO_BLK)
for k in _AUDIO_BLK:                        # 180 deg about the block centroid
    _p = fps[k].GetPosition()
    fps[k].SetPosition(vmm(2 * _acx - _TOMM(_p.x), 2 * _acy - _TOMM(_p.y)))
    fps[k].SetOrientationDegrees((fps[k].GetOrientationDegrees() + 180) % 360)
def _bbx(k):                                # footprint bbox (mm), no silk text
    _b = fps[k].GetBoundingBox(False, False)
    return _TOMM(_b.GetLeft()), _TOMM(_b.GetRight()), _TOMM(_b.GetTop()), _TOMM(_b.GetBottom())
_t1bx = _bbx("T1")
_bxs = [_bbx(k) for k in _AUDIO_BLK]
_bl = min(b[0] for b in _bxs); _br = max(b[1] for b in _bxs); _bt = min(b[2] for b in _bxs)
_dx = (_t1bx[0] + _t1bx[1]) / 2 - (_bl + _br) / 2   # centre horizontally under T1
_dy = (_t1bx[3] + 2.0) - _bt                         # block top 2 mm below T1's bottom
for k in _AUDIO_BLK:
    _p = fps[k].GetPosition()
    fps[k].SetPosition(pcbnew.VECTOR2I(_p.x + pcbnew.FromMM(_dx), _p.y + pcbnew.FromMM(_dy)))

# --- Rotate the entire audio codec group (U3 + support passives + T1) 90° CW as a rigid body,
#     then shift to sit between U1 (right edge ≈27 mm) and the USB/LDO area (J1 ≈56 mm). ---
_FULL_AUDIO = _AUDIO_BLK + ["T1"]
_fcx = sum(_TOMM(fps[k].GetPosition().x) for k in _FULL_AUDIO) / len(_FULL_AUDIO)
_fcy = sum(_TOMM(fps[k].GetPosition().y) for k in _FULL_AUDIO) / len(_FULL_AUDIO)
for k in _FULL_AUDIO:
    _px = _TOMM(fps[k].GetPosition().x)
    _py = _TOMM(fps[k].GetPosition().y)
    fps[k].SetPosition(vmm(_fcx - (_py - _fcy), _fcy + (_px - _fcx)))
    fps[k].SetOrientationDegrees((fps[k].GetOrientationDegrees() + 270) % 360)
_audio_left = min(_bbx(k)[0] for k in _FULL_AUDIO)
_audio_shift = (_bbx("R_io8")[1] + 1.0) - _audio_left
for k in _FULL_AUDIO:
    _p = fps[k].GetPosition()
    fps[k].SetPosition(pcbnew.VECTOR2I(_p.x + pcbnew.FromMM(_audio_shift), _p.y))

# Place T1 below U3 with 2 mm clearance, rotated 180° from its group orientation.
fps["T1"].SetOrientationDegrees((fps["T1"].GetOrientationDegrees() + 180) % 360)
_u3bb = _bbx("U3")
_t1bb = _bbx("T1")
fps["T1"].SetPosition(vmm(
    (_u3bb[0] + _u3bb[1]) / 2.0 + 1.0,
    _u3bb[3] + 2.0 + (_t1bb[3] - _t1bb[2]) / 2.0,
))

# On 4 layers the LDO's GND/heat reaches the inner GND plane through its thermal vias, so its
# bottom (B.Cu) thermal pad is redundant -- drop it to free B.Cu under U2 for the USB pair.
for _p in list(fps["U2"].Pads()):
    if _p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD and _p.IsOnLayer(pcbnew.B_Cu) and not _p.IsOnLayer(pcbnew.F_Cu):
        fps["U2"].Remove(_p)

# --- ES8311 (U3) exposed-pad thermal vias: contained, deliberate exception to no-via-in-pad.
#     The QFN-20 center EP (GND) cannot reach the inner GND plane via an offset via at 0.40 mm
#     pitch (boxed in by the perimeter pins), so drop a 2x2 GND via array INSIDE the EP. Placed
#     here (pre-route) so Freerouting sees the EP already grounded and routes the perimeter GND
#     pins normally instead of thrashing on an un-escapable pad. Same-net (GND) as the EP -> no
#     clearance violation; through vias span F.Cu -> In2 GND plane. JLCPCB tents/plugs these.
_ep = next(p for p in fps["U3"].Pads() if p.GetNumber() == "21")
_epx, _epy = _ep.GetPosition().x, _ep.GetPosition().y
for _dx in (pcbnew.FromMM(-0.35), pcbnew.FromMM(0.35)):
    for _dy in (pcbnew.FromMM(-0.35), pcbnew.FromMM(0.35)):
        _v = pcbnew.PCB_VIA(board)
        _v.SetPosition(pcbnew.VECTOR2I(_epx + _dx, _epy + _dy))
        _v.SetDrill(pcbnew.FromMM(0.3)); _v.SetWidth(pcbnew.FromMM(0.6))
        _v.SetNet(nets["GND"]); board.Add(_v)

# Strip U3's (ES8311) imported package-outline silkscreen: the EasyEDA footprint draws silk lines
# across the QFN pads (silk_over_copper DRC). Drop the F.SilkS graphics; the reference designator
# text and the pads/courtyard are kept.
for _g in list(fps["U3"].GraphicalItems()):
    if _g.GetLayer() == pcbnew.F_SilkS:
        fps["U3"].Remove(_g)

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

# --- J1 shield stitch: on each side of the USB4105, join the front and rear shell-stake
#     pads (SH) with a short vertical B.Cu track, tying each side's stakes together.
#     B.Cu is clear there (J1's signal pads are SMD on F.Cu) and the tracks run wide of
#     the NPTH locating pegs (~1.2 mm inboard). Placed after the edge-flush slide so the
#     pad positions are final.
_sh = sorted((p for p in fps["J1"].Pads() if p.GetNumber() == "SH"),
             key=lambda p: (p.GetPosition().x, p.GetPosition().y))
# left pair + right pair vertically on B.Cu; bottom (mouth-side) pair across on F.Cu
# (clear of the signal pad row and the NPTH pegs, which sit on the rear half).
for _a, _b, _lay in ((_sh[0], _sh[1], pcbnew.B_Cu),
                     (_sh[2], _sh[3], pcbnew.B_Cu),
                     (_sh[1], _sh[3], pcbnew.F_Cu)):
    _tr = pcbnew.PCB_TRACK(board)
    _tr.SetStart(_a.GetPosition()); _tr.SetEnd(_b.GetPosition())
    _tr.SetLayer(_lay)
    _tr.SetWidth(pcbnew.FromMM(0.5))
    _tr.SetNet(_a.GetNet())
    _tr.SetLocked(True)   # exported as protected wiring -> Freerouting keeps it
    board.Add(_tr)

# --- J1 VBUS bias pre-route: B9 (VBUS pad) -> via just north of it -> across on B.Cu
#     (45°/90° turns only) -> via beside D5 pin 5 (TPD2S017 VCC bias) -> F.Cu into the
#     pin. Locked so Freerouting keeps it as protected wiring.
_vbus_net = nets["VBUS"]
def _pre_track(a, b, layer, w=0.3, net=None):
    if (a.x, a.y) == (b.x, b.y):
        return
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(a); t.SetEnd(b); t.SetLayer(layer)
    t.SetWidth(pcbnew.FromMM(w)); t.SetNet(net or _vbus_net); t.SetLocked(True)
    board.Add(t)
def _pre_via(pos, net=None):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(pos)
    v.SetDrill(pcbnew.FromMM(0.3)); v.SetWidth(pcbnew.FromMM(0.6))
    v.SetNet(net or _vbus_net); v.SetLocked(True)
    board.Add(v)
def _dogleg(a, b, layer, w=0.3, net=None):
    """a -> b with one straight + one 45° segment (the diagonal lands on b)."""
    dx, dy = b.x - a.x, b.y - a.y
    if abs(dy) >= abs(dx):
        mid = pcbnew.VECTOR2I(a.x, b.y - (abs(dx) if dy > 0 else -abs(dx)))
    else:
        mid = pcbnew.VECTOR2I(b.x - (abs(dy) if dx > 0 else -abs(dy)), a.y)
    _pre_track(a, mid, layer, w, net)
    _pre_track(mid, b, layer, w, net)
# VBUS runs J1 -> F1 (fuse) -> VBUS_F -> D4/D5/D10. Hand-routed pieces:
#  - VBUS_F: D5 pin 5 (VCC bias) exits north between pads 4/6, then doglegs into
#    D10's cathode pad. (D4's anode joins VBUS_F via Freerouting.)
#  - D5 pin 2 GND return: via under D5's body (left half), barrel to the In2 plane.
_p5 = next(p for p in fps["D_esd"].Pads() if p.GetNumber() == "5").GetPosition()
_d5c = fps["D_esd"].GetPosition()
_d10k = next(p for p in fps["D_tvs"].Pads() if p.GetNumber() == "1").GetPosition()
_p5s = pcbnew.VECTOR2I(_p5.x, _p5.y - pcbnew.FromMM(1.05))
_pre_track(_p5, _p5s, pcbnew.F_Cu, w=0.5, net=nets["VBUS_F"])
# diagonal-FIRST toward D10, landing on pad 1's centre with a straight final leg
_ddx2, _ddy2 = _d10k.x - _p5s.x, _d10k.y - _p5s.y
_dd = min(abs(_ddx2), abs(_ddy2))
_m2 = pcbnew.VECTOR2I(_p5s.x + (_dd if _ddx2 > 0 else -_dd),
                      _p5s.y + (_dd if _ddy2 > 0 else -_dd))
_pre_track(_p5s, _m2, pcbnew.F_Cu, w=0.5, net=nets["VBUS_F"])
_pre_track(_m2, _d10k, pcbnew.F_Cu, w=0.5, net=nets["VBUS_F"])
# J1 -> fuse: A9 (VBUS pad column) doglegs into F1 pin 1. Assumes pin 1 is F1's
# south pad (facing J1); if the 90° rotation lands pin 1 north, flip F1 to 270.
_a9 = next(p for p in fps["J1"].Pads() if p.GetNumber() == "A9").GetPosition()
_f1a = next(p for p in fps["F_vbus"].Pads() if p.GetNumber() == "1").GetPosition()
_dogleg(_a9, _f1a, pcbnew.F_Cu, w=0.5, net=nets["VBUS"])
# A4 (the other VBUS pad stack) reaches F1 pin 1 on B.Cu: stub north off the pad row,
# via down, B.Cu dogleg across, via back up just outward of pin 1, F.Cu stub in.
_a4 = next(p for p in fps["J1"].Pads() if p.GetNumber() == "A4").GetPosition()
_av1 = pcbnew.VECTOR2I(_a4.x, _a4.y - pcbnew.FromMM(1.4))
_pre_track(_a4, _av1, pcbnew.F_Cu, w=0.5)
_pre_via(_av1)
_f1c = fps["F_vbus"].GetPosition()
_fdx, _fdy = _f1a.x - _f1c.x, _f1a.y - _f1c.y
# short 1 mm-wide leg straight outward (down) from pin 1; the B.Cu via sits centred
# at its end — the 1 mm copper swallows the 0.6 mm via barrel.
if abs(_fdx) >= abs(_fdy):
    _av2 = pcbnew.VECTOR2I(_f1a.x + (1 if _fdx > 0 else -1) * pcbnew.FromMM(1.6), _f1a.y)
else:
    _av2 = pcbnew.VECTOR2I(_f1a.x, _f1a.y + (1 if _fdy > 0 else -1) * pcbnew.FromMM(1.6))
_pre_track(_f1a, _av2, pcbnew.F_Cu, w=1.0)
_pre_via(_av2)
_dogleg(_av1, _av2, pcbnew.B_Cu, w=0.5)
# GND return: via dead-centre on D5's footprint, between the pad rows (0.3 mm to
# each row's inner edge); pin 2 shares the centre column, so it feeds the via with
# one straight vertical stub. Barrel drops to the In2 GND plane.
_gv = pcbnew.VECTOR2I(_d5c.x, _d5c.y)
_p2 = next(p for p in fps["D_esd"].Pads() if p.GetNumber() == "2").GetPosition()
_pre_track(_p2, _gv, pcbnew.F_Cu, net=nets["GND"])
_pre_via(_gv, net=nets["GND"])
# D10 GND via: same pattern — centred on its footprint, fed by one straight track
# from the anode pad (pin 2); the 0.6 via leaves ~0.55 mm to each pad's inner edge.
_d10c = fps["D_tvs"].GetPosition()
_d10a = next(p for p in fps["D_tvs"].Pads() if p.GetNumber() == "2").GetPosition()
_pre_track(_d10a, pcbnew.VECTOR2I(_d10c.x, _d10c.y), pcbnew.F_Cu, net=nets["GND"])
_pre_via(pcbnew.VECTOR2I(_d10c.x, _d10c.y), net=nets["GND"])

# VBUS_F distribution: star on F1 pin 2 — one dogleg to D4's anode, one to D10's
# cathode (D5 pin 5 already taps D10).
_f1b = next(p for p in fps["F_vbus"].Pads() if p.GetNumber() == "2").GetPosition()
_d4a = next(p for p in fps["D_vbus"].Pads() if p.GetNumber() == "2").GetPosition()
_dogleg(_f1b, _d4a, pcbnew.F_Cu, w=0.5, net=nets["VBUS_F"])
_dogleg(_f1b, _d10k, pcbnew.F_Cu, w=0.5, net=nets["VBUS_F"])

# --- J1 GND-to-shield stitch: each end-of-row GND pad stack (A1/B12 left, A12/B1 right)
#     ties to its side's rear (upper) SH stake with a 45°+straight dogleg, duplicated on
#     F.Cu and B.Cu. The B.Cu copy terminates on the stake's through-hole barrel; at the
#     SMD-pad end it is only barrel-fed (the GND pads exist on F.Cu alone).
for _gnum, _shi in (("A1", 0), ("A12", 2)):   # _sh order: 0=left-rear, 2=right-rear
    _g = next(p for p in fps["J1"].Pads() if p.GetNumber() == _gnum).GetPosition()
    _s = _sh[_shi].GetPosition()
    _gdx, _gdy = _s.x - _g.x, _s.y - _g.y
    _gd = min(abs(_gdx), abs(_gdy))
    _gmid = pcbnew.VECTOR2I(_g.x + (_gd if _gdx > 0 else -_gd),
                            _g.y + (_gd if _gdy > 0 else -_gd))
    for _lay in (pcbnew.F_Cu, pcbnew.B_Cu):
        _pre_track(_g, _gmid, _lay, w=0.5, net=nets["GND"])
        _pre_track(_gmid, _s, _lay, w=0.5, net=nets["GND"])


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

def _pc(p):
    bb = p.GetBoundingBox()
    return (MM((bb.GetLeft()+bb.GetRight())/2.0), MM((bb.GetTop()+bb.GetBottom())/2.0),
            (MM(bb.GetRight()-bb.GetLeft())**2 + MM(bb.GetBottom()-bb.GetTop())**2)**0.5/2.0)
_obs = [_pc(p) for f in board.GetFootprints() for p in f.Pads()]
_svias = []

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

# --- ESP32-C6 antenna keepout: clear ALL copper (tracks/vias/plane pour) ANT_CLEAR mm either
#     side of the WROOM-1 antenna so nearby copper can't detune it. The antenna faces south
#     (flush to the bottom edge), so this widens the module's own antenna-area keepout laterally.
#     The north edge sits just below U1's southernmost pad row, so the zone never covers a U1 pad
#     (and thus never blocks a track reaching one). Pours-not-allowed cuts the GND/+3V3 planes in
#     the clear area; pads/footprints ARE allowed so U1's own antenna body doesn't self-violate.
ANT_CLEAR = 15.0
_u1 = fps[ANTENNA_REF]
_, _, _, _ub = fext(_u1)                                          # antenna faces south -> _ub = bottom edge
_silk = [g for g in _u1.GraphicalItems() if g.GetLayer() == pcbnew.F_SilkS]
_ul = min(MM(g.GetBoundingBox().GetLeft())   for g in _silk)      # F.SilkS body extents (actual module outline)
_ur = max(MM(g.GetBoundingBox().GetRight())  for g in _silk)
_pad_s = max(MM(p.GetBoundingBox().GetBottom()) for p in _u1.Pads())
_axL, _axR = max(x0, _ul - ANT_CLEAR), min(x1, _ur + ANT_CLEAR)  # ±ANT_CLEAR from U1 silk body, clipped to board
# north edge: align with the module's OWN antenna-keepout boundary (the rule area
# embedded in the Espressif footprint) instead of hugging the pad row — banning the
# extra ~0.8 mm band above it costs routing space Espressif doesn't ask for. The
# pad-row formula remains as a floor (and the fallback if the footprint zone is gone).
_own = [z for z in _u1.Zones() if z.GetIsRuleArea()]
_ayT = _pad_s + 0.2
if _own:
    _ayT = max(_ayT, min(MM(z.GetBoundingBox().GetTop()) for z in _own))
_ayB = _ub
_az = pcbnew.ZONE(board); _az.SetIsRuleArea(True); _az.SetLayerSet(pcbnew.LSET.AllCuMask())
_az.SetDoNotAllowTracks(True); _az.SetDoNotAllowVias(True); _az.SetDoNotAllowZoneFills(True)
_az.SetDoNotAllowPads(False); _az.SetDoNotAllowFootprints(False)
_ach = pcbnew.SHAPE_LINE_CHAIN()
for _pt in ((_axL, _ayT), (_axR, _ayT), (_axR, _ayB), (_axL, _ayB)):
    _ach.Append(vmm(*_pt))
_ach.SetClosed(True); _az.AddPolygon(_ach); _az.SetZoneName("antenna keepout"); board.Add(_az)
_fid_rects.append((_axL, _axR, _ayT, _ayB))                      # keep fiducials out of the clear zone
print(f"  antenna keepout: x[{_axL:.1f},{_axR:.1f}] y[{_ayT:.1f},{_ayB:.1f}] (±{ANT_CLEAR:.0f}mm lateral)")
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
_fids = []  # fiducials disabled
# _fids = [_place_fiducial("FID1", x0, y0),      # top-left
#          _place_fiducial("FID2", x0, y1),      # bottom-left
#          _place_fiducial("FID3", x1, y1)]      # bottom-right (top-right left empty -> asymmetric)
print(f"  fiducials: disabled")

# NOTE: J1 is the GCT USB4105 -- single-row SMD Type-C (only the shell stakes are THT).
# All 16 signal contacts escape from one fine-pitch pad row on F.Cu, so placement around
# J1 must leave the escape fan room and D+/D- want to drop to B.Cu over the GND plane;
# verify Freerouting copes after any reshuffle near the bottom edge.

# Place J2 (WF26 screw terminal) toward the LEFT: align its left edge ~2 mm to the right of R16
# (R_ot), with clearance. (Previously pinned to the board's right edge.)
_r16l, _r16r, _r16t, _r16b = fext(fps["R_ot"])
_jl, _jr, _jt, _jb = fext(fps["J2"])
_pj = fps["J2"].GetPosition()
fps["J2"].SetPosition(pcbnew.VECTOR2I(_pj.x + pcbnew.FromMM((_r16r + 2.0) - _jl), _pj.y))

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
    _jt2.SetPosition(pcbnew.VECTOR2I(_pp.x, _pp.y + pcbnew.FromMM(4.6)))   # in the gap below J2 body silk, above K2
    _jt2.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
    _jt2.SetTextThickness(pcbnew.FromMM(0.12))
    board.Add(_jt2)

# Hide J2's own reference: 30/35 parts already hide their refdes, and J2's "J2" was the one
# sitting in the pin-label row -- the only refdes exposed once the slots are populated. The
# P1..P5/IN4 functional labels are what matter at this connector; "J2" still lives in the BOM/CPL.
fps["J2"].Reference().SetVisible(False)

jl, jr, jt, jb = fext(fps["J1"])
j1ref = fps["J1"].Reference()
j1ref.SetPosition(vmm((jl + jr) / 2.0, (jt + jb) / 2.0))
j1ref.SetTextAngleDegrees(0)

_t1l, _t1r, _t1t, _t1b = fext(fps["T1"])
fps["T1"].Reference().SetPosition(vmm((_t1l + _t1r) / 2.0, (_t1t + _t1b) / 2.0))
fps["T1"].Reference().SetTextAngleDegrees(0)

# F1's ref to the right of its body, clear of the fuse courtyard.
_f1l, _f1r, _f1t, _f1b2 = fext(fps["F_vbus"])
fps["F_vbus"].Reference().SetPosition(vmm(_f1r + 1.0, (_f1t + _f1b2) / 2.0))
fps["F_vbus"].Reference().SetTextAngleDegrees(0)

# Polarity switches: default ref position (0, -6.65 local) ends up off-board; move to centre.
for _swk in ("SW_OC1", "SW_OC2", "SW_OC3"):
    fps[_swk].Reference().SetPosition(fps[_swk].GetPosition())
    fps[_swk].Reference().SetTextAngleDegrees(0)

# Group label above the polarity switches explaining their function.
_pol_lbl = pcbnew.PCB_TEXT(board)
_pol_lbl.SetText("POLARITY")
_pol_lbl.SetLayer(pcbnew.F_SilkS)
_pol_lbl.SetPosition(vmm(8, 14.0))
_pol_lbl.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
_pol_lbl.SetTextThickness(pcbnew.FromMM(0.12))
_pol_lbl.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER)
board.Add(_pol_lbl)

# Default-position markers: short vertical tick at the pin-1 column (x = sw_x − 1.75) of
# each switch, in the gap between the top pad row (y≈15.35) and the body silk (y≈16.05).
# Slider left = pin 1↔2 + 4↔5 = normal/default polarity (matches pre-switch direct wiring).
for _swx in (2.0, 8.0, 14.0):
    _dm = pcbnew.PCB_SHAPE(board)
    _dm.SetShape(pcbnew.SHAPE_T_SEGMENT)
    _dm.SetLayer(pcbnew.F_SilkS)
    _dm.SetWidth(pcbnew.FromMM(0.25))
    _dm.SetStart(vmm(_swx - 1.75, 21.6))
    _dm.SetEnd(vmm(_swx - 1.75, 22.3))
    board.Add(_dm)

# Relays sit close together; the default side-placed refdes overlaps the neighbour's body
# silk. Centre each relay's reference on its own body instead.
for _k in ("K2", "K3", "K1"):
    _kl, _kr, _kt, _kb = fext(fps[_k])
    _kref = fps[_k].Reference()
    _kref.SetPosition(vmm((_kl + _kr) / 2.0, (_kt + _kb) / 2.0))
    _kref.SetTextAngleDegrees(0)

# U3's refdes: place to the right and below the IC body (clear of the cap ring).
_u3ref = fps["U3"].Reference()
_u3l, _u3r, _u3t, _u3b = fext(fps["U3"])
_u3ref.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(_u3r + 0.5), pcbnew.FromMM(_u3b + 1.0)))
_u3ref.SetTextAngleDegrees(0)

# Reset Value() text on the two tactile switches: the library footprint places the text
# at a large local offset (8.68, 2.615) that lands far from the body after rotation.
for _k in ("SW_boot", "SW_en"):
    fps[_k].Value().SetPosition(fps[_k].GetPosition())
    fps[_k].Value().SetTextAngleDegrees(0)

# Silkscreen labels on the left side of the user-facing buttons, rotated CCW (reads bottom-to-top).
for _sw, _txt, _side, _ang in (("SW_boot", "BOOT", "left", 90), ("SW_en", "RST", "right", 270)):
    _sl, _sr, _st, _sb = fext(fps[_sw])
    _lab = pcbnew.PCB_TEXT(board)
    _lab.SetText(_txt)
    _lab.SetLayer(pcbnew.F_SilkS)
    _lx = (_sl - 1.0) if _side == "left" else (_sr + 1.0)
    _lab.SetPosition(vmm(_lx, (_st + _sb) / 2.0))
    _lab.SetTextAngleDegrees(_ang)
    _lab.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.0), pcbnew.FromMM(1.0)))
    _lab.SetTextThickness(pcbnew.FromMM(0.15))
    board.Add(_lab)

# Product name + revision on the front silkscreen (reads bottom-to-top, left of U1).
_pn = pcbnew.PCB_TEXT(board)
_pn.SetText("Doorbell Controller V4.0  2026-06-10")
_pn.SetLayer(pcbnew.F_SilkS)
_pn.SetPosition(vmm(0.5, 52.75))
_pn.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.0), pcbnew.FromMM(1.0)))
_pn.SetTextThickness(pcbnew.FromMM(0.15))
_pn.SetTextAngleDegrees(90)   # CCW, reads bottom-to-top
board.Add(_pn)

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
