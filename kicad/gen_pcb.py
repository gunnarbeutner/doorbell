#!/usr/bin/env python3
"""Generate kicad/doorbell.kicad_pcb (footprints placed + nets assigned + outline).

Uses KiCad's native `pcbnew` API, so the board is a valid KiCad 10 file with a proper
layer stack. Circuit data (components, nets, footprints) comes from doorbell_design.py;
the PCB-specific placement lives HERE in `PCB_PLACE` (a schematic's layout and a board's
layout are different problems, so the board gets its own deliberate, compact placement).

The board comes out *placed and netted* (full ratsnest) but UNROUTED — route it with
route.py / `build.sh route`. Run with KiCad's bundled Python (owns pcbnew); see build.sh.
"""
import os, sys, math, datetime
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew
from doorbell_design import (COMP, REF, FOOTPRINT, NETS, FP_LIB_DIRS,
                             EDGE_FLUSH, EDGE_OVERHANG, ANTENNA_REF, LCSC,
                             TITLE, REVISION, COMPANY)

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
    "U2":     (45.44, 44.0, 180), # SGM2212 LDO; rotated CW; x puts pad 3 dead above C_in pad 1 (x=42.47)
                                 # so the +5V spine's descent (x=40.6) clears the
                                 # MIC_A/MIC_B NE wrap verticals west of the pad toes;
                                 # the tab's PTH pads keep 0.127 to P1's east-strip
                                 # B.Cu vertical, which moved east in step.
    "R_io8":  (27.0, 61.2, 90),  # GPIO8 pull-up, SE of U1 beside C_3v3. GPIO8 pad (1)
                                 # faces south onto its B.Cu via (GPIO8 crosses under
                                 # the I2S fan corridor); +3V3 pad (2) faces north,
                                 # tapping the C_dec/C_3v3 power rail (pre-routed).
    "C_in":   (43.25, 48.25, 0), # LDO input cap (C2)
    "C_out":  (42.47, 38.75, 270), # LDO output cap (C4), on U2 pad 1's column for a dead-vertical GND run
    "LED1":   (48.0, 16.5, 90), # power LED; right of J2
    "R_led":  (48.0, 13.5, 270), # LED series resistor; right of J2
    "C_dec":  (24.2, 61.2, 270),  # 100nF decoupling; just clear of U1's east courtyard
    "C_3v3":  (25.6, 61.2, 270),  # 10uF decoupling; same row, centred between C_dec and R_io8
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
    # The whole opto sub-assembly sits 1.9 mm further north (y -1.9) than it used to:
    # far enough north to fit the collector pull-up row (R_pu*) + escape-lane stack
    # between the opto pad row and the BOOT/RST cluster, while keeping a 1.6 mm
    # pad-free band south of the polarity switches for their silkscreen markings.
    # (A 3 mm shift pulled the RET-net 45° entries into the switch pad row.)
    "OC3":    (2.74, 31.6, 270),   # apartment bell sense; opto block centered in UL quadrant
    "OC2":    (6.74, 31.6, 270),   # house bell sense; opto block centered in UL quadrant
    "OC1":    (10.74, 31.6, 270),  # session-sense opto; right of OC2 in the bell-sense row
    "R_lim1": (6.74, 21.35, 0),    # R1, OC2's own LED limiter (above OC2) -- unshared
    "R_lim2": (2.74, 21.35, 0),    # R2, OC3's own LED limiter (above OC3) -- unshared
    "R_lim3": (10.74, 21.35, 0),   # R17, OC1's LED limiter (above OC1)
    # Opto LED reverse-voltage clamps (1N4148W anti-parallel): between R_lim and opto, same column.
    # Rotated 270->90 with the 2026-06-10 net-pin swap (pads keep their previous XY positions).
    "D_oc3":  (2.74, 24.6, 90),
    "D_oc2":  (6.74, 24.6, 90),
    "D_oc1":  (10.74, 24.6, 90),
    "R_em":   (0, 33.92, 90),      # R3, emitter common resistor
    # Collector pull-ups, horizontal, 0.185 west of their opto columns so pad 1
    # (east, rot 180) sits DEAD ON the collector pad-4 column — the OC*_OUT stub from
    # pad 1 up into the collector is perfectly vertical. Pad 2 (west) taps +3V3 via
    # its own In1 via 0.88 further west (out of the escape-lane corridor; the lane
    # verticals/diagonals all live east of x=1.63 and below y~39.2).
    "R_pu3":  (2.555, 36.9, 180),
    "R_pu2":  (6.555, 36.9, 180),
    "R_pu1":  (10.555, 36.9, 180),
    "K3":     (19.5, 27, 270),# chime-suppress relay, shifted +4mm right to clear OC1 column
    "Q3":     (23.5, 34, 180),# NMOS, swapped with R_pd3 + rotated 180°
    "R_g3":   (14.68, 36.9, 0),   # gate series R on the R_pu* row (y=36.9); x puts pad 2 dead above R_pd3.1
                                  # so GATE3 drops perfectly vertical
    "R_pd3":  (15.5, 34, 90), # gate pulldown, swapped with Q3 + rotated 180°
    "D3":     (18.8, 33.6, 0),# flyback, moved north (toward K3 coil)
    "K2":     (31, 27, 270),  # door-opener relay, rotated CW
    "Q2":     (35, 34, 180),  # NMOS, swapped with R_pd2 + rotated 180°
    "R_g2":   (26.18, 36.9, 0),   # gate series R on the R_pu* row (y=36.9); x puts pad 2 dead above R_pd2.1
                                  # so GATE2 drops perfectly vertical
    "R_pd2":  (27, 34, 90),   # gate pulldown, swapped with Q2 + rotated 180°
    "D2":     (30.3, 33.6, 0),# flyback, moved north (toward K2 coil)
    "R_ot":   (28.0, 21.25, 180), # ÖT bridge 2.2k: below J2, between pins 6/5
    # === K1 (PTT placeholder) relay + driver: same spacing as K3→K2 (11.5 mm) ===
    "K1":     (42.5, 27, 270),
    "Q1":     (46.5, 34, 180),
    "R_g1":   (37.68, 36.9, 0), # K1 gate series R, gate-side of the interlock; same
                                # position/orientation relative to R_pd1 as R_g2 has
                                # to R_pd2 (pad 2 dead above the pulldown's pad 1 so
                                # GATE1 drops perfectly vertical)
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
    # isolation transformer to the LEFT of U3, rotated clockwise (vertical). Bus winding (P1/P5)
    # on the east pads (B.Cu launch vias in the courtyard); secondary on the west pads, leaving
    # as a pair south to the series-resistor row below T1 (R_op/R_on/R_mn/R_mp).
    "T1":     (69, 30, 270),
    # Audio front-end series resistors (final-frame coordinates, NOT in _AUDIO_BLK —
    # the repack rotates that block about its centroid, so adding parts there would
    # shift every locked audio route). One row SOUTH of T1 (0.45 mm courtyard gap),
    # rot 270 so pad 1 faces north: each pad-1 launches a vertical that runs straight
    # north under T1's body (the 9 mm pad-free channel between its pad columns) into
    # the locked OUT_*/MIC_* lanes; pad 2 (south) carries the SEC_* tie back to T1's
    # west pads. The W->E order R_op/R_on/R_mn/R_mp is forced by the crossing-free
    # lane nesting (see the SEC/OUT/MIC route section): OUT legs take the inner NE
    # verticals, MIC legs the outer ones, and the interleaved order puts SEC_A on
    # the outer pads (linked through the resistors' own pad gaps) with SEC_B inside.
    "R_op":   (31.5, 60.5, 270),
    "R_on":   (32.8, 60.5, 270),
    "R_mn":   (34.1, 60.5, 270),
    "R_mp":   (35.4, 60.5, 270),
}
MARGIN = 1.0           # board edge margin (mm) on non-flush edges (right edge only)

def vmm(x, y): return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))

board = pcbnew.CreateEmptyBoard()
_tb = pcbnew.TITLE_BLOCK()
_tb.SetTitle(TITLE); _tb.SetRevision(REVISION); _tb.SetCompany(COMPANY)
_tb.SetDate(datetime.date.today().isoformat())
board.SetTitleBlock(_tb)
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
    if ref in LCSC:
        fp.SetField("LCSC", LCSC[ref])   # part number on the footprint (matches the BOM)
        for _fld in fp.GetFields():
            if _fld.GetName() == "LCSC":
                _fld.SetVisible(False)   # data field, not silk
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

# Nudge the north cap/pull-up row (R_sda + the MIC/VMID coupling caps) 0.1 mm
# further north, AFTER the block transforms (touching the placement table would
# move the block's bbox and shift everything). Historically this opened the
# C_vmid <-> C_aref corridor for a since-removed SEC lane; it is kept because the
# locked MIC_*/SEC_* routes assume the nudged pad positions (MIC_B's westbound
# lane at y=39.361 keeps 0.133 to C_vmid's pad-2 north edge).
for _k in ("R_sda", "C_mp", "C_mn", "C_vmid"):
    _p = fps[_k].GetPosition()
    fps[_k].SetPosition(pcbnew.VECTOR2I(_p.x, _p.y - pcbnew.FromMM(0.1)))

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

