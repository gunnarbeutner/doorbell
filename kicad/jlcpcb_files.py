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
              "K1": "C397193",     # Omron G6K-2F-Y-TR DC4.5 DPDT relay (4.5V coil; must-operate 3.6V, more VBUS-sag margin)
              "K2": "C397193",
              "K3": "C397193",     # virtual-PTT relay, same G6K-2F-Y-TR DC4.5
              "U1": "C5366877",    # ESP32-C6-WROOM-1-N8 (8MB, PCB antenna)
              "U2": "C3294699",    # SGM2212-3.3 low-dropout LDO (overrides the AMS1117 symbol's LCSC)
              "U3": "C962342",     # ES8311 mono audio codec (QFN-20)
              "T1": "C7503474",    # Bourns SM-LP-5001 600:600 audio isolation transformer
              "SW3": "C2921541",   # NIDEC CAS-220TB1 DPDT slide switch
              "SW4": "C2921541",
              "SW5": "C2921541"}

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


# Group by LCSC part #: JLCPCB wants ONE row per part number (same part on two rows is rejected).
# Parts with no LCSC fall back to (value, footprint) so they still de-dupe sensibly.
groups = OrderedDict()   # key -> [comment, footprint, lcsc, [refs...]]
for ref in sorted(comp, key=_key):
    val, fp, lcsc = comp[ref]
    groups.setdefault(lcsc or (val, fp), [val, fp, lcsc, []])[3].append(ref)

missing, nparts = [], 0
with open(os.path.join(FAB, "doorbell-bom-jlcpcb.csv"), "w", newline="") as o:
    w = csv.writer(o)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for val, fp, lcsc, refs in groups.values():
        w.writerow([val, ",".join(refs), fp, lcsc])
        nparts += len(refs)
        if not lcsc:
            missing.append(",".join(refs))
print(f"  BOM: {len(groups)} lines ({nparts} parts) -> doorbell-bom-jlcpcb.csv")
if missing:
    print(f"  WARN: no LCSC part # for: {'; '.join(missing)}")
