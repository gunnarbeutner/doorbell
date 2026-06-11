#!/usr/bin/env python3
"""Generate kicad/doorbell.kicad_sch (V4 core board) with kiutils.

Circuit data (components, nets, footprints, placement grid) lives in
`doorbell_design.py`; this file only turns it into a schematic. Connectivity is by
local labels placed exactly on each pin endpoint (abs = inst + (pinX, -pinY) for an
unrotated symbol); power rails use power-port symbols. Validate with:
    kicad-cli sch erc kicad/doorbell.kicad_sch
"""
import copy, re, uuid, os, datetime
from kiutils.schematic import Schematic, SchematicSymbol
from kiutils.symbol import SymbolLib
from kiutils.items.schitems import (LocalLabel, NoConnect, SymbolProjectInstance,
                                    SymbolProjectPath, Connection, Junction,
                                    Rectangle, Text)
from kiutils.items.common import (Position, Property, Effects, Stroke, Justify,
                                  Font, TitleBlock)
from doorbell_design import (REF, COMP, FP_OVERRIDE, NETS, NOCONN, GRID,
                             LCSC, SYMBOL_STANDIN, PURPOSE,
                             TITLE, REVISION, COMPANY)

HERE = os.path.dirname(os.path.abspath(__file__))
P3 = os.path.expanduser("~/Documents/KiCad/10.0/3rdparty/symbols/com_github_CDFER_JLCPCB-Kicad-Library")
ESPP = os.path.expanduser("~/Documents/KiCad/10.0/3rdparty/symbols/com_github_espressif_kicad-libraries/Espressif.kicad_sym")
KS = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols"
LIB = {
    "PCM_Espressif": ESPP,
    "PCM_JLCPCB-Power": f"{P3}/JLCPCB-Power.kicad_sym",
    "PCM_JLCPCB-Transistors": f"{P3}/JLCPCB-Transistors.kicad_sym",
    "PCM_JLCPCB-Diodes": f"{P3}/JLCPCB-Diodes.kicad_sym",
    "PCM_JLCPCB-Diode-Packages": f"{P3}/JLCPCB-Diode-Packages.kicad_sym",
    "PCM_JLCPCB-Optocouplers": f"{P3}/JLCPCB-Optocouplers.kicad_sym",
    "PCM_JLCPCB-Resistors": f"{P3}/JLCPCB-Resistors.kicad_sym",
    "PCM_JLCPCB-Capacitors": f"{P3}/JLCPCB-Capacitors.kicad_sym",
    "PCM_JLCPCB-Connectors_Buttons": f"{P3}/JLCPCB-Connectors_Buttons.kicad_sym",
    "Connector": f"{KS}/Connector.kicad_sym",
    "Connector_Generic": f"{KS}/Connector_Generic.kicad_sym",
    "Relay": f"{KS}/Relay.kicad_sym",
    "Device": f"{KS}/Device.kicad_sym",
    "ES8311": f"{HERE}/lib_audio/ES8311.kicad_sym",   # ES8311 mono codec (easyeda2kicad import)
    "SM_LP_5001": f"{HERE}/lib_audio/SM_LP_5001.kicad_sym",   # Bourns SM-LP-5001 (easyeda2kicad import)
    "cas220tb1": f"{HERE}/lib_switches/cas220tb1.kicad_sym",   # NIDEC CAS-220TB1 DPDT slide switch
    "TPD2S017": f"{HERE}/lib_usb/TPD2S017.kicad_sym",   # TI USB ESD clamp (easyeda2kicad import)
    "power": f"{KS}/power.kicad_sym",
}
_libcache = {}
def load_lib(nick):
    if nick not in _libcache:
        _libcache[nick] = SymbolLib.from_file(LIB[nick])
    return _libcache[nick]
def get_symbol(nick, entry):
    for s in load_lib(nick).symbols:
        if s.entryName == entry:
            return s
    raise KeyError(f"{nick}:{entry}")
def pin_pos(sym, number):
    for u in sym.units:
        m = re.search(r'_(\d+)_\d+$', u.entryName or "")
        unit = int(m.group(1)) if m else 1
        for p in u.pins:
            if p.number == number:
                return p.position.X, p.position.Y, unit
    raise KeyError(f"pin {number} not in {sym.entryName}")
def pin_angle_of(sym, number):
    for u in sym.units:
        for p in u.pins:
            if p.number == number:
                return p.position.angle or 0
    return 0

def U(): return str(uuid.uuid4())
def lib_copy(sym, libid):
    """Deep-copy a library symbol for embedding. KiCad 10 writes the pin-number
    hide flag as (pin_numbers (hide yes)), which this kiutils misses on parse —
    re-hide them for power symbols so ports don't sprout a stray '1'."""
    cs = copy.deepcopy(sym)
    cs.libId = libid
    if libid.startswith("power:"):
        cs.hidePinNumbers = True
        cs.pinNamesHide = True
    return cs
def mk_hidden():
    e = Effects(); e.hide = True; return e
def just(h=None, v=None):
    e = Effects()
    if h or v: e.justify = Justify(horizontally=h, vertically=v)
    return e

# Per-component value-text vertical nudge (mm, +down) for small parts whose
# default below-body value would collide with a pin row.
VALUE_DY = {"OC1": 3.81, "OC2": 3.81, "OC3": 3.81, "J2": 8.89}
# Refs whose ref/value should stack to the right of the body (clear of pins),
# mapped to the horizontal offset in mm.  Vertical passives get this automatically.
RIGHT_TEXT = {"Q1": 5.08, "Q2": 5.08, "Q3": 5.08,
              "K1": 16.5, "K2": 16.5, "K3": 16.5,
              "D_esd": 36.5}  # clear of its right-pin net labels (end ~x82)