# --- ES8311 (U3) exposed pad: NO thermal vias (solder-wicking avoidance). The EP (GND)
#     grounds through pad 10 (AGND, tied into the EP) and the F.Cu GND pour; the codec's
#     milliwatt dissipation needs no dedicated thermal path to the inner plane. The
#     {EP, pad 10} GND cluster gets its plane bond from a via just SOUTH of pad 10,
#     OUTSIDE the footprint -- the EP's explicit plane bond. A via-keepout rule
#     area over the EP keeps the paste field hole-free.
_p10 = next(p for p in fps["U3"].Pads() if p.GetNumber() == "10")
_p10x, _p10y = _p10.GetPosition().x, _p10.GetPosition().y
# Exit straight south in the pad's own direction (0.2 mm, matching the
# neighbouring escapes), then one 45-degree turn south-east into the via.
# A via on the straight-south line would graze pad 9's I2S_DOUT escape
# (0.4 mm west), so the dogleg carries it 0.6 mm east; the via sits clear
# of the DOUT bend below by 0.35 mm.
_mid = pcbnew.VECTOR2I(_p10x, _p10y + pcbnew.FromMM(0.6))
_v10 = pcbnew.VECTOR2I(_p10x + pcbnew.FromMM(0.6), _p10y + pcbnew.FromMM(1.2))
for _a, _b in ((pcbnew.VECTOR2I(_p10x, _p10y), _mid), (_mid, _v10)):
    _tr = pcbnew.PCB_TRACK(board)
    _tr.SetStart(_a); _tr.SetEnd(_b)
    _tr.SetLayer(pcbnew.F_Cu); _tr.SetWidth(pcbnew.FromMM(0.2))
    _tr.SetNet(nets["GND"]); board.Add(_tr)
_v = pcbnew.PCB_VIA(board)
_v.SetPosition(_v10)
_v.SetDrill(pcbnew.FromMM(0.3)); _v.SetWidth(pcbnew.FromMM(0.6))
_v.SetNet(nets["GND"]); board.Add(_v)
# no-via rule area over the EP (tracks/pads/pour still allowed)
_ep = next(p for p in fps["U3"].Pads() if p.GetNumber() == "21")
_epx, _epy = pcbnew.ToMM(_ep.GetPosition().x), pcbnew.ToMM(_ep.GetPosition().y)
_kz = pcbnew.ZONE(board); _kz.SetIsRuleArea(True); _kz.SetLayerSet(pcbnew.LSET.AllCuMask())
_kz.SetDoNotAllowVias(True)
_kz.SetDoNotAllowTracks(False); _kz.SetDoNotAllowZoneFills(False)
_kz.SetDoNotAllowPads(False); _kz.SetDoNotAllowFootprints(False)
_kch = pcbnew.SHAPE_LINE_CHAIN()
for _pt in ((_epx - 0.95, _epy - 0.95), (_epx + 0.95, _epy - 0.95),
            (_epx + 0.95, _epy + 0.95), (_epx - 0.95, _epy + 0.95)):
    _kch.Append(vmm(*_pt))
_kch.SetClosed(True); _kz.AddPolygon(_kch)
_kz.SetZoneName("U3 EP no-via"); board.Add(_kz)

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

# --- ESP32-C6 (U1) EPAD: NO vias in the pad field (solder-wicking avoidance; the
#     window-pane paste then solders cleanly with nothing to drain into). The nine
#     0.8 mm sub-pads are laced together with unlocked F.Cu tracks (grid neighbours),
#     so the whole EPAD is one explicit copper net; the pad-28 tie (below) lands on
#     it and pad 28's own via west of the module is its plane bond. A no-via rule
#     area over the field keeps any future tooling from re-perforating it.
#     Placed AFTER the edge-flush slide (U1 is flush-pinned, so its pads move
#     during the slide).
_ep29s = [p.GetPosition() for p in fps["U1"].Pads() if p.GetNumber() == "29"]
_pitch = pcbnew.FromMM(1.3)   # cell pitch is 1.25 mm; tolerance for rounding
for _i, _a in enumerate(_ep29s):
    for _b in _ep29s[_i + 1:]:
        _dx, _dy = abs(_a.x - _b.x), abs(_a.y - _b.y)
        if (_dx <= _pitch and _dy == 0) or (_dx == 0 and _dy <= _pitch):
            _tr = pcbnew.PCB_TRACK(board)
            _tr.SetStart(_a); _tr.SetEnd(_b)
            _tr.SetLayer(pcbnew.F_Cu); _tr.SetWidth(pcbnew.FromMM(0.4))
            _tr.SetNet(nets["GND"]); board.Add(_tr)
_kz = pcbnew.ZONE(board); _kz.SetIsRuleArea(True); _kz.SetLayerSet(pcbnew.LSET.AllCuMask())
_kz.SetDoNotAllowVias(True)
_kz.SetDoNotAllowTracks(False); _kz.SetDoNotAllowZoneFills(False)
_kz.SetDoNotAllowPads(False); _kz.SetDoNotAllowFootprints(False)
_x0 = min(_p.x for _p in _ep29s) - pcbnew.FromMM(0.6)
_x1 = max(_p.x for _p in _ep29s) + pcbnew.FromMM(0.6)
_y0 = min(_p.y for _p in _ep29s) - pcbnew.FromMM(0.6)
_y1 = max(_p.y for _p in _ep29s) + pcbnew.FromMM(0.6)
_kch = pcbnew.SHAPE_LINE_CHAIN()
for _px, _py in ((_x0, _y0), (_x1, _y0), (_x1, _y1), (_x0, _y1)):
    _kch.Append(pcbnew.VECTOR2I(_px, _py))
_kch.SetClosed(True); _kz.AddPolygon(_kch)
_kz.SetZoneName("U1 EPAD no-via"); board.Add(_kz)

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
    board.Add(_tr)

# --- J1 VBUS bias pre-route: B9 (VBUS pad) -> via just north of it -> across on B.Cu
#     (45°/90° turns only) -> via beside D5 pin 5 (TPD2S017 VCC bias) -> F.Cu into the
#     pin.
_vbus_net = nets["VBUS"]
# Debug gate for bisecting pre-route problems: PRE_RANGE="lo:hi" places only the
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
    # skip degenerate/micro segments (0.05 mm guard; dropped stubs stay
    # connected through the overlapping copper of the adjoining track/pad)
    if abs(a.x - b.x) < pcbnew.FromMM(0.05) and abs(a.y - b.y) < pcbnew.FromMM(0.05):
        return
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(a); t.SetEnd(b); t.SetLayer(layer)
    t.SetWidth(pcbnew.FromMM(w)); t.SetNet(net or _vbus_net)
    board.Add(t)   # nothing is locked: pre-routes are plain copper
def _pre_via(pos, net=None):
    if not _pre_enabled(f"via {(net or _vbus_net).GetNetname()} "
                        f"({pcbnew.ToMM(pos.x):.3f},{pcbnew.ToMM(pos.y):.3f})"):
        return
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(pos)
    v.SetDrill(pcbnew.FromMM(0.3)); v.SetWidth(pcbnew.FromMM(0.6))
    v.SetNet(net or _vbus_net)
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
#    D10's cathode pad. (D4's anode is tied into VBUS_F by the hand routes below.)
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
# D10 GND via: south of the anode pad (pin 2), fed by one dead-vertical stub.
_d10a = next(p for p in fps["D_tvs"].Pads() if p.GetNumber() == "2").GetPosition()
_d10gv = pcbnew.VECTOR2I(_d10a.x, _d10a.y + pcbnew.FromMM(1.7))
_pre_track(_d10a, _d10gv, pcbnew.F_Cu, w=0.5, net=nets["GND"])  # TVS surge return
_pre_via(_d10gv, net=nets["GND"])

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
#     pitch, and all stop just west of OK2 pad 3; their eastward continuations are
#     hand-routed further below.
#     With the GATE pad swap (18=K2, 19=K3, 20=K1) the lane stack's targets are ordered
#     strictly west->east (OK2, OK1, R_g1, R_g3, R_g2), so every north-bend out of the
#     stack is crossing-free and the whole bundle hand-routes with no vias: each line
#     leaves its run with a 45° rise into its target (opto pad 4 / gate R pad 1).
_BPITCH, _BCORNER, _BW = 0.329, 0.49, 0.2
_u1px = _TOMM(next(p for p in fps["U1"].Pads() if p.GetNumber() == "18").GetPosition().x)
_oc3p4 = next(p for p in fps["OC3"].Pads() if p.GetNumber() == "4").GetPosition()
_tx, _ty = _TOMM(_oc3p4.x), _TOMM(_oc3p4.y)
# Collector pull-ups (R_pu*) sit in-line directly south of the opto pad row; each OC
# lane lands on its pull-up's pad 1 (through-pad) and a short stub continues north
# into the opto's collector pad 4. All lane geometry rebases off the pull-up pad-1
# row (_tyr) instead of the opto pad row; the GATE lanes shift down with it.
_pu3p1 = next(p for p in fps["R_pu3"].Pads() if p.GetNumber() == "1").GetPosition()
_tyr = _TOMM(_pu3p1.y)                    # pull-up pad-1 row (pad 1 x = collector column)
_APPR = 0.55                              # diagonal->vertical approach offset below pad-1
                                          # centre (pad half-height 0.475 -> the 45° ends
                                          # 0.075 off the pad edge: tight landing)
