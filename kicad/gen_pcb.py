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
    "SW_boot":(8.500, 41, 180),  # BOOT button, CW from vertical → horizontal, above U1
    "R_boot": (13.500, 41, 180),  # BOOT pullup, right of SW_boot (was above → right after CW)
    "SW_en":  (22, 41, 0),    # RST button, right of BOOT group
    "R_en":   (17, 40, 0),    # EN pullup, above SW_en
    "C_en":   (17, 42, 180),  # EN cap, below SW_en
    "U2":     (44.5, 44.0, 180), # SGM2212 LDO; rotated CW
    "R_io8":  (27.0, 61.2, 90),  # GPIO8 pull-up, SE of U1 beside C_3v3. GPIO8 pad (1)
                                 # faces south onto its B.Cu via (GPIO8 crosses under
                                 # the I2S fan corridor); +3V3 pad (2) faces north,
                                 # tapping the C_dec/C_3v3 power rail (pre-routed).
    "C_in":   (43.25, 48.25, 0), # LDO input cap (C2)
    "C_out":  (41.5, 38.75, 270), # LDO output cap (C4)
    "LED1":   (48.0, 16.5, 90), # power LED; right of J2
    "R_led":  (48.0, 13.5, 270), # LED series resistor; right of J2
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
    "J2":     (44.15, 15, 180),  # WF26 6-way screw terminal, top edge, right side
    # === Polarity switches: DPDT SMD slide switches, 9 mm pitch, Y=18 left of J2.
    #     Y=18 keeps the ±4.3 mm-extent SMD footprint inside the board outline. ===
    # rotated 180°: pads map 1↔6/2↔5/3↔4 onto the same spots, matching the JP/RET
    # pin swap in doorbell_design.py — copper layout identical to rot 0.
    "SW_OC3": (3,  16, 180),
    "SW_OC2": (9,  16, 180),
    "SW_OC1": (15, 16, 180),
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
    "R_ot":   (28.0, 21.25, 180), # ÖT bridge 2.2k: below J2, between pins 6/5
    # === K1 (PTT placeholder) relay + driver: same spacing as K3→K2 (11.5 mm) ===
    "K1":     (42.5, 27, 270),
    "Q1":     (46.5, 34, 180),
    "R_g1":   (37.75, 36.5, 0), # K1 gate series R, gate-side of the interlock; same
                                # position/orientation relative to R_pd1 as R_g2 has
                                # to R_pd2 (horizontal, x-0.75/y+2.5 from the pulldown)
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
    # NORTH row: PVDD/DVDD decoupling + SCL pull-up (pad-to-U3 faces south).
    # C_dv/C_pv shifted -0.5 and R_scl +0.36 in table-x; after the repack's centroid
    # feedback C_pv/C_dv land ~0.46 board-south and R_scl ~0.40 board-north of the
    # nominal row, opening the R_scl<->C_pv gap to ~1.0 mm — it carries the SCL and
    # MCLK runs (on U3 pin 1's / pin 2's rows, 0.4 mm apart) into the codec, with
    # R_scl's pad row clear above SCL's run (the pull-up taps it via a stub).
    # R_scl rotated 180° (90 instead of 270): +3V3 pad (1) faces east onto its own
    # In1 via; SCL pad (2) faces west toward the incoming lane.
    "C_dv":   (76.37, 17.3, 90), "C_pv": (77.57, 17.3, 90), "R_scl": (79.57, 17.3, 90),
    "R_ce":   (27.25, 42.854, 180), # CE addr pull-down (10k to GND). NOMINAL ONLY:
                                    # snapped after the audio repack to sit directly
                                    # above R_scl (same x, 1.2 mm pitch). Its pads
                                    # straddle the SDA lane, so SDA hops north over it
                                    # (pre-routed).
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
# Anchored to U1's east edge (was R_io8's, but that resistor now lives in the SE
# corner); the +3.3 constant preserves the block position from the R_io8-anchored era.
_audio_shift = (_bbx("U1")[1] + 3.3) - _audio_left
for k in _FULL_AUDIO:
    _p = fps[k].GetPosition()
    fps[k].SetPosition(pcbnew.VECTOR2I(_p.x + pcbnew.FromMM(_audio_shift), _p.y))

# R_ce tracks R_scl wherever the repack lands it: stacked directly above, same x,
# C_dv<->C_pv pitch (1.2 mm). (Its PCB_PLACE entry is only the nominal spot.)
_rscl_p = fps["R_scl"].GetPosition()
fps["R_ce"].SetPosition(vmm(_TOMM(_rscl_p.x), _TOMM(_rscl_p.y) - 1.2))