# Refs whose ref/value stack to the LEFT of the body (right side is blocked),
# mapped to the horizontal offset in mm (text right-justified at ox-offset).
LEFT_TEXT = {"SW_OC1": 10.5, "SW_OC2": 10.5, "SW_OC3": 10.5,
             "R_em": 2.54,    # emitter trunk runs along the right side
             "R_sda": 2.54}   # right side crowds the audio group-box edge
# Refs whose ref/value stack ABOVE the body (below/inside is blocked).
TEXT_ABOVE = {"U2", "J1", "T1", "D_oc1", "D_oc2", "D_oc3"}
# Refs whose ref/value stack BELOW the body (sides are blocked by wires/ports).
BELOW_TEXT = {"SW_en", "SW_boot"}
# Symbol rotation (deg, KiCad convention). Lets 2-pin parts lie inline with the
# pin row they are wired to (90 = vertical passive turned horizontal, pin 1 left;
# 180 = vertical passive flipped, pin 1 at the bottom).
ROT = {"R_io8": 90, "R_led": 270, "LED1": 270,
       "R_en": 90, "R_boot": 90,
       # T1 flipped 180: the secondary now lives on pins 1/3 (winding swap, see
       # doorbell_design.py), so winding A must face the coupling caps on the right
       # and winding B (bus P1/P5 labels) the left.
       "T1": 180,
       # opto LED limiters laid horizontal (clockwise) so they sit inline on the
       # RET return wire: pin 2 (RET) faces left into the wire, pin 1 (CATH) right.
       "R_lim1": 270, "R_lim2": 270, "R_lim3": 270,
       # opto reverse-clamp diodes flipped 180 so cathode (pin 1) sits at the top
       # (opto-anode/JP node) and anode (pin 2) at the bottom (opto-cathode/CATH);
       # placed between the switch and the opto, anti-parallel to the LED.
       "D_oc1": 180, "D_oc2": 180, "D_oc3": 180,
       # opto collector pull-ups flipped so pin 1 (OC*_OUT) sits at the bottom,
       # dead on the collector stub; pin 2 (+3V3) faces up.
       "R_pu1": 180, "R_pu2": 180, "R_pu3": 180,
       # VBUS Schottky laid horizontal inline on J1's VBUS row: SS14 pin 2 (anode)
       # faces left toward J1, pin 1 (cathode/+5V) right.
       "D_vbus": 90,
       # VBUS TVS flipped so pin 1 (cathode) faces up into the VBUS_F run over J1,
       # pin 2 (anode) down into its GND port.
       "D_tvs": 180,
       # VBUS fuse inline on J1's VBUS row, pin 1 (J1 side) left
       "F_vbus": 90}
def screen_offset(px, py, ang):
    """Symbol-coord pin position -> screen offset for a symbol rotated by ang."""
    x, y = px, -py                      # screen y is down
    a = (-ang) % 360                    # KiCad rotates symbols CCW
    if a == 90:  return -y, x
    if a == 180: return -x, -y
    if a == 270: return y, -x
    return x, y

