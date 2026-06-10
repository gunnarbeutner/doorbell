#!/usr/bin/env python3
"""Generate kicad/doorbell.kicad_sch (V4 core board) with kiutils.

Circuit data (components, nets, footprints, placement grid) lives in
`doorbell_design.py`; this file only turns it into a schematic. Connectivity is by
local labels placed exactly on each pin endpoint (abs = inst + (pinX, -pinY) for an
unrotated symbol); power rails use power-port symbols. Validate with:
    kicad-cli sch erc kicad/doorbell.kicad_sch
"""
import copy, re, uuid, os
from kiutils.schematic import Schematic, SchematicSymbol
from kiutils.symbol import SymbolLib
from kiutils.items.schitems import (LocalLabel, NoConnect, SymbolProjectInstance,
                                    SymbolProjectPath, Connection, Junction)
from kiutils.items.common import Position, Property, Effects, Stroke, Justify
from doorbell_design import REF, COMP, FP_OVERRIDE, NETS, NOCONN, GRID

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
    "ES8311": f"{HERE}/lib_audio/ES8311.kicad_sym",   # ES8311 mono codec (easyeda2kicad import)
    "SM_LP_5001": f"{HERE}/lib_audio/SM_LP_5001.kicad_sym",   # Bourns SM-LP-5001 (easyeda2kicad import)
    "cas220tb1": f"{HERE}/lib_switches/cas220tb1.kicad_sym",   # NIDEC CAS-220TB1 DPDT slide switch
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
def mk_hidden():
    e = Effects(); e.hide = True; return e
def just(h=None, v=None):
    e = Effects()
    if h or v: e.justify = Justify(horizontally=h, vertically=v)
    return e

# Per-component value-text vertical nudge (mm, +down) for small parts whose
# default below-body value would collide with a pin row.
VALUE_DY = {"OC1": 3.81, "OC2": 3.81, "OC3": 3.81, "J2": 6.35}
# Refs whose ref/value should stack to the right of the body (clear of pins),
# mapped to the horizontal offset in mm.  Vertical passives get this automatically.
RIGHT_TEXT = {"Q1": 3.81, "Q2": 3.81, "Q3": 3.81}
# Refs whose ref/value stack ABOVE the body (below is blocked by the GND pin/port).
TEXT_ABOVE = {"U2"}

# ---- placement: GRID (units of 2.54mm) from the shared design module ----
# Schematic-only position overrides (grid units). GRID stays untouched so the PCB
# generator keeps its clusters; the schematic re-lays everything for legibility.
# Spacing is derived from symbol bboxes + label text length (~1.27mm/char + stub),
# so labels clear neighbouring symbols.  Functional zones:
#   top-left    USB-C + ESD           top-mid     LDO + rail caps + power LED
#   centre      ESP32 + straps        right       three relay-driver rows
#   bottom-left J2 + opto sense rows  bottom-mid  ES8311 codec + transformer
G = 2.54
SCHEM_POS = {
    # --- USB-C: ESD array left of J1, CC terminators below, VBUS Schottky right ---
    "J1": (18, 20), "D_esd": (8, 20), "R_cc1": (28, 32), "R_cc2": (32, 32),
    "D_vbus": (32, 12), "FLAG5": (37, 12),
    # --- LDO + rail caps in one row (incl. the ES8311 supply decouplers) ---
    "U2": (44, 18), "FLAG3": (52, 12), "FLAGG": (32, 36),
    "C_in": (38, 30), "C_out": (43, 30), "C_3v3": (48, 30), "C_dec": (53, 30),
    "C_dv": (58, 30), "C_pv": (63, 30), "C_av": (68, 30), "C_avb": (73, 30),
    "R_led": (84, 14), "LED1": (84, 20),
    # --- MCU straps: EN/BOOT RC + buttons left of U1, GPIO8 pull-up below ---
    "R_en": (60, 48), "SW_en": (54, 52), "C_en": (60, 58),
    "R_boot": (70, 68), "SW_boot": (54, 72), "R_io8": (76, 76),
    # --- relay drivers, three rows right of the MCU ---
    # row 1 (K1, PTT): gate net split by the K3 interlock -> R_g1/R_pd1 carry the
    # GATE1_PRE/GATE1 labels, so this row gets extra vertical room for the label text.
    "R_g1": (112, 14), "Q1": (114, 23), "R_pd1": (112, 30), "D1": (118, 22.5), "K1": (130, 23),
    # rows 2 (K2, door opener) and 3 (K3, chime suppress): gate trunk wired directly.
    "R_g2": (112, 42), "Q2": (114, 47), "R_pd2": (112, 52), "D2": (118, 46.5), "K2": (130, 47),
    "R_g3": (112, 66), "Q3": (114, 71), "R_pd3": (112, 76), "D3": (118, 70.5), "K3": (130, 71),
    "R_ot": (139, 42),   # ÖT bridge series R, right of K2's contacts
    # --- bell-sense rows: J2 | clamp diode | polarity switch | opto | limiter ---
    "J2": (14, 84),
    "D_oc2": (24, 64), "SW_OC2": (32, 64), "OC2": (46, 64), "R_lim1": (58, 64),
    "D_oc3": (24, 84), "SW_OC3": (32, 84), "OC3": (46, 84), "R_lim2": (58, 84),
    "D_oc1": (24, 104), "SW_OC1": (32, 104), "OC1": (46, 104), "R_lim3": (58, 104),
    "R_em": (64, 104),
    # --- audio codec: I2C pull-ups above U3, xfmr + coupling caps below,
    #     VREF reservoirs left of the xfmr (clear of the title block) ---
    "R_sda": (84, 72), "R_scl": (90, 72), "R_ce": (96, 72),
    "U3": (96, 86), "T1": (89, 106),
    "C_op": (98, 104), "C_on": (103, 104), "C_mp": (108, 104), "C_mn": (113, 104),
    "C_vref": (68, 100), "C_vmid": (74, 100), "C_aref": (80, 100),
}
GRID2 = dict(GRID); GRID2.update(SCHEM_POS)
POS = {ref: (gx * G, gy * G) for ref, (gx, gy) in GRID2.items()}