# Place T1 below U3 with 2 mm clearance, rotated 180° from its group orientation.
fps["T1"].SetOrientationDegrees((fps["T1"].GetOrientationDegrees() + 180) % 360)
_u3bb = _bbx("U3")
_t1bb = _bbx("T1")
fps["T1"].SetPosition(vmm(
    32.75,  # fixed x; west pads keep 0.6+ mm to the I2S fan's DOUT vertical
    # 2.35 mm gap (was 2.0): T1's 3.9 mm-long pads reach west to x≈25.2; the I2S
    # fan's WS/DOUT lines rise on verticals beside U1's pad column (not shallow
    # diagonals), so only a small extra gap is needed — and 2.35 keeps T1's south
    # edge clear of R_io8 below.
    _u3bb[3] + 2.35 + (_t1bb[3] - _t1bb[2]) / 2.0,
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

# --- ESP32-C6 (U1) EPAD stitch: the WROOM EPAD (pad "29") is a 3x3 grid of 0.8 mm
#     sub-pads; drop one GND via at each sub-pad centre (documented via-in-pad
#     exception, same rationale as U3's EP). Low-inductance RF return + heat path
#     into the In2 GND plane, and Freerouting sees the pad pre-grounded. Placed AFTER
#     the edge-flush slide (U1 is flush-pinned, so its pads move during the slide).
for _ep29 in (p for p in fps["U1"].Pads() if p.GetNumber() == "29"):
    _v = pcbnew.PCB_VIA(board)
    _v.SetPosition(_ep29.GetPosition())
    _v.SetDrill(pcbnew.FromMM(0.3)); _v.SetWidth(pcbnew.FromMM(0.7))
    _v.SetNet(nets["GND"]); board.Add(_v)

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
# Debug gate for bisecting Freerouting crashes: PRE_RANGE="lo:hi" places only the
# pre-route calls with index lo <= i < hi (default: all). Each _pre_track/_pre_via
# call consumes one index in deterministic order.
_PRE_RANGE = os.environ.get("PRE_RANGE")
_PRE_LO, _PRE_HI = (tuple(int(v) for v in _PRE_RANGE.split(":"))
                    if _PRE_RANGE else (None, None))
_PRE_N = [0]
_PRE_SKIP = {int(v) for v in os.environ.get("PRE_SKIP", "").split(",") if v}
def _pre_enabled(_what=""):
    _i = _PRE_N[0]
    _PRE_N[0] += 1
    if os.environ.get("PRE_DEBUG"):
        print(f"pre[{_i}] {_what}")
    if _i in _PRE_SKIP:
        return False
    return _PRE_RANGE is None or (_PRE_LO <= _i < _PRE_HI)

def _pre_track(a, b, layer, w=0.3, net=None):
    if not _pre_enabled(f"track {(net or _vbus_net).GetNetname()} "
                        f"({pcbnew.ToMM(a.x):.3f},{pcbnew.ToMM(a.y):.3f})->"
                        f"({pcbnew.ToMM(b.x):.3f},{pcbnew.ToMM(b.y):.3f}) w={w}"):
        return
    # skip degenerate/micro segments: Freerouting NPEs on locked polylines that
    # collapse to a point at DSN resolution
    if abs(a.x - b.x) < pcbnew.FromMM(0.02) and abs(a.y - b.y) < pcbnew.FromMM(0.02):
        return
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(a); t.SetEnd(b); t.SetLayer(layer)
    t.SetWidth(pcbnew.FromMM(w)); t.SetNet(net or _vbus_net); t.SetLocked(True)
    board.Add(t)
def _pre_via(pos, net=None):
    if not _pre_enabled(f"via {(net or _vbus_net).GetNetname()} "
                        f"({pcbnew.ToMM(pos.x):.3f},{pcbnew.ToMM(pos.y):.3f})"):
        return
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

# --- GPIO escape bundle: the six MCU lines into the opto/relay-driver block (OC*_OUT
#     sense inputs + GATE*_DRV relay gates) leave U1's left pad column as parallel
#     vertical lanes hugging the module's left edge (0.329 mm pitch = 0.2 mm track +
#     0.129 mm gap; rightmost lane keeps 0.129 mm to the pad ends). Lanes nest in pad
#     order (lowest pad -> leftmost lane), so the pad stubs and 45° corners never cross.
#     Every line follows the same pattern: vertical lane -> 45° NE diagonal -> finish.
#     OC3_OUT (leftmost lane) finishes by landing on OC3's collector pad 4 (its diagonal
#     clears OK3 pad 3's rounded corner); the other five flatten east into horizontal
#     runs instead. Their 45° diagonals nest parallel to OC3's at 0.4625 mm vertical
#     steps (= 0.327 mm perpendicular); the horizontals stack from just clear of the
#     opto pad row (OC2 on top at pad-row+0.15 mm copper gap) downward at one lane
#     pitch, and all stop just west of OK2 pad 3 — Freerouting continues them east.
#     With the GATE pad swap (18=K2, 19=K3, 20=K1) the lane stack's targets are ordered
#     strictly west->east (OK2, OK1, R_g1, R_g3, R_g2), so every north-bend out of the
#     stack is crossing-free and the whole bundle hand-routes with no vias: each line
#     leaves its run with a 45° rise into its target (opto pad 4 / gate R pad 1).
_BPITCH, _BCORNER, _BW = 0.329, 0.49, 0.2
_u1px = _TOMM(next(p for p in fps["U1"].Pads() if p.GetNumber() == "18").GetPosition().x)
_oc3p4 = next(p for p in fps["OC3"].Pads() if p.GetNumber() == "4").GetPosition()
_tx, _ty = _TOMM(_oc3p4.x), _TOMM(_oc3p4.y)
_lane5 = _u1px - 0.75 - 0.129 - _BW / 2   # U1 pads are 1.5 mm long: edge at centre-0.75
_diag_c = _tx + _ty + 0.1042              # OC3's 45° approach line: x + y = const
for _net, _pnum, _k, _dst in (
        # _dst: "direct"  = land on OC3 pad 4 straight off the 45° diagonal;
        #       OC* key   = flatten east, then 45° back up into that opto's pad 4;
        #       R_g* key  = flatten east, then rise north into that gate R's pad 1.
        ("OC3_OUT",   "27", 0, "direct"),
        ("OC2_OUT",   "26", 1, "OC2"),
        ("OC1_OUT",   "21", 2, "OC1"),
        ("GATE3_DRV", "20", 3, "R_g3"),
        ("GATE1_DRV", "19", 4, "K3"),
        ("GATE2_DRV", "18", 5, "R_g2")):
    _lx = _lane5 - (5 - _k) * _BPITCH
    _pp = next(p for p in fps["U1"].Pads() if p.GetNumber() == _pnum).GetPosition()
    _py = _TOMM(_pp.y)
    _pre_track(_pp, vmm(_lx + _BCORNER, _py), pcbnew.F_Cu, _BW, nets[_net])
    _pre_track(vmm(_lx + _BCORNER, _py), vmm(_lx, _py - _BCORNER),
               pcbnew.F_Cu, _BW, nets[_net])
    if _dst == "direct":
        # vertical to the 45° line, diagonal to just above the pad, stub into its centre
        _pre_track(vmm(_lx, _py - _BCORNER), vmm(_lx, _diag_c - _lx),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_lx, _diag_c - _lx), vmm(_tx, _ty + 0.1042),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_tx, _ty + 0.1042), _oc3p4, pcbnew.F_Cu, _BW, nets[_net])
    else:
        # vertical to this lane's 45° line (parallel to OC3's, 0.4625 mm/lane further
        # SE), diagonal NE, then flatten into an eastward horizontal: OC2 tops the stack
        # just clear of the opto pad row, each following lane one pitch lower.
        _c = _diag_c + 0.4625 * _k             # this lane's 45° line: x + y = _c
        _yh = _ty + 1.0625 + (_k - 1) * _BPITCH   # horizontal level (OC2: pad row+1.06)
        _pre_track(vmm(_lx, _py - _BCORNER), vmm(_lx, _c - _lx),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_lx, _c - _lx), vmm(_c - _yh, _yh),
                   pcbnew.F_Cu, _BW, nets[_net])
        if _dst.startswith("OC"):
            # run east, 45° back up (mirroring the OC3 landing; clears the neighbouring
            # pad 3's rounded corner by the same margin), vertical stub into pad 4
            _t4 = next(p for p in fps[_dst].Pads() if p.GetNumber() == "4").GetPosition()
            _tpx = _TOMM(_t4.x)
            _dxr = _yh - (_ty + 0.1042)        # 45° rise from run level to pad approach
            _pre_track(vmm(_c - _yh, _yh), vmm(_tpx - _dxr, _yh),
                       pcbnew.F_Cu, _BW, nets[_net])
            _pre_track(vmm(_tpx - _dxr, _yh), vmm(_tpx, _ty + 0.1042),
                       pcbnew.F_Cu, _BW, nets[_net])
            _pre_track(vmm(_tpx, _ty + 0.1042), _t4, pcbnew.F_Cu, _BW, nets[_net])
        else:
            # gate landings: R_g3/R_g2 rise north straight into their pad 1.
            # GATE1_DRV (_dst "K3") instead rises through the R_pd3<->D3 channel and
            # 45°s NW into K3 pin 5 (the interlock's NO contact comes before the
            # series resistor now).
            if _dst == "K3":
                _t5 = next(p for p in fps["K3"].Pads() if p.GetNumber() == "5").GetPosition()
                _tpx, _tpy = _TOMM(_t5.x), _TOMM(_t5.y)
                _d3p1 = next(p for p in fps["D3"].Pads() if p.GetNumber() == "1").GetPosition()
                _rx = _TOMM(_d3p1.x) - 0.45 - 0.36   # channel between R_pd3 and D3
                _pre_track(vmm(_c - _yh, _yh), vmm(_rx - 0.245, _yh),
                           pcbnew.F_Cu, _BW, nets[_net])
                _pre_track(vmm(_rx - 0.245, _yh), vmm(_rx, _yh - 0.245),
                           pcbnew.F_Cu, _BW, nets[_net])
                _pre_track(vmm(_rx, _yh - 0.245), vmm(_rx, _tpy + (_rx - _tpx)),
                           pcbnew.F_Cu, _BW, nets[_net])
                _pre_track(vmm(_rx, _tpy + (_rx - _tpx)), _t5,
                           pcbnew.F_Cu, _BW, nets[_net])
            else:
                _t1 = next(p for p in fps[_dst].Pads() if p.GetNumber() == "1").GetPosition()
                _rx = _TOMM(_t1.x)
                _pre_track(vmm(_c - _yh, _yh), vmm(_rx - 0.245, _yh),
                           pcbnew.F_Cu, _BW, nets[_net])
                _pre_track(vmm(_rx - 0.245, _yh), vmm(_rx, _yh - 0.245),
                           pcbnew.F_Cu, _BW, nets[_net])
                _pre_track(vmm(_rx, _yh - 0.245), _t1, pcbnew.F_Cu, _BW, nets[_net])