_lane5 = _u1px - 0.75 - 0.129 - _BW / 2   # U1 pads are 1.5 mm long: edge at centre-0.75
_diag_c = _TOMM(_pu3p1.x) + _tyr + _APPR  # OC3's 45° approach line: x + y = const
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
        # vertical to the 45° line, diagonal to just below the pull-up's pad 1, stub
        # into its centre, then through-pad north into the opto's collector pad 4
        _pre_track(vmm(_lx, _py - _BCORNER), vmm(_lx, _diag_c - _lx),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_lx, _diag_c - _lx), vmm(_tx, _tyr + _APPR),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_tx, _tyr + _APPR), _pu3p1, pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(_pu3p1, _oc3p4, pcbnew.F_Cu, _BW, nets[_net])
    else:
        # vertical to this lane's 45° line (parallel to OC3's, 0.4625 mm/lane further
        # SE), diagonal NE, then flatten into an eastward horizontal: OC2 tops the stack
        # just clear of the pull-up pad row, each following lane one pitch lower.
        # Base 1.00 keeps the 45° rises into the pull-ups short (OC2: 0.45 mm) and the
        # k=5 corner non-degenerate (_c - _yh >= _lx by ~0.65). The bottom lane runs
        # over SW_boot's courtyard (legal for tracks) but keeps 0.21 to R_en's pads
        # (top edge y=39.525) and 0.78 to SW_boot's (y=40.1) — the binding limits if
        # the opto assembly ever moves further south.
        _c = _diag_c + 0.4625 * _k             # this lane's 45° line: x + y = _c
        _yh = _tyr + 1.00 + (_k - 1) * _BPITCH   # horizontal level (OC2: pull-up row+1.00)
        _pre_track(vmm(_lx, _py - _BCORNER), vmm(_lx, _c - _lx),
                   pcbnew.F_Cu, _BW, nets[_net])
        _pre_track(vmm(_lx, _c - _lx), vmm(_c - _yh, _yh),
                   pcbnew.F_Cu, _BW, nets[_net])
        if _dst.startswith("OC"):
            # run east, 45° back up (mirroring the OC3 landing), stub into the pull-up's
            # pad 1, then through-pad north into the opto's collector pad 4
            _t4 = next(p for p in fps[_dst].Pads() if p.GetNumber() == "4").GetPosition()
            _rp1 = next(p for p in fps[{"OC2": "R_pu2", "OC1": "R_pu1"}[_dst]].Pads()
                        if p.GetNumber() == "1").GetPosition()
            _tpx = _TOMM(_rp1.x)               # pull-up pad 1 = collector column
            _dxr = _yh - (_tyr + _APPR)        # 45° rise from run level to pad approach
            _pre_track(vmm(_c - _yh, _yh), vmm(_tpx - _dxr, _yh),
                       pcbnew.F_Cu, _BW, nets[_net])
            _pre_track(vmm(_tpx - _dxr, _yh), vmm(_tpx, _tyr + _APPR),
                       pcbnew.F_Cu, _BW, nets[_net])
            _pre_track(vmm(_tpx, _tyr + _APPR), _rp1, pcbnew.F_Cu, _BW, nets[_net])
            _pre_track(_rp1, _t4, pcbnew.F_Cu, _BW, nets[_net])
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

# R_pu* +3V3 taps (R_boot pattern): stub straight west off pad 2 onto an In1-plane
# via. West keeps the barrel clear of the whole escape-lane corridor (verticals and
# diagonals all sit east of x=1.63 / below y~38.4) and of the opto pad row above.
for _rp in ("R_pu1", "R_pu2", "R_pu3"):
    _p2 = next(p for p in fps[_rp].Pads() if p.GetNumber() == "2").GetPosition()
    _vp = vmm(_TOMM(_p2.x) - 0.88, _TOMM(_p2.y))
    _pre_track(_p2, _vp, pcbnew.F_Cu, _BW, nets["+3V3"])
    _pre_via(_vp, net=nets["+3V3"])

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
# R_boot's +3V3 pad sits right against the locked BOOT wire; the (since-removed) autorouter NPEs trying
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
# run split at the pull-up tap so the stub joins at segment ENDPOINTS (the (since-removed) autorouter
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
# 0.5 mm: this row IS the module's supply feed -- the full WiFi-TX peak flows
# plane via -> R_io8.2 -> C_3v3 -> C_dec -> U1.2 (and its return mirrors on GND).
for _unum, _cnet, _cpad in (("2", "+3V3", "1"), ("1", "GND", "2")):
    _up = _padpos("U1", _unum)
    _c6p, _c3p = _padpos("C_dec", _cpad), _padpos("C_3v3", _cpad)
    _jog = abs(_TOMM(_c6p.y) - _TOMM(_up.y))
    if _jog >= 0.1:
        _pre_track(_up, vmm(_TOMM(_c6p.x) - _jog, _TOMM(_up.y)),
                   pcbnew.F_Cu, 0.5, nets[_cnet])
        _pre_track(vmm(_TOMM(_c6p.x) - _jog, _TOMM(_up.y)), _c6p,
                   pcbnew.F_Cu, 0.5, nets[_cnet])
    else:
        # rows nearly collinear: one slightly slanted segment, no micro-45° jog
        _pre_track(_up, _c6p, pcbnew.F_Cu, 0.5, nets[_cnet])
    _pre_track(_c6p, _c3p, pcbnew.F_Cu, 0.5, nets[_cnet])
_c3v3 = _padpos("C_3v3", "1")
# pad rows differ by only ~0.05 mm: one straight (slightly slanted) segment instead
# of a micro-45° jog, which the (since-removed) autorouter chokes on
_pre_track(_c3v3, _rio2, pcbnew.F_Cu, 0.5, nets["+3V3"])
# In1-plane tap for the rail: via just east of R_io8 pad 2
_v_io8b = vmm(_TOMM(_rio2.x) + 0.88, _TOMM(_rio2.y))
_pre_track(_rio2, _v_io8b, pcbnew.F_Cu, 0.5, nets["+3V3"])
_pre_via(_v_io8b, net=nets["+3V3"])
# In2-plane tap for the GND rail: via just south of C_3v3 pad 2 (east is blocked by
# R_io8's GPIO8 pad)
_c3g = _padpos("C_3v3", "2")
_v_c3g = vmm(_TOMM(_c3g.x), _TOMM(_c3g.y) + 0.88)
_pre_track(_c3g, _v_c3g, pcbnew.F_Cu, 0.5, nets["GND"])
_pre_via(_v_c3g, net=nets["GND"])
# Extra GND bond branching mid-segment off the U1.1 -> C_dec.2 run: shortens the
# 100 nF's HF return loop straight into the In2 plane (supplements the C_3v3-south
# via and U1's pad-28 bond). The +3V3 side deliberately keeps its single far-end
# via so the supply stays flow-through (plane -> R_io8 -> C_3v3 -> C_dec -> U1.2).
_u1g, _c6g = _padpos("U1", "1"), _padpos("C_dec", "2")
_bx = (_TOMM(_u1g.x) + _TOMM(_c6g.x)) / 2
_by = (_TOMM(_u1g.y) + _TOMM(_c6g.y)) / 2
_bvy = _TOMM(_c3g.y) + 0.88            # same row as C_3v3's GND via
_pre_track(vmm(_bx, _by), vmm(_bx, _bvy), pcbnew.F_Cu, 0.5, nets["GND"])
_pre_via(vmm(_bx, _bvy), net=nets["GND"])

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

# --- T1 bus winding vias (P1/P5, 0.5 mm bus nets): the bus winding sits on T1's
#     EAST pads (6 = P1 row, 4 = P5 row; the secondary owns the west pads so it can
#     leave as a pair, see the SEC section). Launch vias tuck inside T1's courtyard
#     2.4 mm WEST of the pads — east of the pads they would collide with D4 —
#     with short pad stubs. The bus runs T1 -> around J2 (below).
_BUSW, _BCH = 0.5, 0.33
_t1p6, _t1p4 = _padpos("T1", "6"), _padpos("T1", "4")
for _net, _t1p in (("P1", _t1p6), ("P5", _t1p4)):
    _tvx = _TOMM(_t1p.x) - 2.4
    _tv = vmm(_tvx, _TOMM(_t1p.y))
    _pre_track(_tv, _t1p, pcbnew.F_Cu, _BUSW, nets[_net])   # straight into the pad
    _pre_via(_tv, net=nets[_net])

# --- P1/P5 bus: T1 -> east -> north up the east strip (B.Cu free under the LED
#     block) -> west above J2's pad row -> down into the pins from the top (PTH pads
#     connect on B.Cu; no extra vias). T1 pins 6/4 are assigned in the netlist
#     (P5 = pad 4 south, P1 = pad 6 north; winding polarity is inaudible) so P5 is
#     the outer loop (souther row, easter vertical, norther lane to the wester pin)
#     and P1 nests inside — zero crossings.
_j2p1, _j2p5 = _padpos("J2", "1"), _padpos("J2", "5")
for _net, _t1p, _jp, _vx2, _ytop in (
        # verticals moved 0.49 east (were 48.64/49.3) with U2's 1.0 mm shift: P1
        # keeps 0.127 to the tab's PTH pads (barrels are all-layer copper)
        ("P1", _t1p6, _j2p1, 49.13, 13.2),
        ("P5", _t1p4, _j2p5, 49.79, 12.54)):
    _ty2 = _TOMM(_t1p.y)
    _jx = _TOMM(_jp.x)
    for _a, _b in (
            ((_TOMM(_t1p.x) - 2.4, _ty2), (_vx2 - _BCH, _ty2)),
            ((_vx2 - _BCH, _ty2), (_vx2, _ty2 - _BCH)),
            ((_vx2, _ty2 - _BCH), (_vx2, _ytop + _BCH)),
            ((_vx2, _ytop + _BCH), (_vx2 - _BCH, _ytop)),
            ((_vx2 - _BCH, _ytop), (_jx + _BCH, _ytop)),
            ((_jx + _BCH, _ytop), (_jx, _ytop + _BCH)),
            ((_jx, _ytop + _BCH), (_jx, _TOMM(_jp.y)))):
        _pre_track(vmm(*_a), vmm(*_b), pcbnew.B_Cu, _BUSW, nets[_net])

# --- Opto LED cathode + emitter nets: geometry lifted from a clean the (since-removed) autorouter
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
_YH = _e1[1] - 1.05   # hop lane 1.05 above the emitter pad row (under the packages)
# descents land 0.148 short of the pad row + vertical stub: keeps the 45° leg
# 0.178 clear of the neighbouring pad 4's rounded corner (straight-in clips it)
_chain("OC_EMIT", [_e1, (_e1[0] - (_e1[1] - _YH), _YH),
                   (_e2[0] + (_e2[1] - 0.1483 - _YH), _YH),
                   (_e2[0], _e2[1] - 0.1483), _e2], _BW)
