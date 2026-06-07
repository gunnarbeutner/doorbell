#!/usr/bin/env bash
# Regenerate the doorbell design from code. One source of truth: kicad/doorbell_design.py
#
#   ./build.sh           schematic + PCB + route + fab   (full run)   [default = all-route]
#   ./build.sh sch       schematic only (+ ERC + PDF)
#   ./build.sh pcb       PCB only (placed + netted, unrouted)
#   ./build.sh route     autoroute the current PCB with Freerouting
#   ./build.sh fab       export Gerbers/drill/position + BOM to kicad/fab/
#   ./build.sh all       schematic + PCB (unrouted) + ERC + schematic PDF
#   ./build.sh all-route schematic + PCB + route + fab   (full run)
set -euo pipefail
cd "$(dirname "$0")"

VENVPY="./.venv/bin/python"                       # kiutils lives here (schematic)
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"  # owns pcbnew
SCH="kicad/doorbell.kicad_sch"
PCB="kicad/doorbell.kicad_pcb"
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
        kicad/fab/*.gm1 kicad/fab/*.gbr kicad/fab/*.gbrjob kicad/fab/*.drl
  kicad-cli pcb export gerbers "$PCB" -o kicad/fab/ \
    --layers F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,F.Paste,B.Paste,Edge.Cuts 2>&1 | q | tail -1
  kicad-cli pcb export drill "$PCB" -o kicad/fab/ 2>&1 | q | tail -1
  kicad-cli pcb export pos   "$PCB" -o kicad/fab/doorbell-pos.csv --format csv --units mm 2>&1 | q | tail -1
  kicad-cli sch export bom   "$SCH" -o kicad/fab/doorbell-bom.csv 2>&1 | q | tail -1
  ( cd kicad/fab && rm -f doorbell-jlcpcb.zip &&
    zip -q doorbell-jlcpcb.zip *.gtl *.gbl *.gts *.gbs *.gto *.gbo *.gtp *.gbp *.gm1 *.drl )
  echo "  -> kicad/fab/doorbell-jlcpcb.zip   (this is the file you upload to JLCPCB)"
}

case "${1:-all-route}" in
  sch)        sch ;;
  pcb)        pcb ;;
  check)      check ;;
  route)      route ;;
  fab)        fab ;;
  all)        sch; pcb ;;
  all-route)  sch; pcb; route; fab ;;
  *) echo "usage: $0 {sch|pcb|check|route|fab|all|all-route}"; exit 1 ;;
esac
echo "✓ done"