# ---- placement: GRID (units of 2.54mm) from the shared design module ----
# Schematic-only position overrides (grid units). GRID stays untouched so the PCB
# generator keeps its clusters; the schematic re-lays everything for legibility.
# Spacing is derived from symbol bboxes + label text length (~1.27mm/char + stub),
# so labels clear neighbouring symbols.  Functional zones (top row, left to right:
# USB-C | ESP32 + decoupling | LDO with the power LED below | relay drivers;
# bottom row: J2 + opto sense | RESET/BOOT over the ES8311 + transformer):
# the table keeps each zone's internal geometry; ZONE_SHIFT below moves the zones
# as rigid bodies into this floorplan.
G = 2.54
SCHEM_POS = {
    # --- USB-C: TPD2S017 flow-through ESD clamp below J1 (connects by labels: J1-side
    #     USB_DP/USB_DM in, ESP-side *_ESP out), CC terminators wired off the CC pins ---
    "J1": (19, 20), "D_esd": (18.5, 34.5),  # ESD clamp low enough that its pin labels
                                            # clear J1's GND hookup, high enough that
                                            # its body clears the box bottom
    "R_cc1": (34, 17.5), "R_cc2": (31, 18.5),   # hang from short wires off A5/B5
    # Fuse + Schottky laid horizontal inline on J1's VBUS row (J1 -> F1 -> D4 anode);
    # +5V port hangs off the cathode. The VBUS_F TVS riser climbs from the fuse output
    # over the top of J1.
    "F_vbus": (28, 14), "D_vbus": (32, 14), "D_tvs": (26, 8.5), "FLAG5": (35, 11),
    # --- LDO + its in/out caps (the ESP32/ES8311 decouplers live with their ICs):
    #     caps flank U2 with pin 1 on the VIN/VOUT pin row, wired straight across;
    #     the +5V/+3V3 ports ride the cap tops. ERC power flags tucked in right. ---
    "U2": (47, 18), "FLAG3": (56, 14.5), "FLAGG": (56, 21),
    "C_in": (42, 18.5), "C_out": (52, 18.5),
    "R_led": (137, 9), "LED1": (131, 9),   # horizontal chain right of the relay column
    # --- MCU straps below the MCU box: R/C tap a short EN/BOOT rail wired
    #     into the button, EN group left, BOOT group right ---
    "R_en": (73, 44), "C_en": (76, 45.5), "SW_en": (88, 45),
    "R_boot": (97, 44), "SW_boot": (106, 45),
    "U1": (82, 22),   # MCU raised to the top row, level with POWER
    # MCU decoupling pair (PCB group "MCU") top-right of U1, clear of the pad-28..26
    # port/label fan-out (ends ~x189) and of R_io8's +3V3 label row (y~48):
    "C_3v3": (100, 12), "C_dec": (105, 12),
    # single-use parts wired directly to the U1 pin they serve (right pin column):
    "R_io8": (98, 19),     # GPIO8 pull-up, rotated inline with pad 10's row
    # --- relay drivers, three rows right of the MCU ---
    # All three rows share the same cluster: gate series R on top (GATE*_PRE/DRV label
    # on pin 1), FET + pulldown on the wired gate trunk below. K1's gate R input is
    # GATE1_PRE (from K3's interlock contact); the GPIO (GATE1_DRV) goes to K3.5.
    # rows sit 7 units lower than the natural top so GATE1_PRE's vertical label
    # (R_g1 pin 1, ~13 mm of 90°-text) stays inside the group box
    "R_g1": (114, 25), "Q1": (116, 30), "R_pd1": (114, 37), "D1": (122, 29.5), "K1": (133, 30),
    "R_g2": (114, 49), "Q2": (116, 54), "R_pd2": (114, 59), "D2": (122, 53.5), "K2": (133, 54),
    "R_g3": (114, 73), "Q3": (116, 78), "R_pd3": (114, 83), "D3": (122, 77.5), "K3": (133, 78),
    "R_ot": (134, 48.5),   # ÖT bridge series R, wired on top of K2's NO contact (pin 4)
    # --- bell-sense rows: J2 | clamp diode | polarity switch | opto | limiter ---
    "J2": (17, 83),   # pulled toward the switches; its P*-labels end ~3 mm short of theirs
    # rows ordered OK1/OK2/OK3 top->bottom on a uniform 20-unit pitch. Clamp diodes
    # sit between the switch and the opto (gx46), centred on the opto-LED midpoint
    # (same row) so JP/CATH wire symmetrically; optos at gx54 for clearance.
    # R_lim* laid horizontal at X=92.71mm (gx 36.5, on the 1.27 grid; ~93mm),
    # dropped onto their RET wire rows (limiter row = SW row + 4.5 + drop/2.54)
    "D_oc1": (46, 63), "SW_OC1": (32, 63), "OC1": (54, 63), "R_lim3": (36.5, 71),
    "D_oc2": (46, 83), "SW_OC2": (32, 83), "OC2": (54, 83), "R_lim1": (36.5, 92.5),
    "D_oc3": (46, 103), "SW_OC3": (32, 103), "OC3": (54, 103), "R_lim2": (36.5, 111),
    "R_em": (66, 107),   # shared emitter R, hangs off a vertical trunk right of the optos
    # collector pull-ups: pin 1 (rot 180) lands dead on each opto's pin-4 row, the
    # body just east of the OC*_OUT pin label, west of the emitter trunk
    "R_pu1": (62.5, 60.5), "R_pu2": (62.5, 80.5), "R_pu3": (62.5, 100.5),
    # --- audio codec: I2C pull-ups above U3, xfmr + coupling caps below;
    #     DACVREF/ADCVREF reservoirs wired below the bend field, VMID reservoir
    #     and CE pull-down label-connected in the pocket left of U3 (see the
    #     single-use wiring section) ---
    #     supply decoupling row (PCB group "Audio codec") above U3, I2C pull-ups
    #     shifted right to make room:
    "C_dv": (75, 72), "C_pv": (80, 72), "C_av": (85, 72), "C_avb": (90, 72),
    # I2C pull-ups flank U3 so each wires straight down onto its codec pin:
    # SCL -> pin 1 (left column), SDA -> pin 19 (right column)
    "R_scl": (70, 72), "R_sda": (109, 72),
    "U3": (92, 86), "T1": (83, 106),
    # AC-coupling caps between U3's analog pins and T1 winding B; column order
    # matches the bend-row order so the pin->cap drops don't cross (see audio wiring)
    "C_op": (89, 98), "C_on": (93, 98), "C_mn": (97, 98), "C_mp": (101, 98),
    # audio front-end series resistors: one row below the coupling caps, inline on
    # each cap's column (pin 1 up = cap side, pin 2 down to the SEC_* rails)
    "R_op": (89, 101.5), "R_on": (93, 101.5), "R_mn": (97, 101.5), "R_mp": (101, 101.5),
    # DACVREF/ADCVREF reservoirs tucked below the coupling-cap bend field (fed by
    # wires down the free lanes east of the bends), stacked in one column so their
    # value texts don't crowd the coupling caps or the box edge; VMID reservoir +
    # CE pull-down live in the pocket left of U3's bottom edge, label-connected —
    # everything inside the group box (they used to overflow it to the east)
    "C_vref": (105, 98), "C_aref": (105, 104),
    "C_vmid": (84, 95.5), "R_ce": (77, 95.5),
}
GRID2 = dict(GRID); GRID2.update(SCHEM_POS)

# ---- zone shifts: move each functional group as a rigid body into the floorplan
# (offsets in grid units; multiples of 0.5 gu = 1.27 mm keep pins on the wire
# grid). Absolute mm literals in the wiring sections below are already expressed
# in the shifted frame — change a zone here and those literals move with it.
ZONE_SHIFT = (
    # MCU left, beside USB-C
    (("U1", "C_3v3", "C_dec", "R_io8"), (-24.5, 0)),
    # POWER to the top row, right of the MCU
    (("U2", "C_in", "C_out", "FLAG3", "FLAGG"), (47, -5.5)),
    # POWER LED centred in its (enlarged) box below POWER
    (("R_led", "LED1"), (-38, 18)),
    # RESET/BOOT trails the MCU
    (("R_en", "C_en", "SW_en", "R_boot", "SW_boot"), (-3, 0.5)),
    # bell sense up into the space the straps vacated
    (("J2", "D_oc1", "D_oc2", "D_oc3", "SW_OC1", "SW_OC2", "SW_OC3",
      "OC1", "OC2", "OC3", "R_lim1", "R_lim2", "R_lim3", "R_em",
      "R_pu1", "R_pu2", "R_pu3"), (-5.5, -13)),
    # audio block up-left, beside the bell rows (the extra +0.5/+1.5 centres the
    # contents in the group box, below its top-edge title)
    (("C_dv", "C_pv", "C_av", "C_avb", "R_scl", "R_sda", "U3", "T1",
      "C_op", "C_on", "C_mn", "C_mp", "R_op", "R_on", "R_mn", "R_mp",
      "C_vref", "C_aref", "C_vmid", "R_ce"), (-5.5, -11)),
    # relay drivers up to the top row
    (("R_g1", "Q1", "R_pd1", "D1", "K1", "R_g2", "Q2", "R_pd2", "D2", "K2",
      "R_g3", "Q3", "R_pd3", "D3", "K3", "R_ot"), (-2.5, -8.5)),
)
for _refs, (_zdx, _zdy) in ZONE_SHIFT:
    for _zr in _refs:
        _zx, _zy = GRID2[_zr]
        GRID2[_zr] = (_zx + _zdx, _zy + _zdy)

