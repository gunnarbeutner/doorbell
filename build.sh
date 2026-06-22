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
#   ./build.sh step      export STEP 3D model to kicad/fab/ (omits STEP_Exclude parts)
#   ./build.sh all       sch + check + route + sim   (all checks, no fab)
#   ./build.sh all-route sch + check + route + sim + fab + step   (full run)
set -euo pipefail
cd "$(dirname "$0")"

VENVPY="./.venv/bin/python"                       # kiutils lives here (BOM)
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"  # owns pcbnew
SCH="kicad/doorbell.kicad_sch"
PCB="kicad/doorbell.kicad_pcb"
NOISE='fontconfig|invalid attribute|invalid constant|assert|traits|wxApp|Analytics|New version|Error retrieving source file attributes|NSCocoaErrorDomain'
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
report_unrouted() {
  # Pinpoint route.py's "unrouted connection(s)" by pad/position, via the DRC
  # engine's unconnected-items report. kicad-cli does NOT refill zones, so this
  # assumes the committed board has zones filled+saved (the normal workflow — see
  # route.py); if it doesn't, plane pads read as unrouted and the count balloons,
  # which we detect and flag rather than dumping the whole GND net.
  kicad-cli pcb drc --format json --exit-code-violations "$PCB" \
    -o /tmp/doorbell_drc.json >/dev/null 2>&1 || true
  python3 - "$1" <<'PY' || true
import json, sys
expected = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0
try:
    items = json.load(open("/tmp/doorbell_drc.json")).get("unconnected_items", [])
except Exception:
    items = []
# Many more unconnected than route.py counted ⇒ zones aren't filled on disk.
if expected and len(items) > expected + 2:
    print(f"    ({len(items)} unconnected items vs {expected} expected — fill + save "
          "zones in KiCad, then re-run to pinpoint)")
    items = []
if not items:
    print("    (could not pinpoint; inspect the ratsnest in KiCad)")
for v in items:
    legs = []
    for it in v.get("items", []):
        p = it.get("pos", {})
        legs.append(f"{it.get('description','?')} @ ({p.get('x',0):.2f}, {p.get('y',0):.2f}) mm")
    print("    ✗ " + "  ↔  ".join(legs))
PY
  rm -f /tmp/doorbell_drc.json
}
route() {
  echo "▶ verify planes/thieving/connectivity + DRC"
  local rc=0
  "$KPY" kicad/route.py >/tmp/doorbell_route.txt 2>&1 || rc=$?
  q </tmp/doorbell_route.txt
  if [ "$rc" -ne 0 ]; then
    if grep -q "unrouted connection" /tmp/doorbell_route.txt; then
      local n
      n=$(grep -oE "ERROR: [0-9]+ unrouted" /tmp/doorbell_route.txt | grep -oE "[0-9]+" | head -1)
      echo "  unrouted connection location(s):"
      report_unrouted "${n:-0}"
    fi
    exit "$rc"
  fi
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

step() {
  echo "▶ STEP model -> kicad/fab/doorbell.step"
  mkdir -p kicad/fab
  # Parts carrying a truthy custom field 'STEP_Exclude' are dropped from the model
  # (e.g. SW3/SW4 left off so the bare board can be fit-tested against the real
  # switches). kicad-cli's --component-filter is include-only, so step_exclude.py
  # emits the complement; empty output means nothing is flagged → export the lot.
  local inc args=(--force --subst-models --no-dnp)
  inc=$(python3 kicad/step_exclude.py "$PCB")   # stdout: include csv; stderr: summary (shown)
  if [ -n "$inc" ]; then args+=(--component-filter "$inc"); fi
  kicad-cli pcb export step "${args[@]}" -o kicad/fab/doorbell.step "$PCB" >/tmp/doorbell_step.txt 2>&1 || true
  q </tmp/doorbell_step.txt | grep -iE "Could not add 3D model|STEP file .* created" || true
}

case "${1:-all-route}" in
  sch)        sch ;;
  check)      check ;;
  route)      route ;;
  sim)        sim ;;
  fab)        fab ;;
  step)       step ;;
  all)        sch; check; route; sim ;;
  all-route)  sch; check; route; sim; fab; step ;;
  *) echo "usage: $0 {sch|check|route|sim|fab|step|all|all-route}"; exit 1 ;;
esac
echo "✓ done"
