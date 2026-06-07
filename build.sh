#!/usr/bin/env bash
# Regenerate the doorbell design from code. One source of truth: kicad/doorbell_design.py
#
#   ./build.sh           schematic + PCB + route + fab   (full run)   [default = all-route]
#   ./build.sh sch       schematic only (+ ERC + PDF)
#   ./build.sh pcb       PCB only (placed + netted, unrouted)
#   ./build.sh route     autoroute the current PCB with Freerouting
#   ./build.sh fab       export Gerbers/drill/position + BOM to kicad/fab/
#   ./build.sh panel     KiKit 2x2 panel (rails+fiducials) + panel gerbers/BOM/CPL (after all-route)
#   ./build.sh all       schematic + PCB (unrouted) + ERC + schematic PDF
#   ./build.sh all-route schematic + PCB + route + fab   (full run)
set -euo pipefail
cd "$(dirname "$0")"

VENVPY="./.venv/bin/python"                       # kiutils lives here (schematic)
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"  # owns pcbnew
SCH="kicad/doorbell.kicad_sch"
PCB="kicad/doorbell.kicad_pcb"
KIKIT_SITE="$("$KPY" -m site --user-site 2>/dev/null)"   # KiKit (pip --user into KiCad's python)
KIKIT="$(dirname "$(dirname "$(dirname "$KIKIT_SITE")")")/bin/kikit"
NOISE='fontconfig|invalid attribute|invalid constant|assert|traits|wxApp|Analytics|New version'
q() { grep -vE "$NOISE" || true; }

