#!/usr/bin/env python3
"""JLCPCB BOM from the schematic (kiutils).

kicad-cli's BOM export comes up empty for this generated schematic, so the BOM is read straight
from the schematic symbols -- which carry the JLCPCB-library "LCSC" part numbers. Writes
doorbell-bom-jlcpcb.csv (Comment, Designator, Footprint, LCSC Part #). The CPL is produced
separately by jlcpcb_cpl.py. Run with the venv python (owns kiutils); see build.sh.
"""
import csv, os, re
from collections import OrderedDict
from kiutils.schematic import Schematic

HERE = os.path.dirname(os.path.abspath(__file__))
FAB = os.path.join(HERE, "fab")
SCH = os.path.join(HERE, "doorbell.kicad_sch")

HANDSOLDER = set()                 # parts hand-soldered after SMT assembly (excluded)
# LCSC part numbers keyed by reference -- supplies a part # for symbols that carry no "LCSC"
# field, and OVERRIDES the schematic's LCSC field (e.g. to swap an out-of-stock part).
EXTRA_LCSC = {"J1": "C7095263",    # GCT USB4085 USB-C receptacle (THT)
              "J2": "C5290323",    # DORABO DB125-3.5-6P-GN-S screw terminal (THT)
              "K1": "C2982926",    # Omron G6K-2F-Y-5V DPDT signal relay
              "K2": "C2982926",
              "U1": "C2838502",    # ESP32-C3-MINI-1-N4 (4MB, PCB antenna)
              "U2": "C3294699"}    # SGM2212-3.3 low-dropout LDO (overrides the AMS1117 symbol's LCSC)

sch = Schematic.from_file(SCH)
comp = OrderedDict()   # ref -> (value, footprint, lcsc); de-dupes multi-unit symbols
for sym in sch.schematicSymbols:
    if getattr(sym, "dnp", False):
        continue
    p = {x.key: x.value for x in sym.properties}
    ref = (p.get("Reference") or "").strip()
    if not ref or ref.startswith("#") or ref in HANDSOLDER:
        continue
    lcsc = EXTRA_LCSC.get(ref) or (p.get("LCSC") or "").strip()
    comp[ref] = (p.get("Value", ""), p.get("Footprint", ""), lcsc)


def _key(r):
    m = re.match(r"([A-Za-z_]+)(\d+)", r)
    return (m.group(1), int(m.group(2))) if m else (r, 0)


groups = OrderedDict()
for ref in sorted(comp, key=_key):
    val, fp, lcsc = comp[ref]
    groups.setdefault((val, fp, lcsc), []).append(ref)

missing = []
with open(os.path.join(FAB, "doorbell-bom-jlcpcb.csv"), "w", newline="") as o:
    w = csv.writer(o)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for (val, fp, lcsc), refs in groups.items():
        w.writerow([val, ",".join(refs), fp, lcsc])
        if not lcsc:
            missing.append(",".join(refs))
print(f"  BOM: {len(groups)} lines ({sum(len(r) for r in groups.values())} parts) -> doorbell-bom-jlcpcb.csv")
if missing:
    print(f"  WARN: no LCSC part # for: {'; '.join(missing)}")