POS = {ref: (gx * G, gy * G) for ref, (gx, gy) in GRID2.items()}

# ---- build ----
sch = Schematic.create_new()
sch.version = "20250114"
sch.paper.paperSize = "A3"
sch.titleBlock = TitleBlock(title=TITLE, revision=REVISION, company=COMPANY,
                            date=datetime.date.today().isoformat())
sch.uuid = U()
ROOT = sch.uuid
PROJECT = "doorbell"

lib_symbols, used_libids = [], set()
pin_xy = {}    # (ref, pad) -> (absX, absY)
pin_ang = {}   # (ref, pad) -> pin angle (deg); 0=E 90=N 180=W 270=S in symbol coords

for ref, (nick, entry, value) in COMP.items():
    sym = get_symbol(nick, entry)
    libid = f"{nick}:{entry}"
    if libid not in used_libids:
        cs = lib_copy(sym, libid)
        lib_symbols.append(cs); used_libids.add(libid)
    ox, oy = POS[ref]
    pads = [pad for net in NETS.values() for (r, pad) in net if r == ref]
    pads += [pad for (r, pad) in NOCONN if r == ref]
    unit = 1
    for pad in pads:
        try:
            _, _, unit = pin_pos(sym, pad); break
        except KeyError:
            continue   # footprint-only pad (true NC die pad), no symbol pin — skip
    rang = ROT.get(ref, 0)
    inst = SchematicSymbol(libraryNickname=nick, entryName=entry,
                           position=Position(ox, oy, rang), unit=unit, uuid=U())
    designator = REF[ref]
    symprops = {p.key: p.value for p in sym.properties}
    fp = FP_OVERRIDE.get(ref, symprops.get("Footprint", ""))
    # Text placement: vertical 2-pin passives get ref/value stacked to the right
    # (clear of the top/bottom pins); other parts keep ref-above / value-below.
    allp = [(round(p.position.X, 2), round(p.position.Y, 2)) for u in sym.units for p in u.pins]
    is_vpassive = len(allp) == 2 and len({x for x, _ in allp}) == 1
    hide_ref = designator.startswith("#")
    rx_off = 1.78 if is_vpassive else RIGHT_TEXT.get(ref)
    if is_vpassive and ROT.get(ref, 0) in (90, 270):
        # passive turned horizontal: stack ref/value above the body, clear of the
        # wire (property angle counter-rotates the symbol angle -> horizontal text)
        vang = (360 - ROT[ref]) % 360
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(ox, oy - 5.08, vang))
        val_prop = Property(key="Value", value=value,
                            position=Position(ox, oy - 2.54, vang))
    elif ref in TEXT_ABOVE:
        body_top = oy - max((p.position.Y for u in sym.units for p in u.pins), default=0)
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(ox, body_top - 7.62, 0))
        val_prop = Property(key="Value", value=value,
                            position=Position(ox, body_top - 5.08, 0))
    elif ref in LEFT_TEXT:
        lx = ox - LEFT_TEXT[ref]
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(lx, oy - 1.27, 0), effects=just("right"))
        val_prop = Property(key="Value", value=value,
                            position=Position(lx, oy + 1.27, 0), effects=just("right"))
    elif ref in BELOW_TEXT:
        body_bot = oy - min((p.position.Y for u in sym.units for p in u.pins), default=0)
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(ox - 1.27, body_bot + 6.35, 0))
        val_prop = Property(key="Value", value=value,
                            position=Position(ox - 1.27, body_bot + 8.89, 0))
    elif rx_off is not None:
        rx = ox + rx_off
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(rx, oy - 1.27, 0), effects=just("left"))
        val_prop = Property(key="Value", value=value,
                            position=Position(rx, oy + 1.27, 0), effects=just("left"))
    else:
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(ox, oy - 2.54, 0))
        val_prop = Property(key="Value", value=value,
                            position=Position(ox, oy + 2.54 + VALUE_DY.get(ref, 0.0), 0))
    if hide_ref:
        ref_prop.effects = mk_hidden()
    inst.properties = [ref_prop, val_prop]
    if fp:
        inst.properties.append(Property(key="Footprint", value=fp,
                               position=Position(ox, oy, 0), effects=mk_hidden()))
    # Part-identity fields, hidden: LCSC # (design override beats the symbol's own field),
    # role description, and MPN/datasheet from the JLCPCB-library symbol. Stand-in symbols
    # (SYMBOL_STANDIN) describe a different part, so only the design-level fields apply.
    standin = ref in SYMBOL_STANDIN
    def hidden_prop(key, value):
        inst.properties.append(Property(key=key, value=value,
                               position=Position(ox, oy, 0), effects=mk_hidden()))
    lcsc = LCSC.get(ref) or symprops.get("LCSC") or symprops.get("LCSC Part")
    if lcsc:
        hidden_prop("LCSC", lcsc)
    if PURPOSE.get(ref):
        hidden_prop("Description", PURPOSE[ref])
    mpn = None if standin else (symprops.get("MPN") or symprops.get("Part"))
    if mpn:
        hidden_prop("MPN", mpn)
    ds = None if standin else symprops.get("Datasheet")
    if ds and ds != "~":
        hidden_prop("Datasheet", ds)
    inst.pins = {p.number: U() for u in sym.units for p in u.pins}
    inst.instances = [SymbolProjectInstance(name=PROJECT,
                      paths=[SymbolProjectPath(sheetInstancePath="/"+ROOT, reference=designator, unit=unit)])]
    sch.schematicSymbols.append(inst)
    for pad in set(pads):
        try:
            px, py, _ = pin_pos(sym, pad)
        except KeyError:
            continue   # footprint-only NC pad (e.g. ES8388 pads 9/25): covered on the PCB by NOCONN
        dx, dy = screen_offset(px, py, rang)
        pin_xy[(ref, pad)] = (ox + dx, oy + dy)
        pin_ang[(ref, pad)] = (pin_angle_of(sym, pad) + rang) % 360