_chain("OC_EMIT", [_e2, (_e2[0] - (_e2[1] - _YH), _YH),
                   (_e3[0] + (_e3[1] - 0.1483 - _YH), _YH),
                   (_e3[0], _e3[1] - 0.1483), _e3], _BW)
_chain("OC_EMIT", [_e3, _rem], _BW)   # single near-horizontal slant into R_em pad 1

# --- Relay coil drain nets (K*_DRAIN), geometry lifted from an autorouter run and
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

# --- WF26 bus nets (P1-P5, IN_P4), fully hand-routed at bus width. Geometry lifted
#     from a clean autorouter solution and normalized, PLUS the one link the autorouter
#     consistently failed to close (P5: switch cluster -> J2.5). The T1/J2 sections
#     above already land P1/P5 from T1 around J2 into the J2 pins; this section does
#     the rest:
#       P3    J2.3 west + 45° SW into R_ot pad 1 (F.Cu).
#       P4    J2.4 45° NW over the J2 pad row (y=13.317), west, long 45° SW past
#             J2.6, drop into K3 COM (pad 3) — all F.Cu.
#       P2    J2.2 south + 45° into K1.4; branch west along y=21.593 into K2.3; from
#             K2.3 weave west between K3 and the J2 pad row into SW_OC1 pad 4; via
#             pair under the switch row (B.Cu) up into pad 3.
#       IN_P4 J2.6 45° SW into K3.2 (NC) on F.Cu; J2.6 west along y=15 on B.Cu +
#             via up into SW_OC2 pad 1, 45° to pad 6; K1.3 (COM) loops north of K1
#             into a via and returns to J2.6 on a B.Cu 45°.
#       P1    J2.1 south on B.Cu, 45° SW, trunk west along y=23.613 (under the relay
#             contact row), 45° NW up into a via on SW_OC2 pad 4's column; F.Cu stub
#             into pad 4; B.Cu spurs west with vias up into SW_OC2 pad 3 and
#             SW_OC3 pads 4 and 3.
#       P5    branch the locked J2-loop corner at (30.48,12.54): B.Cu west above the
#             J2 pad row, via at x=17.85 (clear east of SW_OC1 pad 1), 45° F.Cu drop
#             into pad 1; cluster runs on F.Cu: 45° to SW_OC1 pad 6, the y=12.321
#             lane north of the switch pad rows to SW_OC3 pad 1, 45° to its pad 6.
#     Branches only ever meet at segment ENDPOINTS or pad centres (the (since-removed) autorouter
#     mishandles mid-segment T-junctions in protected wiring).
def _chainl(_net, _pts, _lay, _w=0.5):
    for _a, _b in zip(_pts, _pts[1:]):
        _pre_track(vmm(*_a), vmm(*_b), _lay, _w, nets[_net])
_j2p = {n: _pxy("J2", n) for n in "123456"}
# P3
_chainl("P3", [_j2p["3"], (36.486, 15.0), (30.236, 21.25), _pxy("R_ot", "1")], pcbnew.F_Cu)
# P4
_chainl("P4", [_j2p["4"], (31.967, 13.317), (25.908, 13.317), (17.9, 21.325),
               _pxy("K3", "3")], pcbnew.F_Cu)
# P2
_chainl("P2", [_j2p["2"], (40.65, 20.271), (38.7, 22.221), _pxy("K1", "4")], pcbnew.F_Cu)
_chainl("P2", [(38.7, 22.221), (38.07, 21.593), (30.783, 21.593), (30.154, 22.221),
               (29.4, 22.221), _pxy("K2", "3")], pcbnew.F_Cu)
# K2.3 -> SW_OC1.4: the old autorouter-derived weave shaved K2.4 / K3.1 / K3.2 /
# K3.3 at 0.13 (the DRC floor). Reworked: under-body runs at y=25.0 (0.35 clear of
# the pad row), the row crossing on the single 45° line (x - y = 1.75) that clears
# BOTH K2.4's SW corner and K3.1's NE corner at 0.21, a short y=21.9 lane north of
# K3.1 (0.45), and the pad-1/2 gap vertical at x=21.548 with chamfered 90s (0.8 to
# either pad). West of K3.1 the y=25.0 lane stays clear of the +5V coil spine
# (which enters K3.1 at x=23.3 from the south-east).
_chainl("P2", [_pxy("K2", "3"), (29.4, 25.0), (26.75, 25.0), (23.65, 21.9),
               (21.798, 21.9), (21.548, 22.15), (21.548, 24.75), (21.298, 25.0),
               (17.4, 25.0), (16.75, 24.35), _pxy("SW_OC1", "4")], pcbnew.F_Cu)
_chainl("P2", [_pxy("SW_OC1", "4"), (16.75, 17.172)], pcbnew.F_Cu)
_pre_via(vmm(16.75, 17.172), net=nets["P2"])
_chainl("P2", [(16.75, 17.172), (14.311, 17.172), (11.869, 14.731)], pcbnew.B_Cu)
_pre_via(vmm(11.869, 14.731), net=nets["P2"])
_chainl("P2", [(11.869, 14.731), _pxy("SW_OC1", "3")], pcbnew.F_Cu)
# IN_P4
_chainl("IN_P4", [_j2p["6"], (20.1, 21.55), _pxy("K3", "2")], pcbnew.F_Cu)
_chainl("IN_P4", [_j2p["6"], (13.176, 15.0), (11.721, 13.545)], pcbnew.B_Cu)
_pre_via(vmm(11.721, 13.545), net=nets["IN_P4"])
_chainl("IN_P4", [(11.721, 13.545), (11.526, 13.35), _pxy("SW_OC2", "1")], pcbnew.F_Cu)
_chainl("IN_P4", [_pxy("SW_OC2", "1"), (7.25, 16.85), _pxy("SW_OC2", "6")], pcbnew.F_Cu)
# K1.3 -> J2.6 return: under-body run dropped to y=25.0 (was 24.779 = 0.13 from
# K1.4's pad bottom; now 0.35) and the 45° up to the x=37.262 riser starts at
# y=24.54 so its diagonal passes K1.4's SW corner at 0.39 (a 45° straight off the
# old horizontal clipped it).
_chainl("IN_P4", [_pxy("K1", "3"), (40.9, 25.0), (37.722, 25.0), (37.262, 24.54),
                  (37.262, 22.908)], pcbnew.F_Cu)
_pre_via(vmm(37.262, 22.908), net=nets["IN_P4"])
_chainl("IN_P4", [(37.262, 22.908), (34.558, 22.908), _j2p["6"]], pcbnew.B_Cu)
# P1
_chainl("P1", [_j2p["1"], (44.15, 17.091), (37.628, 23.613), (17.492, 23.613),
               (10.75, 16.871)], pcbnew.B_Cu)
_pre_via(vmm(10.75, 16.871), net=nets["P1"])
_chainl("P1", [(10.75, 16.871), _pxy("SW_OC2", "4")], pcbnew.F_Cu)
_chainl("P1", [(10.75, 16.871), (6.96, 16.871)], pcbnew.B_Cu)
_chainl("P1", [(6.96, 16.871), (6.96, 14.489)], pcbnew.B_Cu)
_pre_via(vmm(6.96, 14.489), net=nets["P1"])
_chainl("P1", [(6.96, 14.489), (7.25, 14.199), _pxy("SW_OC2", "3")], pcbnew.F_Cu)
_chainl("P1", [(6.96, 16.871), (4.923, 16.871), (4.75, 17.044)], pcbnew.B_Cu)
_pre_via(vmm(4.75, 17.044), net=nets["P1"])
_chainl("P1", [(4.75, 17.044), _pxy("SW_OC3", "4")], pcbnew.F_Cu)
_chainl("P1", [(4.75, 17.044), (4.461, 17.044), (1.85, 14.432)], pcbnew.B_Cu)
_pre_via(vmm(1.85, 14.432), net=nets["P1"])
_chainl("P1", [(1.85, 14.432), (1.25, 13.832), _pxy("SW_OC3", "3")], pcbnew.F_Cu)
# P5
_chainl("P5", [(30.48, 12.54), (17.85, 12.54)], pcbnew.B_Cu)
_pre_via(vmm(17.85, 12.54), net=nets["P5"])
_chainl("P5", [(17.85, 12.54), (17.04, 13.35), _pxy("SW_OC1", "1")], pcbnew.F_Cu)
_chainl("P5", [_pxy("SW_OC1", "1"), (13.25, 16.85), _pxy("SW_OC1", "6")], pcbnew.F_Cu)
_chainl("P5", [_pxy("SW_OC1", "1"), (15.721, 12.321), (6.548, 12.321), (5.519, 13.35),
               _pxy("SW_OC3", "1")], pcbnew.F_Cu)
_chainl("P5", [_pxy("SW_OC3", "1"), (1.25, 16.85), _pxy("SW_OC3", "6")], pcbnew.F_Cu)
# OC3_RET rides along: with the bus nets pre-placed, the old autorouter could not find the
# escape for SW_OC3's centre pad 2 (greedy, no rip-up across protected wiring), so
# its previously-proven path is locked as well — 45° NW onto the y=12.321 lane,
# west, down the far-west column at x=0.316 (between the board edge and the SW_OC3 /
# P1 column), 45° SE into R_lim2 pad 2. All F.Cu, bus width (bus potential).
# OC3_RET's final approach: with the opto cluster 2.5 mm further north, a single 45°
# from the far-west column into R_lim2 pad 2 would cut straight through SW_OC3's
# south pad row (pads 6/5/4 at y 18.0-19.3). Thread the 0.975 mm channel between the
# switch pad row and the limiter pad row instead: down the x=0.316 column, 45° onto
# the channel centreline (y=19.7875), east past the switch, 45° NE up into pad 2.
_rl2 = _pxy("R_lim2", "2")
_YCH = 19.7875                     # channel centre: SW pad row bottom 19.3 + 0.4875
_chainl("OC3_RET", [_pxy("SW_OC3", "2"), (1.971, 12.321), (0.541, 12.321),
                    (0.316, 12.546), (0.316, _YCH - 0.25), (0.566, _YCH),
                    (_rl2[0] - (_rl2[1] - _YCH), _YCH), _rl2], pcbnew.F_Cu)
