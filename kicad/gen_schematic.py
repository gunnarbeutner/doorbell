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
VALUE_DY = {"U2": 3.81, "OC1": 3.81, "OC2": 3.81, "J2": 6.35}
# Refs whose ref/value should stack to the right of the body (clear of pins),
# mapped to the horizontal offset in mm.  Vertical passives get this automatically.
RIGHT_TEXT = {"Q1": 3.81, "Q2": 3.81}

# ---- placement: GRID (units of 2.54mm) from the shared design module ----
# Schematic-only position overrides (grid units). GRID stays untouched so the PCB
# generator keeps its clusters; here we re-lay the relay drivers for clean wiring.
G = 2.54
SCHEM_POS = {
    # relay driver 1 (upper right): gate R + pulldown stacked on the FET gate,
    # FET drain wired across to the coil with the flyback diode on the node.
    "R_g1": (104, 26), "Q1": (106, 31), "R_pd1": (104, 36), "D1": (110, 30.5), "K1": (119, 31),
    "R_ot": (127, 37),   # ÖT bridge series R, below-right of K1's contacts

    # relay driver 2 (lower right): same layout shifted down.
    "R_g2": (104, 60), "Q2": (106, 65), "R_pd2": (104, 70), "D2": (110, 64.5), "K2": (119, 65),
    # relay driver 3 (K3 PTT placeholder): same layout, third row.
    "R_g3": (104, 94), "Q3": (106, 99), "R_pd3": (104, 104), "D3": (110, 98.5), "K3": (119, 99),
    # de-crowd the EN/BOOT reset network between the decoupling caps and the MCU.
    "C_dec": (54, 24), "SW_en": (58, 32), "R_en": (62, 28), "C_en": (62, 34),
    "SW_boot": (58, 66), "R_boot": (62, 64),
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
    if rx_off is not None:
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
def place_power(entry, x, y, outdir=90):
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
    ss.properties = [
        Property(key="Reference", value=ref, position=Position(x, y, 0), effects=mk_hidden()),
        Property(key="Value", value=entry,
                 position=Position(x + dx * 4.5, y + dy * 4.5, 0),
                 effects=just(None if dx == 0 else ("left" if dx > 0 else "right"))),
    ]
    ss.pins = {"1": U()}
    ss.instances = [SymbolProjectInstance(name=PROJECT,
                    paths=[SymbolProjectPath(sheetInstancePath="/"+ROOT, reference=ref, unit=1)])]
    sch.schematicSymbols.append(ss)

def add_label(net, x, y, outdir):
    sch.labels.append(LocalLabel(text=net, position=Position(x, y, outdir)))

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
WIRED_NETS.update(("K1_DRAIN", "GATE2", "K2_DRAIN"))
wire_relay_driver("R_g1", "Q1", "R_pd1", "D1", "K1", wire_gate=False)
wire_relay_driver("R_g2", "Q2", "R_pd2", "D2", "K2")

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
        if net in POWER_SYMS:
            place_power(POWER_SYMS[net], x, y, outdir)
        else:
            add_label(net, x, y, outdir)

for (ref, pad) in NOCONN:
    if (ref, pad) in pin_xy:
        x, y = pin_xy[(ref, pad)]
        sch.noConnects.append(NoConnect(position=Position(x, y)))

out = os.path.join(HERE, "doorbell.kicad_sch")
sch.to_file(out)
print("wrote", out, "| symbols:", len(sch.schematicSymbols), "| labels:", len(sch.labels),
      "| no-connects:", len(sch.noConnects))