# ---- power-port symbols for the rails (cleaner than a label on every pin) ----
POWER_SYMS = {"+5V": "+5V", "+3V3": "+3V3", "GND": "GND"}
# A pin's outward direction (away from its symbol body) = pin angle + 180.
#   symbol-angle convention: 0=East 90=North 180=West 270=South.
def outward_dir(ref, pad):
    return ((pin_ang.get((ref, pad), 0) or 0) + 180) % 360
# Power-port rotation so the port graphic points outward from the component pin.
#   +5V/+3V3 graphic extends North at rot 0; GND extends South at rot 0.
def power_rot(entry, outdir):
    base = 270 if entry == "GND" else 90     # outward dir of the graphic at rot 0
    return (outdir - base) % 360
# outward direction -> unit screen delta (screen +y is downward)
DIR_DELTA = {0: (1, 0), 90: (0, -1), 180: (-1, 0), 270: (0, 1)}
_pwr_n = [0]
_pwr_seen = set()           # stacked pins (e.g. J1 VBUS A4/B4/A9/B9) get one port, not four
def place_power(entry, x, y, outdir=90):
    if (entry, x, y) in _pwr_seen:
        return
    _pwr_seen.add((entry, x, y))
    libid = f"power:{entry}"
    if libid not in used_libids:
        cs = lib_copy(get_symbol("power", entry), libid)
        lib_symbols.append(cs); used_libids.add(libid)
    _pwr_n[0] += 1
    ref = f"#PWR{_pwr_n[0]:02d}"
    rot = power_rot(entry, outdir)
    dx, dy = DIR_DELTA[outdir]
    ss = SchematicSymbol(libraryNickname="power", entryName=entry,
                         position=Position(x, y, rot), unit=1, uuid=U())
    # Counter-rotate the value text so the rail name reads horizontally on
    # sideways/down-pointing ports (180 would render upside down -> use 0).
    vang = (360 - rot) % 360
    if vang == 180:
        vang = 0
    ss.properties = [
        Property(key="Reference", value=ref, position=Position(x, y, 0), effects=mk_hidden()),
        Property(key="Value", value=entry,
                 position=Position(x + dx * 4.5, y + dy * 4.5, vang),
                 effects=just(None if dx == 0 else ("left" if dx > 0 else "right"))),
    ]
    ss.pins = {"1": U()}
    ss.instances = [SymbolProjectInstance(name=PROJECT,
                    paths=[SymbolProjectPath(sheetInstancePath="/"+ROOT, reference=ref, unit=1)])]
    sch.schematicSymbols.append(ss)

LABEL_STUB = 2.54   # short wire from pin to label, so the text clears the pin number
STUB_BY_REF = {"U1": 5.08, "U3": 5.08,   # big ICs: pin numbers need more clearance
               "D_esd": 5.08}            # 2.54-pitch SOT-23-6: labels crowd the body
# Per-pin stub overrides: a longer stub pushes that one label clear of its neighbours.
STUB_BY_PIN = {("R_g1", "1"): 5.08,   # GATE1_PRE raised off R_g1's body
               ("R_g2", "1"): 5.08,   # GATE2_DRV raised off R_g2's body
               ("R_g3", "1"): 5.08}   # GATE3_DRV raised off R_g3's body
# Power pins rendered as a plain net label instead of a power port: U3's supplies sit
# between signal pins at 2.54 pitch, where rotated port graphics overlap everything;
# R_io8 lies inline with U1's dense pin column, so its rail end gets a label too.
POWER_AS_LABEL = {("U3", "3"), ("U3", "4"), ("U3", "5"), ("U3", "10"),
                  ("U3", "11"), ("U3", "21"), ("R_io8", "2"),
                  ("D_esd", "2"),  # GND mid-pin in the TPD2S017's 2.54-pitch column
                  # pull-up tops: a port graphic's sideways value text would cross
                  # the emitter trunk 9 mm to the east
                  ("R_pu1", "2"), ("R_pu2", "2"), ("R_pu3", "2")}
def add_label(net, x, y, outdir, stub=LABEL_STUB):
    dx, dy = DIR_DELTA[outdir]
    lx, ly = x + dx * stub, y + dy * stub
    if stub:
        wire((x, y), (lx, ly))
    sch.labels.append(LocalLabel(text=net, position=Position(lx, ly, outdir)))

# ---- wires: short orthogonal segments for obvious local connections ----
def wire(*pts):
    """Draw connected orthogonal segment(s) through the given (x,y) points."""
    for a, b in zip(pts, pts[1:]):
        sch.graphicalItems.append(Connection(
            type="wire",
            points=[Position(a[0], a[1]), Position(b[0], b[1])],
            stroke=Stroke(width=0, type="default"), uuid=U()))
def junction(x, y):
    sch.junctions.append(Junction(position=Position(x, y), uuid=U()))
def L(a, b, horiz_first=True):
    """L-shaped wire between a and b via one corner."""
    corner = (b[0], a[1]) if horiz_first else (a[0], b[1])
    wire(a, corner, b)