# Remaining opto switch-pad nets (bus width, F.Cu; geometry lifted from a clean
# the (since-removed) autorouter solution). Each JP net drops from its switch's centre pad 5 down a
# vertical between the switch columns, 45°s into the clamp diode's pad 1 and hops
# 45° onward into the opto's anode (pad 1) — the three channels are near-identical,
# OC1/OC3 with a 45° entry into the vertical, OC2's pad 5 already on its column.
# The RET nets run their switch's centre pad 2 down a vertical beside the cathode
# channel into the limiter's pad 2 (OC3_RET is locked further above).
_d1p, _d2p, _d3p = _pxy("D_oc1", "1"), _pxy("D_oc2", "1"), _pxy("D_oc3", "1")
_o1p, _o2p, _o3p = _pxy("OC1", "1"), _pxy("OC2", "1"), _pxy("OC3", "1")
# OC1/OC3 JP exits: leave the switch's centre pad 5 straight south for 0.4 mm BEFORE
# the 45° toward the clamp-diode column — a 45° straight off the pad passes only
# ~0.17 from the neighbouring throw pad's corner (SW_OC1 pad 6 / SW_OC3 pad 4).
# OC3's vertical runs at x=4.6 (not 4.378): 0.39 clear of R_lim2 pad 2's east edge
# instead of 0.17.
_sw1p5, _sw3p5 = _pxy("SW_OC1", "5"), _pxy("SW_OC3", "5")
_chainl("OC1_JP", [_sw1p5, (_sw1p5[0], _sw1p5[1] + 0.4),
                   (13.212, _sw1p5[1] + 0.4 + (_sw1p5[0] - 13.212)),
                   (13.212, _d1p[1] - (13.212 - _d1p[0])), _d1p], pcbnew.F_Cu)
_chainl("OC1_JP", [_d1p, (_o1p[0], _d1p[1] + (_o1p[0] - _d1p[0])), _o1p],
        pcbnew.F_Cu)
_chainl("OC2_JP", [_pxy("SW_OC2", "5"), (9.0, _d2p[1] - (9.0 - _d2p[0])), _d2p],
        pcbnew.F_Cu)
_chainl("OC2_JP", [_d2p, (_o2p[0], _d2p[1] + (_o2p[0] - _d2p[0])), _o2p],
        pcbnew.F_Cu)
_chainl("OC3_JP", [_sw3p5, (_sw3p5[0], _sw3p5[1] + 0.4),
                   (4.6, _sw3p5[1] + 0.4 + (4.6 - _sw3p5[0])),
                   (4.6, _d3p[1] - (4.6 - _d3p[0])), _d3p], pcbnew.F_Cu)
_chainl("OC3_JP", [_d3p, (_o3p[0], _d3p[1] + (_o3p[0] - _d3p[0])), _o3p],
        pcbnew.F_Cu)
_rl3 = _pxy("R_lim3", "2")
_chainl("OC1_RET", [_rl3, (_rl3[0] + 0.1015, _rl3[1] - 0.069),
                    (_rl3[0] + 0.1015, 16.721), _pxy("SW_OC1", "2")], pcbnew.F_Cu)
_rl1 = _pxy("R_lim1", "2")
_chainl("OC2_RET", [_pxy("SW_OC2", "2"), (9.0, 13.706), (6.371, 16.334),
                    (6.371, _rl1[1] - (_rl1[0] - 6.371)), _rl1], pcbnew.F_Cu)

# --- ES8311 (U3) analog / CE / supply hookups, fully hand-routed (0.2 mm, F.Cu).
#     The I2C/I2S nets into U3 are locked above; this completes every U3 net.
#     East column: OUTN / DACVREF / ADCVREF leave their pad rows and drop into their
#     caps' pad-1 centres on three nested parallel 45° diagonals (0.85 mm apart);
#     DACVREF/ADCVREF take short verticals first (x=34.805/34.405, one staircase step
#     apart) so the long diagonals land dead-on. OUTP runs dead on its own pad row
#     (0.2 clear of OUTN's stub one row below) east past the column and rises 45°
#     NE into C_op. North row: MIC1P/MIC1N rise as
#     a symmetric pair off pads 18/17 and 45° outward into C_mp/C_mn; VMID does the
#     same one column over (1.4 mm 45° into C_vmid). CE rises off pad 20, 45°s NW
#     onto R_ce's row and runs straight into the pull-down — nested parallel to the
#     locked SDA drop one pad over. Supplies: pads 3/4 (DVDD/PVDD) tie west onto a
#     shared rail with an In1-plane via mid-rail, continuing straight into C_pv pad 1
#     and up the pad-1 column into C_dv; pad 11 (AVDD) runs straight east into
#     C_avb pad 1 (entering 0.1 off-centre) and up the column into C_av, with an
#     In1 via below C_av. GND: pad 5 stubs west + 45° into an In2 via; pad 10 runs
#     straight north into the exposed pad (grounded by the F.Cu pour, no EP vias); the cap GND columns
#     (C_av/C_avb, C_vref/C_aref, C_dv/C_pv) each get a pad-2 column tie + In2 via;
#     C_vmid's GND pad taps a via 0.9 mm east. R_sda's +3V3 pad stubs north into its
#     own In1 via (the FR-proven spot).
_chainl("ES_OUTP", [_pxy("U3", "12"), (35.805, 46.024), _pxy("C_op", "1")],
        pcbnew.F_Cu, _BW)
_chainl("ES_OUTN", [_pxy("U3", "13"), (35.005, 45.624), _pxy("C_on", "1")],
        pcbnew.F_Cu, _BW)
_chainl("ES_DACVREF", [_pxy("U3", "14"), (34.805, 45.224), (34.805, 44.624),
                       _pxy("C_vref", "1")], pcbnew.F_Cu, _BW)
_chainl("ES_ADCVREF", [_pxy("U3", "15"), (34.405, 44.824), (34.405, 43.824),
                       _pxy("C_aref", "1")], pcbnew.F_Cu, _BW)
_chainl("ES_VMID", [_pxy("U3", "16"), (33.085, 43.004), _pxy("C_vmid", "1")],
        pcbnew.F_Cu, _BW)
_chainl("ES_MICN", [_pxy("U3", "17"), (32.685, 42.104), _pxy("C_mn", "1")],
        pcbnew.F_Cu, _BW)
_chainl("ES_MICP", [_pxy("U3", "18"), (32.285, 42.004), _pxy("C_mp", "1")],
        pcbnew.F_Cu, _BW)
_chainl("ES_CE", [_pxy("U3", "20"), (31.485, 43.495), (30.844, 42.854),
                  _pxy("R_ce", "1")], pcbnew.F_Cu, _BW)
# +3V3 east (AVDD): pad 11 -> C_avb -> C_av -> plane via
_chainl("+3V3", [_pxy("U3", "11"), (36.605, 46.424), _pxy("C_avb", "1")],
        pcbnew.F_Cu, _BW)
