#!/usr/bin/env python3
"""One-shot bootstrap for wf26/wf26.kicad_sch (reverse-engineered STR WF26 intercom).

This places the confirmed component inventory on an A3 sheet with NO speculative
wiring (the only net-labels are the factual BUS1..BUS5 on the screw connector). The
resulting .kicad_sch is the SOURCE OF TRUTH from here on -- edit it in KiCad / by
hand to add the traces. This script is a throwaway scaffold, not a generator to
maintain. Run once with the venv python (kiutils):  .venv/bin/python wf26/make_wf26.py
"""
import copy, re, uuid, os
from kiutils.schematic import Schematic, SchematicSymbol
from kiutils.symbol import SymbolLib
from kiutils.items.schitems import (LocalLabel, SymbolProjectInstance,
                                    SymbolProjectPath)
from kiutils.items.common import Position, Property, Effects, Justify

HERE = os.path.dirname(os.path.abspath(__file__))
KS = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols"
LIB = {
    "Device": f"{KS}/Device.kicad_sym",
    "Switch": f"{KS}/Switch.kicad_sym",
    "Connector_Generic": f"{KS}/Connector_Generic.kicad_sym",
    "wf26": f"{HERE}/sym/wf26.kicad_sym",
}
_cache = {}
def load_lib(n):
    if n not in _cache: _cache[n] = SymbolLib.from_file(LIB[n])
    return _cache[n]
def get_symbol(n, e):
    for s in load_lib(n).symbols:
        if s.entryName == e: return s
    raise KeyError(f"{n}:{e}")
def U(): return str(uuid.uuid4())
def mk_hidden():
    e = Effects(); e.hide = True; return e
def just(h=None):
    e = Effects()
    if h: e.justify = Justify(horizontally=h)
    return e

# ref -> (lib, entry, value, [(unit, x_mm, y_mm), ...])
# A single-unit part has one placement tuple; SW_DPDT_x2 has two (pole A / pole B).
COMP = {
    "LS1": ("Device", "Speaker", "Speaker/Mic 16R", [(1, 50.8, 38.1)]),
    "S2":  ("Switch", "SW_DPDT_x2", "Sprechen/Hoeren (talk)", [(1, 88.9, 45.72), (2, 88.9, 63.5)]),
    "R1":  ("Device", "R", "2.2k", [(1, 60.96, 93.98)]),
    "C1":  ("Device", "C_Polarized", "22uF/50V", [(1, 78.74, 93.98)]),
    "K1":  ("wf26", "HJR-4102-N-12V", "HJR-4102-N-12V", [(1, 139.7, 55.88)]),
    "S1":  ("Switch", "SW_DPDT_x2", "Tueroeffner (door release)", [(1, 139.7, 99.06), (2, 139.7, 116.84)]),
    "J1":  ("Connector_Generic", "Conn_01x05", "WF26 -> TV20 S bus", [(1, 193.04, 48.26)]),
}

# Factual anchors only: label each connector pin with its bus-wire number.
BUS_LABELS = {"J1": {"1": "BUS1", "2": "BUS2", "3": "BUS3", "4": "BUS4", "5": "BUS5"}}

sch = Schematic.create_new()
sch.version = "20250114"
sch.paper.paperSize = "A3"
sch.uuid = U()
ROOT = sch.uuid
PROJECT = "wf26"

lib_symbols, used = [], set()
pin_xy, pin_ang = {}, {}

for ref, (nick, entry, value, placements) in COMP.items():
    sym = get_symbol(nick, entry)
    libid = f"{nick}:{entry}"
    if libid not in used:
        cs = copy.deepcopy(sym); cs.libId = libid
        lib_symbols.append(cs); used.add(libid)
    # kiutils flattens unit names, so identify units by pin-bearing order:
    # the i-th unit that carries pins is KiCad unit i (1-based).
    pin_units = [u for u in sym.units if u.pins]
    for (unit, ox, oy) in placements:
        inst = SchematicSymbol(libraryNickname=nick, entryName=entry,
                               position=Position(ox, oy, 0), unit=unit, uuid=U())
        inst.properties = [
            Property(key="Reference", value=ref, position=Position(ox + 8.89, oy - 2.54, 0), effects=just("left")),
            Property(key="Value", value=value, position=Position(ox + 8.89, oy + 2.54, 0), effects=just("left")),
        ]
        # pins that belong to THIS unit
        unit_pins = list(pin_units[unit - 1].pins)
        inst.pins = {p.number: U() for p in unit_pins}
        inst.instances = [SymbolProjectInstance(name=PROJECT,
                          paths=[SymbolProjectPath(sheetInstancePath="/"+ROOT, reference=ref, unit=unit)])]
        sch.schematicSymbols.append(inst)
        for p in unit_pins:
            pin_xy[(ref, p.number)] = (ox + p.position.X, oy - p.position.Y)
            pin_ang[(ref, p.number)] = p.position.angle or 0

sch.libSymbols = lib_symbols

# Place the factual bus labels on the connector pins.
def outward(ref, pad): return ((pin_ang.get((ref, pad), 0)) + 180) % 360
for ref, mapping in BUS_LABELS.items():
    for pad, net in mapping.items():
        if (ref, pad) in pin_xy:
            x, y = pin_xy[(ref, pad)]
            sch.labels.append(LocalLabel(text=net, position=Position(x, y, outward(ref, pad))))

out = os.path.join(HERE, "wf26.kicad_sch")
sch.to_file(out)
print("wrote", out, "| symbols:", len(sch.schematicSymbols), "| labels:", len(sch.labels))