# Nets handled by explicit wiring below (skip auto label/power placement).
WIRED_NETS = set()
# Individual pins of label-connected nets that are wired explicitly instead
# (the rest of the net still carries labels).
SKIP_LABEL_PINS = {
                   ("R_en", "2"), ("C_en", "1"), ("SW_en", "1"),    # EN rail
                   ("R_boot", "2"), ("SW_boot", "1"),               # BOOT rail
                   ("SW_OC2", "5"), ("OC2", "1"),                   # JP wired over the switch
                   ("SW_OC3", "5"), ("OC3", "1"),
                   ("SW_OC1", "5"), ("OC1", "1"),
                   ("OC2", "2"), ("R_lim1", "1"),                   # CATH wired opto->limiter
                   ("OC3", "2"), ("R_lim2", "1"),
                   ("OC1", "2"), ("R_lim3", "1"),
                   ("D_oc2", "1"), ("D_oc2", "2"),                  # clamp wired anti-parallel
                   ("D_oc3", "1"), ("D_oc3", "2"),
                   ("D_oc1", "1"), ("D_oc1", "2")}
def PX(ref, pad): return pin_xy[(ref, pad)]

# ---- relay-driver clusters: wire the gate node and the drain/coil/flyback node.
def wire_relay_driver(rg, q, rpd, d, k, wire_gate=True):
    # GATE node: gate resistor bottom -> FET gate -> pulldown top (vertical trunk).
    # Skip when the gate net is split by an interlock (e.g. K1: GATE1_PRE / K3 / GATE1);
    # in that case the two sub-nets are connected by auto-labels and no direct wire is drawn.
    if wire_gate:
        wire(PX(rg, "2"), PX(rpd, "1"))        # gate pin taps this segment
        junction(*PX(q, "1"))                  # T where the FET gate taps the node
    # DRAIN node: FET drain -> (under flyback diode) -> relay coil pin 8.
    drain, dtop, k8 = PX(q, "3"), PX(d, "2"), PX(k, "8")
    wire(drain, (k8[0], drain[1]), k8)         # diode top pin taps the run
    junction(*dtop)                            # T where the diode taps the node
# K1's gate node (GATE1 = R_g1.2 + Q1 gate + R_pd1) is a standard trunk now that the
# series R sits gate-side of the K3 interlock; GATE1_PRE (K3.6 -> R_g1.1) and
# GATE1_DRV (U1.19 -> K3.5) connect by auto-labels.
WIRED_NETS.update(("K1_DRAIN", "GATE1", "GATE2", "K2_DRAIN", "GATE3", "K3_DRAIN"))
wire_relay_driver("R_g1", "Q1", "R_pd1", "D1", "K1")
wire_relay_driver("R_g2", "Q2", "R_pd2", "D2", "K2")
wire_relay_driver("R_g3", "Q3", "R_pd3", "D3", "K3")

# ---- power LED: series resistor straight down into the LED (one wire) ----
WIRED_NETS.add("LED_A")
wire(PX("R_led", "2"), PX("LED1", "2"))

# ---- single-use parts wired straight to the one pin they serve ----
WIRED_NETS.update(("GPIO8", "USB_CC1", "USB_CC2", "OT_BRIDGE",
                   "ES_DACVREF", "ES_ADCVREF"))
wire(PX("U1", "10"), PX("R_io8", "1"))    # GPIO8 pull-up inline with pad 10
wire(PX("J1", "A5"), PX("R_cc1", "1"))    # CC terminators hang off the CC pins
wire(PX("J1", "B5"), PX("R_cc2", "1"))
wire(PX("K2", "4"), PX("R_ot", "2"))      # ÖT bridge R sits on K2's NO contact
# DACVREF/ADCVREF reservoirs tuck below the coupling-cap bend field: east on the
# pin row (crossing the MIC bend verticals, as before), down the free lanes just
# east of the bend columns (x=262.89 / 265.43 — clear of every bend run), then a
# short west leg into the cap top.
_p14, _cv1 = PX("U3", "14"), PX("C_vref", "1")
wire(_p14, (262.89, _p14[1]), (262.89, _cv1[1]), _cv1)
_p15, _ca1 = PX("U3", "15"), PX("C_aref", "1")
wire(_p15, (265.43, _p15[1]), (265.43, _ca1[1]), _ca1)
# VMID reservoir + CE pull-down sit in the pocket left of U3's bottom edge and
# connect by label (a wire would have to cross the whole bend field). The pin-16
# label gets NO stub: "ES_VMID" then ends 0.5 mm short of the MIC1N bend vertical;
# pin 20's row is above the bend tops, so its auto label is safe. The pocket parts
# carry hand-placed horizontal labels off their pin-1 tips.
add_label("ES_VMID", *PX("U3", "16"), 0, stub=0)
add_label("ES_VMID", *PX("C_vmid", "1"), 0, stub=1.27)
add_label("ES_CE", *PX("R_ce", "1"), 0, stub=1.27)
SKIP_LABEL_PINS.update({("U3", "16"), ("C_vmid", "1"), ("R_ce", "1")})

# ---- LDO: C_in/C_out wired inline on the VIN/VOUT pin row. U2's own rail pins are
#      skipped so the +5V/+3V3 ports sit on the cap tops instead of riding the wires.
SKIP_LABEL_PINS.update({("U2", "3"), ("U2", "2"), ("U2", "4")})
wire(PX("U2", "3"), PX("C_in", "1"))      # VIN  <- input cap
wire(PX("U2", "2"), PX("C_out", "1"))     # VOUT -> output cap (pins 2/4 stack)