_chainl("+3V3", [_pxy("C_avb", "1"), _pxy("C_av", "1"), (36.705, 48.457)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(36.705, 48.457), net=nets["+3V3"])
# +3V3 west (DVDD/PVDD): pads 3/4 onto the shared rail at x=29.885, via mid-rail,
# straight on into C_pv pad 1, pad-1 column up into C_dv
_chainl("+3V3", [_pxy("U3", "3"), (29.885, 45.624), (29.885, 45.824)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(29.885, 45.824), net=nets["+3V3"])
_chainl("+3V3", [_pxy("U3", "4"), (29.885, 46.024), (29.885, 45.824)],
        pcbnew.F_Cu, _BW)
_chainl("+3V3", [(29.885, 46.024), (28.365, 46.024)], pcbnew.F_Cu, _BW)
_chainl("+3V3", [_pxy("C_pv", "1"), _pxy("C_dv", "1")], pcbnew.F_Cu, _BW)
# R_sda pull-up supply: stub north + plane via
_chainl("+3V3", [_pxy("R_sda", "1"), (30.585, 39.152)], pcbnew.F_Cu, _BW)
_pre_via(vmm(30.585, 39.152), net=nets["+3V3"])
# GND: U3 pad 5 + west cap column + via; pad 10 into the EP; east cap columns + vias
_chainl("GND", [_pxy("U3", "5"), (30.185, 46.424), (29.935, 46.674)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(29.935, 46.674), net=nets["GND"])
_chainl("GND", [_pxy("C_pv", "2"), _pxy("C_dv", "2"), (25.925, 47.254)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(25.925, 47.254), net=nets["GND"])
_chainl("GND", [_pxy("U3", "10"), (33.085, 46.274)], pcbnew.F_Cu, _BW)
_chainl("GND", [_pxy("C_avb", "2"), _pxy("C_av", "2"), (38.265, 48.454)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(38.265, 48.454), net=nets["GND"])
_chainl("GND", [_pxy("C_vref", "2"), _pxy("C_aref", "2"), (38.265, 40.612)],
        pcbnew.F_Cu, _BW)
_pre_via(vmm(38.265, 40.612), net=nets["GND"])
_chainl("GND", [_pxy("C_vmid", "2"), (35.385, 40.044)], pcbnew.F_Cu, _BW)
_pre_via(vmm(35.385, 40.044), net=nets["GND"])

# --- +5V distribution, fully hand-routed (0.5 mm, F.Cu). One spine: D4 (Schottky
#     cathode) -> C_in -> U2.3 (LDO in), then west out of the pad and north on a
#     vertical at x=40.6 — threading the 0.22/0.175 gap between the MIC_A/MIC_B NE
#     wrap (x=40.03) and U2's pad toes / C_out's pad column (this thread is why U2
#     sits 1.0 mm east of its old spot) — ducks west at y=38.55 (0.132 north of the
#     MIC return lanes, clear of C_out's south pad in x), and lands on the straight
#     vertical at x=37.64, which (with R_g1 nudged 0.07 left) threads BOTH R_g1's
#     pad gap (0.13) and R_pd1's pad 1 (0.135) with no jog — onto D1's flyback row
#     and 45° up/over to K1's coil pin; from the (41.688,27.099) tee a west leg
#     crosses the relay block on y=27.099 / the 45° staircase, tapping each coil
#     pin (K2, K3) with a short stub off the y=24.779 row and each flyback anode
#     (D2, D3) dead-centre from above.
_chainl("+5V", [_pxy("D_vbus", "1"), (42.47, 50.78), _pxy("C_in", "1")], pcbnew.F_Cu)
_chainl("+5V", [_pxy("C_in", "1"), _pxy("U2", "3")], pcbnew.F_Cu)  # near-vertical slant
_chainl("+5V", [_pxy("U2", "3"), (41.225, 46.3), (40.6, 45.675), (40.6, 38.795),
                (40.355, 38.55), (37.773, 38.55), (37.64, 38.417),
                (37.64, 34.372), (38.012, 34.0),
                (39.75, 34.0), _pxy("D1", "1")], pcbnew.F_Cu)
_chainl("+5V", [_pxy("D1", "1"), (41.688, 32.062), (41.688, 27.099)], pcbnew.F_Cu)
_chainl("+5V", [(41.688, 27.099), (43.98, 27.099), (46.3, 24.779), _pxy("K1", "1")],
        pcbnew.F_Cu)
_chainl("+5V", [(41.688, 27.099), (37.12, 27.099), (34.8, 24.779)], pcbnew.F_Cu)
_chainl("+5V", [(34.8, 24.779), _pxy("K2", "1")], pcbnew.F_Cu)
_chainl("+5V", [(34.8, 24.779), (30.898, 28.681), (28.566, 28.681)], pcbnew.F_Cu)
_chainl("+5V", [(28.566, 28.681), (28.566, 33.516), _pxy("D2", "1")], pcbnew.F_Cu)
_chainl("+5V", [(28.566, 28.681), (24.664, 24.779), (23.3, 24.779)], pcbnew.F_Cu)
_chainl("+5V", [(23.3, 24.779), _pxy("K3", "1")], pcbnew.F_Cu)
_chainl("+5V", [(23.3, 24.779), (18.679, 29.4), (18.679, 32.071), _pxy("D3", "1")],
        pcbnew.F_Cu)

# --- GND / +3V3 plane taps for every remaining SMD pad, locked (0.2 mm stub +
#     through-via to the In2 / In1 plane; via spots FR-proven, stubs normalized to a
#     straight run or a single 45°). With these, the power nets are fully
#     hand-routed: U2's tab and J1's shield stakes are PTH (barrel-connected to the
#     planes); the U1/U3 exposed pads carry NO vias (solder-wicking avoidance) --
#     each is laced/tied on F.Cu and bonds to the planes through a via outside the
#     pad field (U1: pad 28's via; U3: pad 10's via).
def _tapvia(_net, _key, _num, _pts, _w=_BW):
    _chainl(_net, [_pxy(_key, _num)] + _pts, pcbnew.F_Cu, _w)
    _pre_via(vmm(*_pts[-1]), net=nets[_net])
# FET / pull-down GND row (vias in line with the pads, clear of the drain wiring)
_tapvia("GND", "Q1", "2", [(47.44, 33.785)])
_tapvia("GND", "Q2", "2", [(35.94, 33.785)])
_tapvia("GND", "Q3", "2", [(24.44, 33.785)])
_tapvia("GND", "R_pd1", "2", [(38.5, 32.345)])
_tapvia("GND", "R_pd2", "2", [(27.0, 32.345)])
_tapvia("GND", "R_pd3", "2", [(15.5, 32.345)])
_tapvia("GND", "R_em", "2", [(_pxy("R_em", "2")[0], _pxy("R_em", "2")[1] - 0.85)])
# BOOT/RST cluster + U1's far GND castellation (pad 28)
_tapvia("GND", "C_en", "2", [(16.927, 41.293)])
_tapvia("GND", "SW_en", "2", [(24.075, 42.356)])
_tapvia("GND", "SW_boot", "2", [(6.425, 42.336)])
# pad 28's plane via sits WEST of the pad (toward the board edge, clear of the
# under-module corridor); the pad additionally ties east + 45° into the EPAD's
# lower-left cell so the far GND castellation and the EPAD share explicit copper.
_tapvia("GND", "U1", "28", [(3.15, 61.96)], _w=0.5)  # module GND plane bond
for _a, _b in (((4.25, 61.96), (8.785, 61.96)),
               ((8.785, 61.96), (13.255, 57.49))):
    _tr = pcbnew.PCB_TRACK(board)
    _tr.SetStart(vmm(*_a)); _tr.SetEnd(vmm(*_b))
    _tr.SetLayer(pcbnew.F_Cu); _tr.SetWidth(pcbnew.FromMM(0.4))
    _tr.SetNet(nets["GND"]); board.Add(_tr)
# USB corner: CC pulldowns + input cap; LED block on the top edge (the LED via
# dodges P1's B.Cu vertical, the R_led via ducks under P5's B.Cu lane corner)
_tapvia("GND", "R_cc1", "2", [(49.21, 58.352), (48.944, 58.086)])
_tapvia("GND", "R_cc2", "2", [(47.93, 59.2), (47.38, 59.75)])
_tapvia("GND", "C_in", "2", [(45.33, 48.25)], _w=0.5)  # LDO input ripple return; via east of the pad, straight stub
_tapvia("GND", "LED1", "1", [(47.955, 18.169)])      # near-vertical slant, one segment
_tapvia("+3V3", "R_led", "1", [(47.455, 12.135), (47.455, 11.857)])
# LDO column: C_out sits on U2 pad 1's x, so U2.1 -> via -> C_out.2 is one dead-
# vertical GND run with the shared via on it; U2.2 / C_out.1 take their own +3V3
# vias. All LDO-column stubs run 0.5 mm: U2.2's stub carries the full +3V3 load
# into the In1 plane, and C_out's stubs carry its ripple current.
_chainl("GND", [_pxy("U2", "1"), (42.47, 40.446)], pcbnew.F_Cu, 0.5)
_pre_via(vmm(42.47, 40.446), net=nets["GND"])
_chainl("GND", [(42.47, 40.446), _pxy("C_out", "2")], pcbnew.F_Cu, 0.5)
_tapvia("+3V3", "U2", "2", [(42.47, 43.006)], _w=0.5)
_tapvia("+3V3", "C_out", "1", [(43.5, 37.9625)], _w=0.5)  # straight east on the pad centreline, clear of GATE1
# R_en's pull-up supply: single (near-45°) slant onto R_boot's locked +3V3 via
_chainl("+3V3", [_pxy("R_en", "1"), (15.2, 41.0)], pcbnew.F_Cu, _BW)

# --- GATE1_PRE + T1 secondary (SEC_A/SEC_B): locked along their proven paths.
#     Like OC3_RET, these are casualties of the locked walls around them (the +5V
#     spine and the U3/audio hookups): valid corridors exist — these exact routes
#     coexisted with identical +5V geometry — but the (since-removed) autorouter (greedy, no rip-up
#     through protected wiring) stops finding them on its own.
#     GATE1_PRE ducks onto B.Cu to cross under the relay-driver block (K3.6 -> via
#     -> east -> 45° staircase) and stays there all the way to a via just LEFT of
#     R_g1 pad 1, surfacing into the pad with one straight stub; SEC_A/SEC_B leave
#     T1's west pads as a 0.329 mm pair (see their section below).
_chainl("GATE1_PRE", [_pxy("K3", "6"), (17.9, 31.839)], pcbnew.F_Cu, _BW)
_pre_via(vmm(17.9, 31.839), net=nets["GATE1_PRE"])
_chainl("GATE1_PRE", [(17.9, 31.839), (23.966, 31.839), (26.886, 34.759),
                      (34.259, 34.759), (36.0, 36.5)], pcbnew.B_Cu, _BW)
_pre_via(vmm(36.0, 36.5), net=nets["GATE1_PRE"])
_chainl("GATE1_PRE", [(36.0, 36.5), (36.4, 36.9), _pxy("R_g1", "1")], pcbnew.F_Cu, _BW)
# --- T1 secondary <-> series resistors <-> coupling caps (SEC_*/OUT_*/MIC_*),
#     hand-routed and locked (restores the pre-resistor hand routes, adapted to the
#     net split). The resistors sit in a row south of T1 (see PCB_PLACE); every
#     route is F.Cu, 0.2 mm, no vias.
#     SEC pair: T1's west pads exit east and drop south past the pad column as a
#     0.329 mm pair (SEC_B west at x=28.6 from pad 3, SEC_A east at x=28.929 from
#     pad 1 — pad 1's exit row is north of pad 3's, so the nested 45°s never cross).
#     SEC_A (outer resistor pads) enters R_op.2 from the west on the pad-2 row and
#     links R_op.2 -> R_mp.2 through the resistors' own inter-pad gaps (one track at
#     y=60.5 crossing under R_on/R_mn's bodies); SEC_B dives under SEC_A's entry to
#     y=62.2, runs east below the row and rises into R_on.2 from the south, then
#     ties R_on.2 -> R_mn.2 straight along the pad-2 row.
#     OUT/MIC legs: each resistor's pad 1 launches a vertical straight north under
#     T1's body, peels east on its own lane between T1's pads and courtyard top
#     (y=49.871/50.2/50.529/50.858, 0.329 pitch, innermost vertical <-> northmost
#     lane), and wraps T1's NE corner on nested verticals x=39.043/39.372 (OUT pair)
#     and x=39.701/40.03 (MIC pair, the pre-split SEC wrap x's; 0.15 to U2's pad
#     toes). OUT_A lands 45° NW into C_op.2; OUT_B drops to y=44.169 and enters
#     C_on.2 between the C_op/C_on pad-2 rows (a direct 45° off its vertical would
#     brush C_op.2's corner). The MIC pair continues north past the cap field and
#     returns west on lanes y=39.032/39.361 north of the C_mp/C_mn/C_vmid pad-2 row
#     (MIC_B's lane + 45° drop into C_mn.2 reuse the pre-split link geometry
#     verbatim; MIC_A runs one pitch north and drops into C_mp.2). Keeping each
#     direction's two legs paired at 0.329 mm preserves the small pickup loop the
#     floating differential pair had before the split.
_chainl("SEC_A", [_pxy("T1", "1"), (28.684, 51.959), (28.929, 52.204),
                  (28.929, 61.075), (29.174, 61.32), _pxy("R_op", "2")],
        pcbnew.F_Cu, _BW)
_chainl("SEC_A", [_pxy("R_op", "2"), (31.5, 60.745), (31.745, 60.5),
                  (35.155, 60.5), (35.4, 60.745), _pxy("R_mp", "2")],
        pcbnew.F_Cu, _BW)
_chainl("SEC_B", [_pxy("T1", "3"), (28.355, 57.039), (28.6, 57.284),
                  (28.6, 61.955), (28.845, 62.2), (32.555, 62.2),
                  (32.8, 61.955), _pxy("R_on", "2")], pcbnew.F_Cu, _BW)
_chainl("SEC_B", [_pxy("R_on", "2"), _pxy("R_mn", "2")], pcbnew.F_Cu, _BW)
_chainl("OUT_A", [_pxy("R_op", "1"), (31.5, 50.116), (31.745, 49.871),
                  (38.798, 49.871), (39.043, 49.626), (39.043, 45.902),
                  _pxy("C_op", "2")], pcbnew.F_Cu, _BW)
_chainl("OUT_B", [_pxy("R_on", "1"), (32.8, 50.445), (33.045, 50.2),
                  (39.127, 50.2), (39.372, 49.955), (39.372, 44.414),
                  (39.127, 44.169), (38.51, 44.169), _pxy("C_on", "2")],
        pcbnew.F_Cu, _BW)
_chainl("MIC_B", [_pxy("R_mn", "1"), (34.1, 50.774), (34.345, 50.529),
                  (39.456, 50.529), (39.701, 50.284), (39.701, 39.606),
                  (39.456, 39.361), (33.868, 39.361), _pxy("C_mn", "2")],
        pcbnew.F_Cu, _BW)
_chainl("MIC_A", [_pxy("R_mp", "1"), (35.4, 51.103), (35.645, 50.858),
                  (39.785, 50.858), (40.03, 50.613), (40.03, 39.277),
                  (39.785, 39.032), (32.897, 39.032), _pxy("C_mp", "2")],
        pcbnew.F_Cu, _BW)

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

# --- USB-C connector side, fully hand-routed (0.2 mm, F.Cu; geometry lifted from a
#     clean the (since-removed) autorouter solution). D+/D− each tie their A/B pad pair together and
#     rise into the TPD2S017 inputs: DP joins A6<->B6 with a shallow U just south of
#     the pad row and runs B6 -> 45° -> vertical at x=45.5 -> 45° into D5 pin 4;
#     DM tees at (44.152, 61.598) — B7 and A7 join there and one 45° leads into
#     D5 pin 3. The CC lines wrap around J1's south side as two nested staircases
#     (CC2 inside, CC1 outside via y=64.695) up into their pulldowns' pad 1.
_chainl("USB_DP", [_pxy("J1", "B6"), (44.85, 61.697), (45.5, 61.047), (45.5, 58.6),
                   _pxy("D_esd", "4")], pcbnew.F_Cu, _BW)
_chainl("USB_DP", [_pxy("J1", "A6"), (43.85, 62.961), (44.162, 63.273),
                   (44.537, 63.273), (44.85, 62.96), _pxy("J1", "B6")],
        pcbnew.F_Cu, _BW)
_chainl("USB_DM", [_pxy("J1", "B7"), (43.35, 61.873), (43.625, 61.598),
                   (44.152, 61.598)], pcbnew.F_Cu, _BW)
_chainl("USB_DM", [(44.152, 61.598), (44.35, 61.796), _pxy("J1", "A7")],
        pcbnew.F_Cu, _BW)
_chainl("USB_DM", [(44.152, 61.598), (44.95, 60.8), _pxy("D_esd", "3")],
        pcbnew.F_Cu, _BW)
_chainl("USB_CC1", [_pxy("J1", "A5"), (42.85, 62.979), (44.566, 64.695),
                    (48.836, 64.695), (49.539, 63.993), (49.539, 60.899),
                    _pxy("R_cc1", "1")], pcbnew.F_Cu, _BW)
_chainl("USB_CC2", [_pxy("J1", "B5"), (45.85, 63.545), (46.615, 64.31),
                    (48.756, 64.31), (49.153, 63.913), (49.153, 61.793),
                    _pxy("R_cc2", "1")], pcbnew.F_Cu, _BW)

# --- Last nets, hand-routed — the board is now 100% hand-routed (route.py only
#     verifies connectivity). GATE1/2/3 share one pattern per channel: a perfectly vertical drop
#     ties the pull-down's pad 1 into the gate resistor's pad 2 (the R_g* sit
#     x-aligned over their pull-downs), then a straight run east on the y=36.9
#     resistor row and a 45° drop into the FET's gate pad — all F.Cu, no vias
#     (replaces the (since-removed) autorouter's two-via B.Cu detour on GATE3). EN leaves U1 pad 3
#     west and 45°s onto the RST button's pad column (x=19.925, clear of MCLK's
#     riser), running one straight line — F.Cu vertical, via, B.Cu hop under the
#     locked SDA/SCL lane stack, via, stub into the button; from the north via it
#     also runs west into C_en pad 1 (45° landing); R_en's EN pad ties to C_en
#     with one near-vertical slant. OT_BRIDGE is
#     a single near-vertical slant K2.4 -> R16.2 (bus width); LED_A's dead-straight
#     vertical is kept as the autorouter laid it.
for _gq, _gpd, _grg, _gx45 in (("Q1", "R_pd1", "R_g1", 45.49),
                               ("Q2", "R_pd2", "R_g2", 33.99)):
    _gnet = "GATE" + _gq[1]
    _chainl(_gnet, [_pxy(_gpd, "1"), _pxy(_grg, "2")], pcbnew.F_Cu, _BW)
    _chainl(_gnet, [_pxy(_grg, "2"), (_gx45, 36.9), _pxy(_gq, "1")], pcbnew.F_Cu, _BW)
# GATE3 can't run the y=36.9 row east — GATE1_DRV's locked escape channel crosses it
# at x=16.34 — so its FET leg ducks under on B.Cu west of the relay block instead:
# Q3 gate west on y=34.95, 45° down to a via, B.Cu west + 45° up to a second via,
# and a 45° F.Cu landing into R_pd3's pad 1.
_chainl("GATE3", [_pxy("R_pd3", "1"), _pxy("R_g3", "2")], pcbnew.F_Cu, _BW)
_chainl("GATE3", [_pxy("Q3", "1"), (20.552, 34.95), (19.377, 33.774),
                  (19.377, 33.11)], pcbnew.F_Cu, _BW)
_pre_via(vmm(19.377, 33.11), net=nets["GATE3"])
_chainl("GATE3", [(19.377, 33.11), (15.811, 33.11), (14.8, 34.121)],
        pcbnew.B_Cu, _BW)
_pre_via(vmm(14.8, 34.121), net=nets["GATE3"])
_chainl("GATE3", [(14.8, 34.121), _pxy("R_pd3", "1")], pcbnew.F_Cu, _BW)
_chainl("EN", [_pxy("U1", "3"), (20.984, 59.42), (19.925, 58.361),
               (19.925, 44.894)], pcbnew.F_Cu, _BW)
_pre_via(vmm(19.925, 44.894), net=nets["EN"])
_chainl("EN", [(19.925, 44.894), (19.925, 42.36)], pcbnew.B_Cu, _BW)
_pre_via(vmm(19.925, 42.36), net=nets["EN"])
_chainl("EN", [(19.925, 42.36), (18.14, 42.36), _pxy("C_en", "1")], pcbnew.F_Cu, _BW)
_chainl("EN", [(19.925, 42.36), _pxy("SW_en", "1")], pcbnew.F_Cu, _BW)
_chainl("EN", [_pxy("C_en", "1"), _pxy("R_en", "2")], pcbnew.F_Cu, _BW)
_chainl("OT_BRIDGE", [_pxy("K2", "4"), _pxy("R_ot", "2")], pcbnew.F_Cu)
_chainl("LED_A", [_pxy("R_led", "2"), _pxy("LED1", "2")], pcbnew.F_Cu, _BW)

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
                # The stock fiducial pad carries a 0.6 mm LOCAL clearance override. the (since-removed) autorouter
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
# V4.1 TODO: re-enable these. With no board fiducials, JLCPCB's CAM added two marks
# for the V4 proto run (approved 2026-06-12) -- and the production drill file shows they
# are DRILLED 1.152 mm positioning holes (JLCPCB's standard SMT tooling size) through a
# 1.55 mm pad on BOTH outer layers, not flat optical dots: one at ~(2.1, 68.25), just
# west of (outside) the antenna copper-clear zone (estimated impact < 0.3 dB), one at
# (36.0, 64.5) west of T1. Since they register the assembly fixture mechanically,
# optical fiducials alone may not stop the CAM from drilling them -- V4.1 should also
# pre-place 1.152 mm tooling holes at controlled positions (or carry an order remark
# keeping CAM-added holes away from the antenna edge).
_fids = []  # fiducials disabled
# _fids = [_place_fiducial("FID1", x0, y0),      # top-left
#          _place_fiducial("FID2", x0, y1),      # bottom-left
#          _place_fiducial("FID3", x1, y1)]      # bottom-right (top-right left empty -> asymmetric)
print(f"  fiducials: disabled")

# NOTE: J1 is the GCT USB4105 -- single-row SMD Type-C (only the shell stakes are THT).
# All 16 signal contacts escape from one fine-pitch pad row on F.Cu, so placement around
# J1 must leave the escape fan room and D+/D- want to drop to B.Cu over the GND plane;
# verify the (since-removed) autorouter copes after any reshuffle near the bottom edge.


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
_pol_lbl.SetPosition(vmm(8, 11.6))
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
_u3ref.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(_u3r + 0.5), pcbnew.FromMM(_u3b + 0.5)))
_u3ref.SetTextAngleDegrees(0)

# Reset Value() text on the two tactile switches: the library footprint places the text
# at a large local offset (8.68, 2.615) that lands far from the body after rotation.
for _k in ("SW_boot", "SW_en"):
    fps[_k].Value().SetPosition(fps[_k].GetPosition())
    fps[_k].Value().SetTextAngleDegrees(0)

# --- Refdes silk for every part with room on its own footprint (>= 0.8 mm text).
#     Small parts (0603 R/C, LED) stay hidden: a readable label cannot fit their
#     outline. Text sits on the body centre (under the part once populated --
#     bare-board orientation aid); 0.8 mm for the tight centres, library default
#     (>= 0.8) elsewhere.
#     dy/ang per part: SMA diodes run vertical (their inter-pad gap is taller
#     than wide); SOT-23 centres are too tight, so the FET labels sit just
#     below the body.
for _rk, _small, _dy, _ang in (
        ("Q1", True, 2.35, 0), ("Q2", True, 2.35, 0), ("Q3", True, 2.35, 0),
        ("D1", True, 0, 0), ("D2", True, 0, 0), ("D3", True, 0, 0),
        ("D_oc1", True, 0, 0), ("D_oc2", True, 0, 0), ("D_oc3", True, 0, 0),
        ("D_esd", True, -0.3, 0),
        ("D_vbus", True, 0, 90),
        ("OC1", True, 0, 0), ("OC2", True, 0, 0), ("OC3", True, 0, 0),
        ("U2", False, 0, 0)):
    _rl, _rr, _rt, _rb = fext(fps[_rk])
    _ref = fps[_rk].Reference()
    _ref.SetVisible(True)
    _ref.SetPosition(vmm((_rl + _rr) / 2.0, (_rt + _rb) / 2.0 + _dy))
    _ref.SetTextAngleDegrees(_ang)
    if _small:
        _ref.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
        _ref.SetTextThickness(pcbnew.FromMM(0.12))
# U2's ref: the SOT-223 body sits left of the pads' bbox centre -- nudge right.
_u2r = fps["U2"].Reference()
_u2r.SetPosition(pcbnew.VECTOR2I(_u2r.GetPosition().x + pcbnew.FromMM(0.5),
                                 _u2r.GetPosition().y))
# D10's ref: its SMA centre is too narrow for 3 chars; north is D4's, east is
# F1's pad column -- sit south of the body, east of the GND via stub.
_dl, _dr, _dt, _db = fext(fps["D_tvs"])
_d10ref = fps["D_tvs"].Reference()
_d10ref.SetVisible(True)
_d10ref.SetPosition(vmm((_dl + _dr) / 2.0 + 0.6, _db + 0.6))
_d10ref.SetTextAngleDegrees(0)
_d10ref.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(0.8), pcbnew.FromMM(0.8)))
_d10ref.SetTextThickness(pcbnew.FromMM(0.12))
# U1's ref: body centre is the EPAD field (silk over its mask openings would be
# clipped) -- sit north of the EPAD instead, still well inside the module outline.
_u1ref = fps["U1"].Reference()
_u1ref.SetVisible(True)
_u1ref.SetPosition(vmm(13.0, 51.5))
_u1ref.SetTextAngleDegrees(0)

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
_pn.SetText("Doorbell Controller V4.1  2026-06-13")
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

# --- Commissioning test points: TP1/TP2 = GND (the logic ground is isolated from the
#     WF26 bus by the optos/T1, so without these the only scope-ground grab points are
#     0603 cap ends), TP3 = +5V, TP4 = +3V3. Bare 1.5 mm pads, excluded from BOM/CPL.
#     GND/+3V3 get an offset through-via to their In2/In1 plane (no via-in-pad);
#     +5V has no plane, so TP3 stubs over to C_in pad 1 on a lane at y=47.4 that
#     threads between U2's pad row and C_in/C_out.
#     Positions are fixed (nudge here if a spot turns out inconvenient):
#       ref   net    pad (x, y)       plane via (x, y)
#       ref   net    pad (x, y)       plane via       ref-text offset
TP_TABLE = [
    ("TP1", "GND",  (37.5, 62.5),    (36.2, 62.5),  (0, -1.7)),
    ("TP2", "+5V",  (46.3, 21.1),    None,          (2.6, 0)),    # label east: J2 silk frame above
    ("TP3", "+3V3", (28.6, 39.152),  None,          (0, 1.7)),    # label south: R4 pad above
]
TP_LIB = FP_LIB_DIRS["TestPoint"]
for _ref, _net, (_tx, _ty), _via, (_lx, _ly) in TP_TABLE:
    _fp = pcbnew.FootprintLoad(TP_LIB, "TestPoint_Pad_D1.5mm")
    _fp.SetReference(_ref); _fp.SetValue(_net)
    _fp.SetPosition(vmm(_tx, _ty))
    _fp.Reference().SetPosition(vmm(_tx + _lx, _ty + _ly))
    _fp.SetAttributes(_fp.GetAttributes() | pcbnew.FP_EXCLUDE_FROM_POS_FILES
                      | pcbnew.FP_EXCLUDE_FROM_BOM)    # bare copper, not a placed part
    for _p in _fp.Pads():
        _p.SetNet(nets[_net])
    board.Add(_fp)
    if _via is not None:
        _pre_track(vmm(_tx, _ty), vmm(*_via), pcbnew.F_Cu, 0.4, nets[_net])
        _pre_via(vmm(*_via), net=nets[_net])
    print(f"  test point {_ref} ({_net}) at ({_tx},{_ty})")
# TP2 stub straight south into K1's coil pad 1 (+5V)
_chainl("+5V", [TP_TABLE[1][2], _pxy("K1", "1")], pcbnew.F_Cu, 0.4)
# TP3 stub straight east onto R18's (R_sda) +3V3 plane via
_chainl("+3V3", [TP_TABLE[2][2], (30.585, 39.152)], pcbnew.F_Cu, 0.4)

# GND stitching vias grounding float-thieving pockets (the GND thieve claims a
# pocket once it touches the via): relay/bus region (nearest copper: IN_P4/P4
# F.Cu pair 0.83 mm), the opto block (nearest copper: OK2.3 pad 0.77 mm), and
# NW of U3 outside its EP no-via area (nearest copper: U3.20 pad 0.65 mm);
# B.Cu is clear under all three.
_pre_via(vmm(19.0, 21.75), net=nets["GND"])
_pre_via(vmm(4.855, 35.75), net=nets["GND"])
_pre_via(vmm(30.5, 43.75), net=nets["GND"])
# Under T1, centred in the three gaps of the OUT_A/OUT_B/MIC_B/MIC_A column
# (1.3 mm pitch, 0.2 mm traces -> 0.25 mm via-edge clearance each side); grounds
# the inter-pair float strips, which then guard the OUT pair from the MIC pair.
_pre_via(vmm(32.15, 54.5), net=nets["GND"])
_pre_via(vmm(33.45, 54.5), net=nets["GND"])
_pre_via(vmm(34.75, 54.5), net=nets["GND"])
# Pocket SE of J1 (nearest copper: USB_CC1 0.59 mm) and the opto-output column
# strips west of the OC2/OC3_OUT verticals (nearest copper: 0.53 mm)
_pre_via(vmm(45.0, 64.0), net=nets["GND"])
_pre_via(vmm(2.75, 60.05), net=nets["GND"])
_pre_via(vmm(2.75, 58.15), net=nets["GND"])
# OC3 jumper pocket (nearest copper: OC3_JP 0.80 mm) and the bus corner
# pocket by OC3_RET/P5 (nearest copper: OC3_RET 0.68 mm)
_pre_via(vmm(3.0, 24.5), net=nets["GND"])
_pre_via(vmm(1.25, 15.5), net=nets["GND"])

board.BuildConnectivity()
out = os.path.join(HERE, "doorbell.kicad_pcb")
pcbnew.SaveBoard(out, board)
print(f"wrote {out} | footprints: {len(board.GetFootprints())} | nets: {board.GetNetCount()} "
      f"| board {x1-x0:.0f}x{y1-y0:.0f} mm | pre-route calls: {_PRE_N[0]}"
      + (f" (PRE_RANGE={_PRE_RANGE})" if _PRE_RANGE else ""))
