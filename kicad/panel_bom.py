#!/usr/bin/env python3
"""JLCPCB BOM for the KiKit panel.

Reuses the verified single-board BOM (doorbell-bom-jlcpcb.csv -- correct values/footprints/LCSC)
and expands each row's designators to the panel's per-instance refs taken from the panel CPL
(doorbell-panel-cpl.csv). Building the BOM FROM the CPL guarantees the two files use exactly the
same designator set, which JLCPCB requires. Pure python -- no pcbnew/kiutils needed.
"""
import csv, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
FAB = os.path.join(HERE, "fab")
SB = os.path.join(FAB, "doorbell-bom-jlcpcb.csv")        # single-board BOM (source of truth)
CPL = os.path.join(FAB, "doorbell-panel-cpl.csv")        # panel CPL (actual panel designators)
OUT = os.path.join(FAB, "doorbell-panel-bom.csv")


def base(ref):
    return re.sub(r"-\d+$", "", ref)                     # SW1-3 -> SW1


# panel designators grouped by their base refdes
by_base = {}
with open(CPL) as f:
    rd = csv.reader(f)
    next(rd)
    for row in rd:
        by_base.setdefault(base(row[0]), []).append(row[0])

with open(SB) as f, open(OUT, "w", newline="") as o:
    rd = csv.reader(f)
    w = csv.writer(o)
    w.writerow(next(rd))                                 # header
    n = 0
    for comment, desig, fp, lcsc in rd:
        panel = [d for sb_ref in desig.split(",") for d in sorted(by_base.get(sb_ref, []))]
        w.writerow([comment, ",".join(panel), fp, lcsc])
        n += 1
print(f"  panel BOM: {n} lines -> doorbell-panel-bom.csv")