# ---- USB-C: VBUS wired through the Schottky inline on J1's VBUS row; the VBUS TVS
#      hangs from a run over the top of J1, and the TPD2S017's VCC bias pin joins by
#      label. D+/D- stacked A/B pairs are tied and named; the nets continue into the
#      TPD2S017 below J1 and on to U1 purely by label (auto-labels on its pins).
WIRED_NETS.update(("VBUS", "VBUS_F"))
_vb = PX("J1", "A4")                          # A4/B4/A9/B9 stack on one point
wire(_vb, PX("F_vbus", "1"))                  # J1 -> fuse
add_label("VBUS", 66.04, _vb[1], 90, stub=0)  # name sits on the J1->F1 run
_f2 = PX("F_vbus", "2")
wire(_f2, PX("D_vbus", "2"))                  # fuse output -> Schottky anode
wire(_f2, (_f2[0], 17.78), PX("D_tvs", "1"))  # TVS riser taps the fuse output, over J1
junction(*_f2)                                # T: fuse pin / Schottky run / TVS riser
add_label("VBUS_F", _f2[0], 24.13, 90, stub=0)   # name sits on the riser
add_label("VBUS_F", *PX("D_esd", "5"), 0)     # TPD2S017 VCC bias -> VBUS_F by label
SKIP_LABEL_PINS.update({("J1", "A6"), ("J1", "B6"), ("J1", "A7"), ("J1", "B7")})
for _pa, _pb, _net, _bx in (("A6", "B6", "USB_DP", 66.04),
                            ("A7", "B7", "USB_DM", 68.58)):
    pa, pb = PX("J1", _pa), PX("J1", _pb)
    wire(pa, (_bx, pa[1]), (_bx, pb[1]), pb)   # stacked-pair tie
    add_label(_net, _bx, pa[1], 0, stub=0)     # name on the tie's top corner

# ---- audio AC-coupling: U3's analog pins bend right/down on staggered columns and
#      rows, drop through the coupling caps, and land on two horizontal rails on
#      T1's winding-A pin rows (the secondary owns pins 1/3 after the winding swap;
#      T1 is drawn rotated 180 so those pins face the caps). Cap
#      columns are ordered by bend row so none of the runs cross each other.
WIRED_NETS.update(("ES_OUTP", "ES_OUTN", "ES_MICP", "ES_MICN",
                   "OUT_A", "OUT_B", "MIC_A", "MIC_B", "SEC_A", "SEC_B"))
for _pin, _cap, _bx, _by in (("12", "C_op", 250.19, 208.28),   # OUTP
                             ("13", "C_on", 255.27, 210.82),   # OUTN
                             ("17", "C_mn", 257.81, 213.36),    # MIC1N
                             ("18", "C_mp", 260.35, 215.9)):  # MIC1P
    _p, _c1 = PX("U3", _pin), PX(_cap, "1")
    wire(_p, (_bx, _p[1]), (_bx, _by), (_c1[0], _by), _c1)
# series resistors (R_op/R_on/R_mn/R_mp) sit inline below their caps: a short
# OUT_*/MIC_* link cap pad 2 -> R pad 1, then R pad 2 carries the SEC_* leg.
for _cap, _r in (("C_op", "R_op"), ("C_on", "R_on"),
                 ("C_mn", "R_mn"), ("C_mp", "R_mp")):
    wire(PX(_cap, "2"), PX(_r, "1"))
_t3, _t1p = PX("T1", "3"), PX("T1", "1")
# SEC_A rail on T1 pin 1's row; the outer resistors' pad-2 drops cross the SEC_B
# rail mid-wire (no junction) on the way down.
wire(_t1p, (PX("R_mp", "2")[0], _t1p[1]))
for _r in ("R_op", "R_mp"):
    _r2 = PX(_r, "2"); wire(_r2, (_r2[0], _t1p[1]))
junction(PX("R_op", "2")[0], _t1p[1])
# SEC_B rail: jogs one grid step below T1 pin 3's row — on the row itself,
# R_op's pad-2 endpoint (same y, mid-rail x) would merge the two nets.
_jx, _jy = _t3[0] + 1.27, _t3[1] + 2.54
wire(_t3, (_jx, _t3[1]), (_jx, _jy), (PX("R_mn", "2")[0], _jy))
for _r in ("R_on", "R_mn"):
    _r2 = PX(_r, "2"); wire(_r2, (_r2[0], _jy))
junction(PX("R_on", "2")[0], _jy)

# I2C pull-ups wired straight down onto their codec pins; the wire carries the net
# name (U1's pins keep their labels, binding the rest of the net).
SKIP_LABEL_PINS.update({("U3", "19"), ("R_sda", "2"), ("U3", "1"), ("R_scl", "2")})
_sda2, _scl2 = PX("R_sda", "2"), PX("R_scl", "2")
wire(PX("U3", "19"), (_sda2[0], PX("U3", "19")[1]), _sda2)
add_label("I2C_SDA", _sda2[0], 168.91, 90, stub=0)
wire(PX("U3", "1"), (_scl2[0], PX("U3", "1")[1]), _scl2)
add_label("I2C_SCL", 168.91, PX("U3", "1")[1], 0, stub=0)

# ---- opto collector pull-ups: each R_pu* stands on its opto's pin-4 stub (pin 1
#      dead on the collector row, pin 2 = +3V3 up). The OC*_OUT net keeps its pin-4
#      label, which binds the rest of the net (the U1 input) as before.
for _oc, _rp in (("OC1", "R_pu1"), ("OC2", "R_pu2"), ("OC3", "R_pu3")):
    wire(PX(_oc, "4"), PX(_rp, "1"))
SKIP_LABEL_PINS.update({("R_pu1", "1"), ("R_pu2", "1"), ("R_pu3", "1")})

# ---- shared opto emitter: one vertical trunk right of the optos drops into R_em ----
WIRED_NETS.add("OC_EMIT")
_re1 = PX("R_em", "1")
for _oc in ("OC1", "OC2", "OC3"):
    _p3 = PX(_oc, "3")
    wire(_p3, (_re1[0], _p3[1]))              # each emitter taps the trunk
wire((_re1[0], PX("OC1", "3")[1]), _re1)
junction(_re1[0], PX("OC2", "3")[1])
junction(_re1[0], PX("OC3", "3")[1])

