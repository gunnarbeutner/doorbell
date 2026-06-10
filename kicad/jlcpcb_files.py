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
from doorbell_design import REF, LCSC as DESIGN_LCSC

HERE = os.path.dirname(os.path.abspath(__file__))
FAB = os.path.join(HERE, "fab")
SCH = os.path.join(HERE, "doorbell.kicad_sch")

HANDSOLDER = set()                 # parts hand-soldered after SMT assembly (excluded)
# LCSC part numbers keyed by reference -- supplies a part # for symbols that carry no "LCSC"
# field, and OVERRIDES the schematic's LCSC field (e.g. to swap an out-of-stock part).
# Sourced from doorbell_design.LCSC (the same dict gen_schematic.py embeds in the schematic).
EXTRA_LCSC = {REF[key]: cnum for key, cnum in DESIGN_LCSC.items()}

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