# --- I2C/I2S escape bundle (north of U1): BOOT leads from U1 pad 15 east + 45° NE up
#     to its switch and on to R_boot (its proven autoroute path, now locked). I2C
#     SDA/SCL (pads 16/17 — GPIO-matrix swap, see doorbell_design.py) follow as nested
#     parallel diagonals (0.4625 mm/lane = 0.327 mm perpendicular) and flatten east
#     just north of the module at y=43.0 / 43.329. I2S MCLK (pad 6, east column) runs
#     north on an inner vertical 0.129 mm off the east pad column and joins the stack
#     with an eastward turn at y=43.658. Resulting lane order into U3: SDA, SCL, MCLK
#     (top to bottom); the I2S data/clock group (BCLK/DIN/WS/DOUT on pads 12/11/8/7)
#     does not enter the stack — it fans east to U3's south row.
def _padpos(_key, _num):
    return next(p for p in fps[_key].Pads() if p.GetNumber() == _num).GetPosition()
_b15, _sw1, _rb2 = _padpos("U1", "15"), _padpos("SW_boot", "1"), _padpos("R_boot", "2")
_bC = _TOMM(_sw1.x) + _TOMM(_sw1.y)            # BOOT's 45° line: x + y = _bC
_pre_track(_b15, vmm(_bC - _TOMM(_b15.y), _TOMM(_b15.y)), pcbnew.F_Cu, _BW, nets["BOOT"])
_pre_track(vmm(_bC - _TOMM(_b15.y), _TOMM(_b15.y)), _sw1, pcbnew.F_Cu, _BW, nets["BOOT"])
_pre_track(_sw1, _rb2, pcbnew.F_Cu, _BW, nets["BOOT"])
# R_boot's +3V3 pad sits right against the locked BOOT wire; Freerouting NPEs trying
# to drop a plane via at a pad hemmed in by locked wiring (degenerate connection), so
# pre-place its In1 tap.
_rb1 = _padpos("R_boot", "1")
_v_rb1 = vmm(_TOMM(_rb1.x) + 0.88, _TOMM(_rb1.y))
_pre_track(_rb1, _v_rb1, pcbnew.F_Cu, _BW, nets["+3V3"])
_pre_via(_v_rb1, net=nets["+3V3"])
_I2S_Y0 = 43.0                                  # SDA's eastward lane; +1 pitch per line
for _net, _pnum, _j in (("I2C_SDA", "16", 1), ("I2C_SCL", "17", 2)):
    _pp = _padpos("U1", _pnum)
    _c = _bC + 0.4625 * _j
    _ye = _I2S_Y0 + (_j - 1) * _BPITCH
    _pre_track(_pp, vmm(_c - _TOMM(_pp.y), _TOMM(_pp.y)), pcbnew.F_Cu, _BW, nets[_net])
    _pre_track(vmm(_c - _TOMM(_pp.y), _TOMM(_pp.y)), vmm(_c - _ye, _ye),
               pcbnew.F_Cu, _BW, nets[_net])
    _pre_track(vmm(_c - _ye, _ye), vmm(21.5, _ye), pcbnew.F_Cu, _BW, nets[_net])