# EN rail: R_en + C_en tap a short wire into the EN button; one EN label binds
# the rail to U1's EN pin label.
wire(PX("R_en", "2"), PX("SW_en", "1"))
junction(*PX("C_en", "1"))                # cap taps the rail mid-run
add_label("EN", 198.12, PX("SW_en", "1")[1], outdir=0, stub=0)    # name sits on the rail
# BOOT rail: same pattern, R_boot into the BOOT button.
wire(PX("R_boot", "2"), PX("SW_boot", "1"))
add_label("BOOT", 247.65, PX("SW_boot", "1")[1], outdir=0, stub=0)

# Polarity switches: JP wired over the top of the switch into the opto anode
# (net name bound by a mid-wire label + the clamp diode's label); RET wired
# under the bottom into the limiter return. Routes clear the P1/P2/P5/IN_P4
# pin-label texts (rise/drop per row sized to the longest label).
WIRED_NETS.update(("OC2_RET", "OC3_RET", "OC1_RET",
                   "OC2_CATH", "OC3_CATH", "OC1_CATH"))
for _sw, _oc, _rl, _d, _jp, _drop in (("SW_OC1", "OC1", "R_lim3", "D_oc1", "OC1_JP", 8.89),
                                      ("SW_OC2", "OC2", "R_lim1", "D_oc2", "OC2_JP", 12.7),
                                      ("SW_OC3", "OC3", "R_lim2", "D_oc3", "OC3_JP", 8.89)):
    sw5, sw2 = PX(_sw, "5"), PX(_sw, "2")
    oc1, oc2 = PX(_oc, "1"), PX(_oc, "2")     # opto LED: pin1 anode (JP), pin2 cathode (CATH)
    d1, d2 = PX(_d, "1"), PX(_d, "2")         # clamp: pin1 cathode (top, JP), pin2 anode (bot, CATH)
    rl2, rl1 = PX(_rl, "2"), PX(_rl, "1")
    jt = sw5[1] - 12.7                        # JP rail height: clears the switch top labels
    yc = rl1[1]                               # CATH rail = limiter row (limiter sits inline)
    # Each node is one horizontal rail with the clamp and opto hanging off it.
    # JP: SW pin5 leads straight up to the rail, then right; clamp + opto drop down.
    wire(sw5, (sw5[0], jt), (oc1[0], jt), oc1)
    wire((d1[0], jt), d1)
    junction(d1[0], jt)
    add_label(_jp, 72.39, jt, 0, stub=0)      # name sits on the rail
    # RET: SW pin2 down & across into the limiter return (pin 2), inline on the CATH row.
    rb = sw2[1] + _drop
    wire(sw2, (sw2[0], rb), (rl2[0], rb), rl2)
    # CATH: limiter pin 1 leads right along the rail; clamp + opto hang up (mirror of JP).
    wire(rl1, (oc2[0], yc), oc2)
    wire((d2[0], yc), d2)
    junction(d2[0], yc)

sch.libSymbols = lib_symbols

for net, pins in NETS.items():
    if net in WIRED_NETS:
        continue
    for (ref, pad) in pins:
        if (ref, pad) not in pin_xy:
            print("WARN missing pin", ref, pad); continue
        if (ref, pad) in SKIP_LABEL_PINS:
            continue
        x, y = pin_xy[(ref, pad)]
        outdir = outward_dir(ref, pad)
        if net in POWER_SYMS and (ref, pad) not in POWER_AS_LABEL:
            place_power(POWER_SYMS[net], x, y, outdir)
        else:
            add_label(net, x, y, outdir,
                      stub=STUB_BY_PIN.get((ref, pad), STUB_BY_REF.get(ref, LABEL_STUB)))

for (ref, pad) in NOCONN:
    if (ref, pad) in pin_xy:
        x, y = pin_xy[(ref, pad)]
        sch.noConnects.append(NoConnect(position=Position(x, y)))

# ---- functional-group outlines (dashed) + section titles ----
# Boxes only where a zone is spatially self-contained; wires/labels may cross the
# outline (signals leaving the group). The bell-sense and strap zones interleave
# with their neighbours' label fields, so they get a title without a box.
def group_box(x0, y0, x1, y1):
    sch.shapes.append(Rectangle(start=Position(x0, y0), end=Position(x1, y1),
                                stroke=Stroke(width=0.254, type="dash")))
def title(text, x, y):
    e = just("left"); e.font = Font(height=2.0, width=2.0, bold=True)
    sch.texts.append(Text(text=text, position=Position(x, y, 0), effects=e))

# Box edges are tidied to a common frame: the four top-row boxes share top=13,
# the two bottom-row boxes share bottom=252.5, RESET/BOOT and AUDIO share their
# left edge, and POWER LED matches POWER's 50x35 outline.
group_box(13.5, 13, 95.5, 95.5);    title("USB-C", 15, 16)
group_box(97.5, 13, 215, 95.5);     title("ESP32-C6 MCU", 99, 16)
group_box(217.5, 13, 267.5, 49);    title("POWER", 219, 16)
group_box(217.5, 51, 267.5, 86);    title("POWER LED", 219, 54)
group_box(272.5, 13, 365.5, 202.5); title("RELAY DRIVERS", 274, 16)
group_box(158.5, 139.5, 269.5, 252.5); title("AUDIO  ES8311 + LINE XFMR", 160, 142.5)
group_box(158.5, 99, 269.5, 131.5); title("RESET / BOOT", 160, 102)
group_box(13.5, 99, 156, 252.5);    title("BELL SENSE", 15, 102.5)

out = os.path.join(HERE, "doorbell.kicad_sch")
sch.to_file(out)
print("wrote", out, "| symbols:", len(sch.schematicSymbols), "| labels:", len(sch.labels),
      "| no-connects:", len(sch.noConnects))
