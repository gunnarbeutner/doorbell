#!/usr/bin/env bash
# Verify + package the doorbell design. The KiCad files
# (kicad/doorbell.kicad_sch / kicad/doorbell.kicad_pcb) are the AUTHORITATIVE
# source — edit them in KiCad. This script never authors copper; it runs the
# checks KiCad's own DRC/ERC can't express and exports the fab outputs.
#
#   ./build.sh           verify + fab            (full run)   [default = all-route]
#   ./build.sh sch       schematic ERC (+ PDF export)
#   ./build.sh check     PCB placement constraints (check_pcb.py)
#   ./build.sh route     verify planes/thieving/connectivity (route.py) + DRC
#   ./build.sh sim       run the sim/ circuit-simulator unit tests
#   ./build.sh fab       export Gerbers/drill/position + BOM to kicad/fab/
#   ./build.sh all       sch + check + route + sim   (all checks, no fab)
#   ./build.sh all-route sch + check + route + sim + fab   (full run)
set -euo pipefail
cd "$(dirname "$0")"

VENVPY="./.venv/bin/python"                       # kiutils lives here (BOM)
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"  # owns pcbnew
SCH="kicad/doorbell.kicad_sch"
PCB="kicad/doorbell.kicad_pcb"
NOISE='fontconfig|invalid attribute|invalid constant|assert|traits|wxApp|Analytics|New version'
q() { grep -vE "$NOISE" || true; }

sch() {
  echo "▶ schematic ERC"
  kicad-cli sch erc "$SCH" -o /tmp/doorbell_erc.txt 2>&1 | q >/dev/null || true
  grep "ERC messages" /tmp/doorbell_erc.txt
  kicad-cli sch export pdf "$SCH" -o kicad/doorbell.pdf 2>&1 | q | tail -1
}
check() {
  echo "▶ check placement constraints"
  "$KPY" kicad/check_pcb.py 2>&1 | q
}
route() {
  echo "▶ verify planes/thieving/connectivity + DRC"
  "$KPY" kicad/route.py 2>&1 | q
  kicad-cli pcb drc "$PCB" -o /tmp/doorbell_drc.txt 2>&1 | q | tail -1
  grep -iE "unconnected pads|DRC violations" /tmp/doorbell_drc.txt || true
}
sim() {
  echo "▶ sim unit tests"
  ( cd sim && node --test )
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

case "${1:-all-route}" in
  sch)        sch ;;
  check)      check ;;
  route)      route ;;
  sim)        sim ;;
  fab)        fab ;;
  all)        sch; check; route; sim ;;
  all-route)  sch; check; route; sim; fab ;;
  *) echo "usage: $0 {sch|check|route|sim|fab|all|all-route}"; exit 1 ;;
esac
echo "✓ done"
