#!/usr/bin/env python3
"""JLCPCB BOM from the schematic (kiutils).

kicad-cli's BOM export comes up empty for this generated schematic, so the BOM is read straight
from the schematic symbols -- which carry the JLCPCB-library "LCSC" part numbers. Writes
doorbell-bom-jlcpcb.csv (Comment, Designator, Footprint, LCSC Part #). The CPL is produced
separately by jlcpcb_cpl.py. Run with the venv python (owns kiutils); see build.sh.
"""
import csv, os, re, sys
from collections import OrderedDict
from kiutils.schematic import Schematic

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FAB = os.path.join(ROOT, "fab")
SCH = os.path.join(ROOT, "kicad", "doorbell.kicad_sch")

HANDSOLDER = set()                 # parts hand-soldered after SMT assembly (excluded)

sch = Schematic.from_file(SCH)
comp = OrderedDict()   # ref -> (value, footprint, lcsc); de-dupes multi-unit symbols
for sym in sch.schematicSymbols:
    if getattr(sym, "dnp", False) or not getattr(sym, "inBom", True):
        continue   # skip DNP and "exclude from BOM" parts (e.g. test points)
    p = {x.key: x.value for x in sym.properties}
    ref = (p.get("Reference") or "").strip()
    if not ref or ref.startswith("#") or ref in HANDSOLDER:
        continue
    lcsc = (p.get("LCSC") or "").strip()
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
    sys.exit(f"ERROR: no LCSC part # for: {'; '.join(missing)} "
             "- set the symbol's LCSC field in KiCad (or add the ref to HANDSOLDER if it is not assembled)")

# JLCPCB rejects an upload when the BOM and CPL designator sets differ. The CPL is generated first
# by build.sh, so catch inconsistent KiCad BOM/position attributes here instead of at order time.
cpl_path = os.path.join(FAB, "doorbell-cpl.csv")
if os.path.exists(cpl_path):
    with open(cpl_path, newline="") as f:
        cpl_refs = {row["Designator"] for row in csv.DictReader(f)}
    bom_refs = set(comp)
    cpl_only = sorted(cpl_refs - bom_refs, key=_key)
    bom_only = sorted(bom_refs - cpl_refs, key=_key)
    if cpl_only or bom_only:
        details = []
        if cpl_only:
            details.append("CPL only: " + ",".join(cpl_only))
        if bom_only:
            details.append("BOM only: " + ",".join(bom_only))
        sys.exit("ERROR: BOM/CPL designator mismatch (" + "; ".join(details) + ")")