sch() {
  echo "▶ schematic"
  "$VENVPY" kicad/gen_schematic.py
  kicad-cli sch erc "$SCH" -o /tmp/doorbell_erc.txt 2>&1 | q >/dev/null || true
  grep "ERC messages" /tmp/doorbell_erc.txt
  kicad-cli sch export pdf "$SCH" -o kicad/doorbell.pdf 2>&1 | q | tail -1
}
pcb() {
  echo "▶ pcb (unrouted)"
  "$KPY" kicad/gen_pcb.py 2>&1 | q
  check
}
check() {
  echo "▶ check placement constraints"
  "$KPY" kicad/check_pcb.py 2>&1 | q
}
route() {
  echo "▶ route (freerouting)"
  "$KPY" kicad/route.py 2>&1 | q
  kicad-cli pcb drc "$PCB" -o /tmp/doorbell_drc.txt 2>&1 | q | tail -1
  grep -iE "unconnected pads|DRC violations" /tmp/doorbell_drc.txt || true
}
fab() {
  echo "▶ fab outputs -> kicad/fab/"
  mkdir -p kicad/fab
  rm -f kicad/fab/*.gtl kicad/fab/*.gbl kicad/fab/*.gts kicad/fab/*.gbs \
        kicad/fab/*.gto kicad/fab/*.gbo kicad/fab/*.gtp kicad/fab/*.gbp \
        kicad/fab/*.g1 kicad/fab/*.g2 \
        kicad/fab/*.gm1 kicad/fab/*.gbr kicad/fab/*.gbrjob kicad/fab/*.drl kicad/fab/*.d356
  kicad-cli pcb export gerbers "$PCB" -o kicad/fab/ \
    --layers F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,F.Paste,B.Paste,Edge.Cuts 2>&1 | q | tail -1
  kicad-cli pcb export drill "$PCB" -o kicad/fab/ 2>&1 | q | tail -1
  kicad-cli pcb export ipcd356 "$PCB" -o kicad/fab/doorbell.d356 2>&1 | q | tail -1  # netlist for flying-probe E-test
  "$KPY" kicad/jlcpcb_cpl.py 2>&1 | q            # JLCPCB CPL (pad-centroid positions, from pcbnew)
  "$VENVPY" kicad/jlcpcb_files.py 2>&1 | q       # JLCPCB BOM (from schematic via kiutils)
  ( cd kicad/fab && rm -f doorbell-jlcpcb.zip &&
    zip -q doorbell-jlcpcb.zip *.gtl *.g1 *.g2 *.gbl *.gts *.gbs *.gto *.gbo *.gtp *.gbp *.gm1 *.drl *.d356 )
  echo "  -> upload to JLCPCB:  doorbell-jlcpcb.zip (gerbers + IPC-356 netlist)  +  doorbell-bom-jlcpcb.csv (BOM)  +  doorbell-cpl.csv (CPL)"
}

panel() {
  echo "▶ panel (KiKit 2x2 + assembly data) -> kicad/fab/panel/"
  mkdir -p kicad/fab/panel
  rm -f kicad/fab/doorbell-panel.kicad_pcb kicad/fab/doorbell-panel-*.csv \
        kicad/fab/doorbell-panel-jlcpcb.zip kicad/fab/panel/*
  # 1-up: a single board framed up to >=70x70 (JLCPCB Standard-PCBA minimum) so the order floors
  # at 5 panels = 5 boards. One CENTRED tab per edge clears the off-centre J1 / antenna; the 7 mm
  # frame gap is wider than the 5.3 mm antenna overhang. (Bump rows/cols for more boards per panel.)
  PYTHONPATH="$KIKIT_SITE" "$KPY" "$KIKIT" panelize \
    --layout 'grid; rows: 1; cols: 1' \
    --tabs 'fixed; hcount: 1; vcount: 1; hwidth: 3mm; vwidth: 3mm' \
    --cuts 'mousebites; drill: 0.5mm; spacing: 0.8mm; offset: 0.25mm' \
    --framing 'frame; width: 5mm; space: 7mm; mintotalwidth: 70mm; mintotalheight: 70mm' \
    --fiducials '3fid; hoffset: 10mm; voffset: 2.5mm' \
    --tooling '3hole; hoffset: 5mm; voffset: 2.5mm; size: 1.5mm' \
    --post 'millradius: 1mm' \
    "$PCB" kicad/fab/doorbell-panel.kicad_pcb 2>&1 | q | tail -1
  kicad-cli pcb export gerbers kicad/fab/doorbell-panel.kicad_pcb -o kicad/fab/panel/ \
    --layers F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,F.Paste,B.Paste,Edge.Cuts 2>&1 | q | tail -1
  kicad-cli pcb export drill kicad/fab/doorbell-panel.kicad_pcb -o kicad/fab/panel/ 2>&1 | q | tail -1
  "$VENVPY" kicad/jlcpcb_files.py 2>&1 | q       # refresh single-board BOM (panel BOM derives from it)
  "$KPY" kicad/panel_cpl.py 2>&1 | q             # panel CPL: unique per-instance refs, from the panel
  "$VENVPY" kicad/panel_bom.py 2>&1 | q          # panel BOM: expand single-board BOM to panel refs
  ( cd kicad/fab/panel && rm -f ../doorbell-panel-jlcpcb.zip &&
    zip -q ../doorbell-panel-jlcpcb.zip *.gtl *.g1 *.g2 *.gbl *.gts *.gbs *.gto *.gbo *.gtp *.gbp *.gm1 *.drl )
  echo "  -> panelised assembly order:  doorbell-panel-jlcpcb.zip + doorbell-panel-bom.csv + doorbell-panel-cpl.csv"
  echo "     (run AFTER ./build.sh all-route; it panelises the routed board)"
}

case "${1:-all-route}" in
  sch)        sch ;;
  pcb)        pcb ;;
  check)      check ;;
  route)      route ;;
  fab)        fab ;;
  panel)      panel ;;
  all)        sch; pcb ;;
  all-route)  sch; pcb; route; fab ;;
  *) echo "usage: $0 {sch|pcb|check|route|fab|panel|all|all-route}"; exit 1 ;;
esac
echo "✓ done"