# I2S MCLK: the only east-column riser (the I2S data/clock group on pads 12/11/8/7
# fans east directly to U3's south row instead). Inner vertical just west of U1's
# east pad column (pads are 1.5 mm long); joins the stack beneath the SDA/SCL lanes.
_p6 = _padpos("U1", "6")
_vx_mclk = _TOMM(_p6.x) - 0.75 - 0.129 - _BW / 2   # hugs the pad column
_y_mclk = _I2S_Y0 + 2 * _BPITCH
_pre_track(_p6, vmm(_vx_mclk, _TOMM(_p6.y)), pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
_pre_track(vmm(_vx_mclk, _TOMM(_p6.y)), vmm(_vx_mclk, _y_mclk + 0.245),
           pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
_pre_track(vmm(_vx_mclk, _y_mclk + 0.245), vmm(_vx_mclk + 0.245, _y_mclk),
           pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
_pre_track(vmm(_vx_mclk + 0.245, _y_mclk), vmm(21.5, _y_mclk), pcbnew.F_Cu, _BW,
           nets["I2S_MCLK"])

# --- SDA/SCL/MCLK landings on the audio block (the I2S data/clock fan to U3's south
#     row is routed separately).  SCL and MCLK leave their lanes WEST of the R_ce/R_scl stack
#     and drop 45° SE past R_scl pad 1's SW corner — MCLK (the lower lane) turns
#     first, SCL's diagonal nests 0.4625 mm behind, GPIO-bundle style — then run east
#     through the R_scl<->C_pv gap, each dead on its U3 pad row: SCL on pin 1's row,
#     tapping R_scl pad 2 (the pull-up) with a stub on the way; MCLK on pin 2's row
#     (0.4 mm pitch = the QFN pad pitch, fits the ~1.0 mm gap with 0.18/0.33 mm pad
#     clearances).  SDA stays on the top lane — between R_ce's and R_scl's pad rows —
#     and drops onto CDATA (pin 19) from the north, between pins 20 and 18.
_u3p1, _u3p2, _u3p19 = _padpos("U3", "1"), _padpos("U3", "2"), _padpos("U3", "19")
_r19p1, _r19p2 = _padpos("R_scl", "1"), _padpos("R_scl", "2")
_p1y, _p2y = _TOMM(_u3p1.y), _TOMM(_u3p2.y)
_yl_sda, _yl_scl, _yl_mclk = _I2S_Y0, _I2S_Y0 + _BPITCH, _I2S_Y0 + 2 * _BPITCH
# 45° lines (x - y = c): SCL passes the R_scl stack's SW pad corner at 0.36 mm
# (western pad regardless of numbering — R_scl is rotated 180°); MCLK one diagonal
# pitch further west.
_r19w = min(_TOMM(_r19p1.x), _TOMM(_r19p2.x))
_c_scl = (_r19w - 0.4) - (_TOMM(_r19p1.y) + 0.475) - 0.505
_c_mclk = _c_scl - 0.4625
_pre_track(vmm(21.5, _yl_scl), vmm(_yl_scl + _c_scl, _yl_scl),
           pcbnew.F_Cu, _BW, nets["I2C_SCL"])
_pre_track(vmm(_yl_scl + _c_scl, _yl_scl), vmm(_p1y + _c_scl, _p1y),
           pcbnew.F_Cu, _BW, nets["I2C_SCL"])
# run split at the pull-up tap so the stub joins at segment ENDPOINTS (Freerouting
# mishandles mid-segment T-junctions in protected wiring)
_pre_track(vmm(_p1y + _c_scl, _p1y), vmm(_TOMM(_r19p2.x), _p1y),
           pcbnew.F_Cu, _BW, nets["I2C_SCL"])
_pre_track(vmm(_TOMM(_r19p2.x), _p1y), _u3p1, pcbnew.F_Cu, _BW, nets["I2C_SCL"])
_pre_track(vmm(_TOMM(_r19p2.x), _p1y), _r19p2,
           pcbnew.F_Cu, _BW, nets["I2C_SCL"])   # stub up into the pull-up pad
_pre_track(vmm(21.5, _yl_mclk), vmm(_yl_mclk + _c_mclk, _yl_mclk),
           pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
_pre_track(vmm(_yl_mclk + _c_mclk, _yl_mclk), vmm(_p2y + _c_mclk, _p2y),
           pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
_pre_track(vmm(_p2y + _c_mclk, _p2y), _u3p2, pcbnew.F_Cu, _BW, nets["I2S_MCLK"])
# +3V3 In1-plane taps: vias just east of R_scl pad 1 (its pull-up supply, pad faces
# east after the 180° rotation) and east of C_dv pad 1 (DVDD/PVDD decoupling supply)
for _key in ("R_scl", "C_dv"):
    _pp3 = _padpos(_key, "1")
    _v3 = vmm(_TOMM(_pp3.x) + 0.88, _TOMM(_pp3.y))
    _pre_track(_pp3, _v3, pcbnew.F_Cu, _BW, nets["+3V3"])
    _pre_via(_v3, net=nets["+3V3"])

# R_ce's GND return: dedicated via just west of pad 2 (drops to the In2 plane)
_rce2 = _padpos("R_ce", "2")
_rcex, _rcey = _TOMM(_rce2.x), _TOMM(_rce2.y)
_gv_rce = vmm(_rcex - 0.88, _rcey)
_pre_track(_rce2, _gv_rce, pcbnew.F_Cu, _BW, nets["GND"])
_pre_via(_gv_rce, net=nets["GND"])
# SDA: R_ce's pads now straddle the top lane, so SDA hops NORTH over it — the upward
# bend sits at SCL's turn x (one bend column with the SCL/MCLK down-turns), which
# keeps the rise clear of the EN switch's pad corner AND of R_ce's GND via. It rises
# all the way to R_sda pad 2's row and runs straight east into the pull-up dead
# centre, then exits 45° SE + vertical into CDATA (pin 19) from the north, between
# pins 20 and 18.
_p19x = _TOMM(_u3p19.x)
_r18p2 = _padpos("R_sda", "2")
_r18x, _r18y = _TOMM(_r18p2.x), _TOMM(_r18p2.y)
_xa = _yl_scl + _c_scl                     # rise starts in the SCL/MCLK bend column
_pre_track(vmm(21.5, _yl_sda), vmm(_xa, _yl_sda), pcbnew.F_Cu, _BW, nets["I2C_SDA"])
_pre_track(vmm(_xa, _yl_sda), vmm(_xa + (_yl_sda - _r18y), _r18y),
           pcbnew.F_Cu, _BW, nets["I2C_SDA"])
_pre_track(vmm(_xa + (_yl_sda - _r18y), _r18y), _r18p2,
           pcbnew.F_Cu, _BW, nets["I2C_SDA"])
_pre_track(_r18p2, vmm(_p19x, _r18y + (_p19x - _r18x)),
           pcbnew.F_Cu, _BW, nets["I2C_SDA"])
_pre_track(vmm(_p19x, _r18y + (_p19x - _r18x)), _u3p19,
           pcbnew.F_Cu, _BW, nets["I2C_SDA"])

# GPIO8 strap pull-up: R_io8 lives SE of U1 beside C_3v3, GPIO8 pad (1) facing south.
# GPIO8 leaves U1 pad 10 east into a B.Cu via close to the pad, crosses UNDER the I2S
# fan corridor on B.Cu (parallel to the USB pair's diagonals), and resurfaces in a via
# just SOUTH of R_io8. Its +3V3 pad (2, north) taps the C_dec/C_3v3 rail below.
_p10 = _padpos("U1", "10")
_rio1, _rio2 = _padpos("R_io8", "1"), _padpos("R_io8", "2")
_v8a = vmm(23.0, _TOMM(_p10.y))
_pre_track(_p10, _v8a, pcbnew.F_Cu, _BW, nets["GPIO8"])
_pre_via(_v8a, net=nets["GPIO8"])
_v8b = vmm(_TOMM(_rio1.x), _TOMM(_rio1.y) + 0.88)
_dogleg(_v8a, _v8b, pcbnew.B_Cu, w=_BW, net=nets["GPIO8"])
_pre_via(_v8b, net=nets["GPIO8"])
_pre_track(_v8b, _rio1, pcbnew.F_Cu, _BW, nets["GPIO8"])

# U1 power pins: pad 2 (+3V3) and pad 1 (GND) run east in-line through C_dec's and
# C_3v3's pad rows; the +3V3 rail continues into R_io8 pad 2 (its pull-up supply).
for _unum, _cnet, _cpad in (("2", "+3V3", "1"), ("1", "GND", "2")):
    _up = _padpos("U1", _unum)
    _c6p, _c3p = _padpos("C_dec", _cpad), _padpos("C_3v3", _cpad)
    _jog = abs(_TOMM(_c6p.y) - _TOMM(_up.y))
    if _jog >= 0.1:
        _pre_track(_up, vmm(_TOMM(_c6p.x) - _jog, _TOMM(_up.y)),
                   pcbnew.F_Cu, _BW, nets[_cnet])
        _pre_track(vmm(_TOMM(_c6p.x) - _jog, _TOMM(_up.y)), _c6p,
                   pcbnew.F_Cu, _BW, nets[_cnet])
    else:
        # rows nearly collinear: one slightly slanted segment, no micro-45° jog
        _pre_track(_up, _c6p, pcbnew.F_Cu, _BW, nets[_cnet])
    _pre_track(_c6p, _c3p, pcbnew.F_Cu, _BW, nets[_cnet])
_c3v3 = _padpos("C_3v3", "1")
# pad rows differ by only ~0.05 mm: one straight (slightly slanted) segment instead
# of a micro-45° jog, which Freerouting chokes on
_pre_track(_c3v3, _rio2, pcbnew.F_Cu, _BW, nets["+3V3"])
# In1-plane tap for the rail: via just east of R_io8 pad 2
_v_io8b = vmm(_TOMM(_rio2.x) + 0.88, _TOMM(_rio2.y))
_pre_track(_rio2, _v_io8b, pcbnew.F_Cu, _BW, nets["+3V3"])
_pre_via(_v_io8b, net=nets["+3V3"])
# In2-plane tap for the GND rail: via just south of C_3v3 pad 2 (east is blocked by
# R_io8's GPIO8 pad)
_c3g = _padpos("C_3v3", "2")
_v_c3g = vmm(_TOMM(_c3g.x), _TOMM(_c3g.y) + 0.88)
_pre_track(_c3g, _v_c3g, pcbnew.F_Cu, _BW, nets["GND"])
_pre_via(_v_c3g, net=nets["GND"])

# --- I2S data/clock fan: BCLK/DIN/WS/DOUT (U1 pads 12/11/8/7) run east through the
#     gap between C_dv's pad row and T1 as four lanes (0.329 mm pitch, top lane
#     0.265 mm below C_dv's pads), then rise north into U3's south row (SCLK 6 /
#     ASDOUT 7 / LRCK 8 / DSDIN 9). Pad order matches pin order, so the set nests
#     crossing-free: each line's lane sits BELOW the previous line's, so the long 45°
#     rises from the lower pads top out before reaching any upper lane; the pad stubs
#     are staggered so the rises clear them.
# Top lane sits exactly on U1 pad 12's row, so BCLK runs dead straight (C_dv/C_pv
# are nudged 0.064 north in the table so the lane keeps 0.16 to C_dv's pads).
_lane0 = _TOMM(_padpos("U1", "12").y)
for _net, _pnum, _u3pin, _k, _xp, _vert in (
        # BCLK/DIN sit near their lanes already: short stub + shallow 45°.
        # WS/DOUT rise "aggressively" (OC2/OC3_OUT style) on verticals just east of
        # GPIO8's via (x=23.73 / +1 pitch), clear of T1's west pads.
        ("I2S_BCLK", "12", "6", 0, 25.0,   False),
        ("I2S_DIN",  "11", "7", 1, 22.6,   False),
        ("I2S_WS",   "8",  "8", 2, 23.73,  True),
        ("I2S_DOUT", "7",  "9", 3, 24.059, True)):
    _pp, _tp = _padpos("U1", _pnum), _padpos("U3", _u3pin)
    _py, _lane, _tx = _TOMM(_pp.y), _lane0 + _k * _BPITCH, _TOMM(_tp.x)
    if _vert:
        _pre_track(_pp, vmm(_xp - 0.245, _py), pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_xp - 0.245, _py), vmm(_xp, _py - 0.245),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_xp, _py - 0.245), vmm(_xp, _lane + 0.245),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_xp, _lane + 0.245), vmm(_xp + 0.245, _lane),
                   pcbnew.F_Cu, _BW, nets[_net])
        _xl = _xp + 0.245
    else:
        _pre_track(_pp, vmm(_xp, _py), pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_xp, _py), vmm(_xp + abs(_lane - _py), _lane),
                   pcbnew.F_Cu, _BW, nets[_net])
        _xl = _xp + abs(_lane - _py)
    _pre_track(vmm(_xl, _lane), vmm(_tx - 0.245, _lane),
               pcbnew.F_Cu, _BW, nets[_net])
    _pre_track(vmm(_tx - 0.245, _lane), vmm(_tx, _lane - 0.245),
               pcbnew.F_Cu, _BW, nets[_net])
    _pre_track(vmm(_tx, _lane - 0.245), _tp, pcbnew.F_Cu, _BW, nets[_net])

# --- T1 bus winding vias (P1/P5, 0.5 mm bus nets): vias just east of T1 pads 1/3
#     with short pad stubs. The bus runs T1 -> around J2 (below); the switch
#     crossover maze is entirely Freerouting's.
_BUSW, _BCH = 0.5, 0.33
_t1p1, _t1p3 = _padpos("T1", "1"), _padpos("T1", "3")
for _net, _t1p in (("P1", _t1p1), ("P5", _t1p3)):
    _tvx = _TOMM(_t1p.x) + 2.4
    _tv = vmm(_tvx, _TOMM(_t1p.y))
    _pre_track(_tv, vmm(_tvx - 0.9, _TOMM(_t1p.y)), pcbnew.F_Cu, _BUSW, nets[_net])
    _pre_via(_tv, net=nets[_net])

# --- P1/P5 bus: T1 -> east -> north up the east strip (B.Cu free under the LED
#     block) -> west above J2's pad row -> down into the pins from the top (PTH pads
#     connect on B.Cu; no extra vias). T1 pins 1/3 are SWAPPED in the netlist
#     (P5 = pad 3 south, P1 = pad 1 north; winding polarity is inaudible) so P5 is
#     the outer loop (souther row, easter vertical, norther lane to the wester pin)
#     and P1 nests inside — zero crossings.
_j2p1, _j2p5 = _padpos("J2", "1"), _padpos("J2", "5")
for _net, _t1p, _jp, _vx2, _ytop in (
        ("P1", _t1p1, _j2p1, 48.64, 13.2),
        ("P5", _t1p3, _j2p5, 49.3, 12.54)):
    _ty2 = _TOMM(_t1p.y)
    _jx = _TOMM(_jp.x)
    for _a, _b in (
            ((_TOMM(_t1p.x) + 2.4, _ty2), (_vx2 - _BCH, _ty2)),
            ((_vx2 - _BCH, _ty2), (_vx2, _ty2 - _BCH)),
            ((_vx2, _ty2 - _BCH), (_vx2, _ytop + _BCH)),
            ((_vx2, _ytop + _BCH), (_vx2 - _BCH, _ytop)),
            ((_vx2 - _BCH, _ytop), (_jx + _BCH, _ytop)),
            ((_jx + _BCH, _ytop), (_jx, _ytop + _BCH)),
            ((_jx, _ytop + _BCH), (_jx, _TOMM(_jp.y)))):
        _pre_track(vmm(*_a), vmm(*_b), pcbnew.B_Cu, _BUSW, nets[_net])

# --- Opto LED cathode + emitter nets: geometry lifted from a clean Freerouting
#     solution, normalized and locked. Per CATH channel (opto pin 2 -> clamp diode
#     pad 2 -> limiter pad 1, bus width): 45° jog west off the opto pad (the vertical
#     sits 0.9934 west of the diode column, clearing the diode's anode pad by 0.29),
#     down, 45° into the diode pad, 45° across into the limiter. OC_EMIT (0.2 mm)
#     daisy-chains the opto pin 3s, hopping over the pad row at y=35.64 between
#     channels, and runs straight into R_em pad 1 (entering 0.05 off-centre).
def _pxy(_key, _num):
    _p = _padpos(_key, _num)
    return _TOMM(_p.x), _TOMM(_p.y)
def _chain(_net, _pts, _w):
    for _a, _b in zip(_pts, _pts[1:]):
        _pre_track(vmm(*_a), vmm(*_b), pcbnew.F_Cu, _w, nets[_net])
for _cnet, _ok, _do, _rl in (("OC1_CATH", "OC1", "D_oc1", "R_lim3"),
                             ("OC2_CATH", "OC2", "D_oc2", "R_lim1"),
                             ("OC3_CATH", "OC3", "D_oc3", "R_lim2")):
    _o, _d, _r = _pxy(_ok, "2"), _pxy(_do, "2"), _pxy(_rl, "1")
    _vx = _d[0] - 0.9934
    _chain(_cnet, [_o,
                   (_vx, _o[1] - (_o[0] - _vx)),
                   (_vx, _d[1] + (_d[0] - _vx)),
                   _d,
                   (_r[0], _d[1] - (_d[0] - _r[0])),
                   _r], _BUSW)
_e1, _e2, _e3 = _pxy("OC1", "3"), _pxy("OC2", "3"), _pxy("OC3", "3")
_rem = _pxy("R_em", "1")
_YH = 35.64
# descents land 0.148 short of the pad row + vertical stub: keeps the 45° leg
# 0.178 clear of the neighbouring pad 4's rounded corner (straight-in clips it)
_chain("OC_EMIT", [_e1, (_e1[0] - (_e1[1] - _YH), _YH),
                   (_e2[0] + (_e2[1] - 0.1483 - _YH), _YH),
                   (_e2[0], _e2[1] - 0.1483), _e2], _BW)
_chain("OC_EMIT", [_e2, (_e2[0] - (_e2[1] - _YH), _YH),
                   (_e3[0] + (_e3[1] - 0.1483 - _YH), _YH),
                   (_e3[0], _e3[1] - 0.1483), _e3], _BW)
_chain("OC_EMIT", [_e3, (_rem[0], _e3[1])], _BW)

# --- Relay coil drain nets (K*_DRAIN), geometry lifted from Freerouting and
#     normalized (its K3 solution even contained a 0.1 um micro-segment): from the
#     FET drain (Q pad 3) west, 45° down onto the flyback diode's row, T-junction at
#     x = K-pin-8 - 1.65; from there west into D pad 2, and 45° NE + vertical north
#     into K pin 8 (the coil).
for _dnet, _q, _k, _d in (("K1_DRAIN", "Q1", "K1", "D1"),
                          ("K2_DRAIN", "Q2", "K2", "D2"),
                          ("K3_DRAIN", "Q3", "K3", "D3")):
    _qp, _kp, _dp = _pxy(_q, "3"), _pxy(_k, "8"), _pxy(_d, "2")
    _vx = _kp[0] - 1.65
    _chain(_dnet, [_qp, (_vx + (_qp[1] - _dp[1]), _qp[1]), (_vx, _dp[1])], _BW)
    _chain(_dnet, [(_vx, _dp[1]), _dp], _BW)
    _chain(_dnet, [(_vx, _dp[1]),
                   (_kp[0], _dp[1] - (_kp[0] - _vx)), _kp], _BW)

# --- ESP-side USB pair, fully hand-routed: U1 pads 14/13 (USB_DP/DM_ESP) run
#     straight east on their pad rows into B.Cu vias in line with the pads — DM's via
#     (23.85, 46.72) sits on its vertical, DP's (24.43, 45.45) 0.58 east of DM's line
#     so its drop passes DM's via at 0.18 mm copper, converging via a 45° jog to the
#     0.329 pair pitch (same as the horizontal runs). The pair takes the SOUTH detour
#     (freeing the NE corridor for P1/P5): south beside GPIO8's B.Cu wall, 45° SE,
#     east at y=58.85/59.179 under T1 into the via pair west of the TPD2S017, fanning
#     F.Cu into D5 pins 6/1 (CH2_OUT/CH1_OUT).
_d5p6, _d5p1 = _padpos("D_esd", "6"), _padpos("D_esd", "1")
_p14, _p13 = _padpos("U1", "14"), _padpos("U1", "13")
# USB_DP_ESP (leader): straight stub on pad 14's row -> via (24.43,45.45) -> drop
# past DM's via (0.18 copper) -> 45° converge to the 0.329 pair -> south -> 45° ->
# east -> via (41.9,58.85) -> 45° -> D5 pad 6
_pre_track(vmm(_TOMM(_p14.x), _TOMM(_p14.y)), vmm(24.43, 45.45),
           pcbnew.F_Cu, _BW, nets["USB_DP_ESP"])
_pre_via(vmm(24.43, 45.45), net=nets["USB_DP_ESP"])
for _a, _b in (
        ((24.43, 45.45), (24.43, 47.3)),
        ((24.43, 47.3), (24.179, 47.551)),
        ((24.179, 47.551), (24.179, 57.1955)),
        ((24.179, 57.1955), (25.8335, 58.85)),
        ((25.8335, 58.85), (41.9, 58.85))):
    _pre_track(vmm(*_a), vmm(*_b), pcbnew.B_Cu, _BW, nets["USB_DP_ESP"])
_pre_via(vmm(41.9, 58.85), net=nets["USB_DP_ESP"])
for _a, _b in (
        ((41.9, 58.85), (42.7, 58.05)),
        ((42.7, 58.05), (_TOMM(_d5p6.x), _TOMM(_d5p6.y)))):
    _pre_track(vmm(*_a), vmm(*_b), pcbnew.F_Cu, _BW, nets["USB_DP_ESP"])
# USB_DM_ESP (follower): straight stub on pad 13's row -> via (23.85,46.72), in line
# with its vertical -> straight south -> 45° -> east at 0.329 -> diverge into via
# (41.9,59.65) -> 45° -> D5 pad 1
_pre_track(vmm(_TOMM(_p13.x), _TOMM(_p13.y)), vmm(23.85, 46.72),
           pcbnew.F_Cu, _BW, nets["USB_DM_ESP"])
_pre_via(vmm(23.85, 46.72), net=nets["USB_DM_ESP"])
for _a, _b in (
        ((23.85, 46.72), (23.85, 57.329)),
        ((23.85, 57.329), (25.7, 59.179)),
        ((25.7, 59.179), (41.429, 59.179)),
        ((41.429, 59.179), (41.9, 59.65))):
    _pre_track(vmm(*_a), vmm(*_b), pcbnew.B_Cu, _BW, nets["USB_DM_ESP"])
_pre_via(vmm(41.9, 59.65), net=nets["USB_DM_ESP"])
for _a, _b in (
        ((41.9, 59.65), (42.7, 60.45)),
        ((42.7, 60.45), (_TOMM(_d5p1.x), _TOMM(_d5p1.y)))):
    _pre_track(vmm(*_a), vmm(*_b), pcbnew.F_Cu, _BW, nets["USB_DM_ESP"])


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
_pol_lbl.SetPosition(vmm(8, 12.0))
_pol_lbl.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
_pol_lbl.SetTextThickness(pcbnew.FromMM(0.12))
_pol_lbl.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER)
board.Add(_pol_lbl)

# Default-position markers: short vertical tick at the pin-1 column (x = sw_x − 1.75) of
# each switch, in the gap between the top pad row (y≈15.35) and the body silk (y≈16.05).
# Slider left = pin 1↔2 + 4↔5 = normal/default polarity (matches pre-switch direct wiring).
for _swk in ("SW_OC1", "SW_OC2", "SW_OC3"):
    _swp = fps[_swk].GetPosition()
    _dm = pcbnew.PCB_SHAPE(board)
    _dm.SetShape(pcbnew.SHAPE_T_SEGMENT)
    _dm.SetLayer(pcbnew.F_SilkS)
    _dm.SetWidth(pcbnew.FromMM(0.25))
    _dm.SetStart(vmm(_TOMM(_swp.x) - 1.75, _TOMM(_swp.y) + 3.6))
    _dm.SetEnd(vmm(_TOMM(_swp.x) - 1.75, _TOMM(_swp.y) + 4.3))
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
      f"| board {x1-x0:.0f}x{y1-y0:.0f} mm | pre-route calls: {_PRE_N[0]}"
      + (f" (PRE_RANGE={_PRE_RANGE})" if _PRE_RANGE else ""))