# ---- build ----
sch = Schematic.create_new()
sch.version = "20250114"
sch.paper.paperSize = "A3"
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
        cs = copy.deepcopy(sym); cs.libId = libid
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
    inst = SchematicSymbol(libraryNickname=nick, entryName=entry,
                           position=Position(ox, oy, 0), unit=unit, uuid=U())
    designator = REF[ref]
    symprops = {p.key: p.value for p in sym.properties}
    fp = FP_OVERRIDE.get(ref, symprops.get("Footprint", ""))
    # Text placement: vertical 2-pin passives get ref/value stacked to the right
    # (clear of the top/bottom pins); other parts keep ref-above / value-below.
    allp = [(round(p.position.X, 2), round(p.position.Y, 2)) for u in sym.units for p in u.pins]
    is_vpassive = len(allp) == 2 and len({x for x, _ in allp}) == 1
    hide_ref = designator.startswith("#")
    rx_off = 1.78 if is_vpassive else RIGHT_TEXT.get(ref)
    if ref in TEXT_ABOVE:
        body_top = oy - max((p.position.Y for u in sym.units for p in u.pins), default=0)
        ref_prop = Property(key="Reference", value=designator,
                            position=Position(ox, body_top - 7.62, 0))
        val_prop = Property(key="Value", value=value,
                            position=Position(ox, body_top - 5.08, 0))
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
    if symprops.get("LCSC"):
        inst.properties.append(Property(key="LCSC", value=symprops["LCSC"],
                               position=Position(ox, oy, 0), effects=mk_hidden()))
    inst.pins = {p.number: U() for u in sym.units for p in u.pins}
    inst.instances = [SymbolProjectInstance(name=PROJECT,
                      paths=[SymbolProjectPath(sheetInstancePath="/"+ROOT, reference=designator, unit=unit)])]
    sch.schematicSymbols.append(inst)
    for pad in set(pads):
        try:
            px, py, _ = pin_pos(sym, pad)
        except KeyError:
            continue   # footprint-only NC pad (e.g. ES8388 pads 9/25): covered on the PCB by NOCONN
        pin_xy[(ref, pad)] = (ox + px, oy - py)
        pin_ang[(ref, pad)] = pin_angle_of(sym, pad)

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
        cs = copy.deepcopy(get_symbol("power", entry)); cs.libId = libid
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
STUB_BY_REF = {"U1": 5.08, "U3": 5.08}   # big ICs: pin numbers need more clearance
# Power pins rendered as a plain net label instead of a power port: U3's supplies sit
# between signal pins at 2.54 pitch, where rotated port graphics overlap everything.
POWER_AS_LABEL = {("U3", "3"), ("U3", "4"), ("U3", "5"), ("U3", "10"),
                  ("U3", "11"), ("U3", "21")}
def add_label(net, x, y, outdir, stub=LABEL_STUB):
    dx, dy = DIR_DELTA[outdir]
    lx, ly = x + dx * stub, y + dy * stub
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
# K1 gate is split into GATE1_PRE (R_g1 side) and GATE1 (Q1/R_pd1 side) by the K3 interlock;
# auto-labels handle both sub-nets — neither goes into WIRED_NETS.
WIRED_NETS.update(("K1_DRAIN", "GATE2", "K2_DRAIN", "GATE3", "K3_DRAIN"))
wire_relay_driver("R_g1", "Q1", "R_pd1", "D1", "K1", wire_gate=False)
wire_relay_driver("R_g2", "Q2", "R_pd2", "D2", "K2")
wire_relay_driver("R_g3", "Q3", "R_pd3", "D3", "K3")

# ---- power LED: series resistor straight down into the LED (one wire) ----
WIRED_NETS.add("LED_A")
wire(PX("R_led", "2"), PX("LED1", "2"))

sch.libSymbols = lib_symbols

for net, pins in NETS.items():
    if net in WIRED_NETS:
        continue
    for (ref, pad) in pins:
        if (ref, pad) not in pin_xy:
            print("WARN missing pin", ref, pad); continue
        x, y = pin_xy[(ref, pad)]
        outdir = outward_dir(ref, pad)
        if net in POWER_SYMS and (ref, pad) not in POWER_AS_LABEL:
            place_power(POWER_SYMS[net], x, y, outdir)
        else:
            add_label(net, x, y, outdir, stub=STUB_BY_REF.get(ref, LABEL_STUB))

for (ref, pad) in NOCONN:
    if (ref, pad) in pin_xy:
        x, y = pin_xy[(ref, pad)]
        sch.noConnects.append(NoConnect(position=Position(x, y)))

out = os.path.join(HERE, "doorbell.kicad_sch")
sch.to_file(out)
print("wrote", out, "| symbols:", len(sch.schematicSymbols), "| labels:", len(sch.labels),
      "| no-connects:", len(sch.noConnects))
