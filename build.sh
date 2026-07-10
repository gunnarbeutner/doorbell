#!/usr/bin/env bash
# Verify + package the doorbell design. The KiCad files
# (kicad/doorbell.kicad_sch / kicad/doorbell.kicad_pcb) are the AUTHORITATIVE
# source — edit them in KiCad. This script never authors copper; it runs the
# checks KiCad's own DRC/ERC can't express and exports the fab outputs.
#
#   ./build.sh             release: verify, then generate all order-ready outputs (default)
#   ./build.sh verify      ERC + placement + PCB connectivity/DRC + simulation; no exports
#   ./build.sh release     same complete run as no arguments
#   ./build.sh schematic   schematic ERC + PDF export
#   ./build.sh pcb         placement constraints + planes/thieving/connectivity + DRC
#   ./build.sh simulation  run the circuit-simulator unit tests
#   ./build.sh fabrication export Gerbers/drill/position + BOM to fab/
#   ./build.sh step        export populated STEP model (omits STEP_Exclude parts)
#   ./build.sh board-step  export bare-board STEP for a 3D-printed switch fit-test
set -euo pipefail
cd "$(dirname "$0")"

VENVPY="./.venv/bin/python"                       # kiutils lives here (BOM)
KPY="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"  # owns pcbnew
SCH="kicad/doorbell.kicad_sch"
PCB="kicad/doorbell.kicad_pcb"
NOISE='fontconfig|invalid attribute|invalid constant|assert|traits|wxApp|Analytics|New version|Error retrieving source file attributes|NSCocoaErrorDomain'
q() { grep -vE "$NOISE" || true; }

erc() {
  echo "▶ schematic ERC"
  kicad-cli sch erc "$SCH" -o /tmp/doorbell_erc.txt 2>&1 | q >/dev/null || true
  grep "ERC messages" /tmp/doorbell_erc.txt
}
schematic() {
  erc
  echo "▶ schematic PDF -> kicad/doorbell.pdf"
  kicad-cli sch export pdf "$SCH" -o kicad/doorbell.pdf 2>&1 | q | tail -1
}
check() {
  echo "▶ check placement constraints"
  "$KPY" tools/check_pcb.py 2>&1 | q
}
report_unrouted() {
  # Supplement route.py's island localizer for unrouted copper that ISN'T a zone
  # island (loose pads/tracks): pinpoint those by pad/position via the DRC engine's
  # unconnected-items report. kicad-cli does NOT refill zones, so this assumes the
  # committed board has zones filled+saved (the normal workflow — see route.py); if it
  # doesn't, plane pads read as unrouted and the count balloons, which we detect and
  # skip. Self-referential zone items (a zone's anchor corner ↔ itself) are dropped —
  # route.py already localizes those to the island + stranded pad.
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
lines = []
for v in items:
    legs = []
    for it in v.get("items", []):
        p = it.get("pos", {})
        legs.append(f"{it.get('description','?')} @ ({p.get('x',0):.2f}, {p.get('y',0):.2f}) mm")
    if len(set(legs)) <= 1:
        continue  # zone-anchor self-loop (just the corner) — route.py localizes these
    lines.append("    ✗ " + "  ↔  ".join(legs))
if lines:
    print("  non-zone unrouted endpoint(s):")
    print("\n".join(lines))
PY
  rm -f /tmp/doorbell_drc.json
}
pcb_drc() {
  echo "▶ verify planes/thieving/connectivity + DRC"
  local rc=0
  "$KPY" tools/route.py >/tmp/doorbell_route.txt 2>&1 || rc=$?
  q </tmp/doorbell_route.txt
  if [ "$rc" -ne 0 ]; then
    if grep -q "unrouted connection" /tmp/doorbell_route.txt; then
      local n
      n=$(grep -oE "ERROR: [0-9]+ unrouted" /tmp/doorbell_route.txt | grep -oE "[0-9]+" | head -1)
      report_unrouted "${n:-0}"
    fi
    exit "$rc"
  fi
  local drc_rc=0
  rm -f /tmp/doorbell_drc.txt /tmp/doorbell_drc_cli.txt
  kicad-cli pcb drc --schematic-parity --exit-code-violations "$PCB" \
    -o /tmp/doorbell_drc.txt >/tmp/doorbell_drc_cli.txt 2>&1 || drc_rc=$?
  q </tmp/doorbell_drc_cli.txt
  if [ -f /tmp/doorbell_drc.txt ]; then
    grep -iE "unconnected pads|DRC violations|schematic parity" /tmp/doorbell_drc.txt || true
  fi
  if [ "$drc_rc" -ne 0 ]; then
    echo "ERROR: KiCad DRC/parity gate failed (exit $drc_rc). See /tmp/doorbell_drc.txt." >&2
    return "$drc_rc"
  fi
}
simulation() {
  echo "▶ sim unit tests"
  ( cd sim && node --test )
}
fabrication() {
  echo "▶ fab outputs -> fab/"
  mkdir -p fab
  rm -f fab/*.gtl fab/*.gbl fab/*.gts fab/*.gbs \
        fab/*.gto fab/*.gbo fab/*.gtp fab/*.gbp \
        fab/*.g1 fab/*.g2 \
        fab/*.gm1 fab/*.gbr fab/*.gbrjob fab/*.drl fab/*.d356
  kicad-cli pcb export gerbers "$PCB" -o fab/ \
    --layers F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,F.Paste,B.Paste,Edge.Cuts 2>&1 | q | tail -1
  kicad-cli pcb export drill "$PCB" -o fab/ 2>&1 | q | tail -1
  kicad-cli pcb export ipcd356 "$PCB" -o fab/doorbell.d356 2>&1 | q | tail -1  # netlist for flying-probe E-test
  "$KPY" tools/jlcpcb_cpl.py 2>&1 | q            # JLCPCB CPL (pad-centroid positions, from pcbnew)
  "$VENVPY" tools/jlcpcb_files.py 2>&1 | q       # JLCPCB BOM (from schematic via kiutils)
  ( cd fab && rm -f doorbell-jlcpcb.zip &&
    zip -q doorbell-jlcpcb.zip *.gtl *.g1 *.g2 *.gbl *.gts *.gbs *.gto *.gbo *.gtp *.gbp *.gm1 *.drl *.d356 )
  echo "  -> upload to JLCPCB:  doorbell-jlcpcb.zip (gerbers + IPC-356 netlist)  +  doorbell-bom-jlcpcb.csv (BOM)  +  doorbell-cpl.csv (CPL)"
}

step() {
  echo "▶ STEP model -> fab/doorbell.step"
  mkdir -p fab
  # Parts carrying a truthy custom field 'STEP_Exclude' are dropped from the model
  # (e.g. SW3/SW4 left off so the real switches can be fit-tested against the print).
  # kicad-cli's --component-filter is include-only, so step_exclude.py emits the
  # complement; empty output means nothing is flagged → export the lot. The same flag
  # drives step_fit_holes.py, which enlarges those parts' THT drills on a throwaway copy
  # (so the real part drops into the printed hole); committed board + fab stay as-fab.
  local tmp="/tmp/doorbell-step.kicad_pcb"
  python3 tools/step_fit_holes.py "$PCB" "$tmp" 2>&1 | q
  # The board is read from /tmp, so KiCad would resolve ${KIPRJMOD} (repo-local 3D model
  # libs — libraries/audio/libraries/switches/…) to /tmp and drop those models. Point it back at
  # the real project dir so every component model still loads.
  local inc args=(--force --subst-models --no-dnp -D "KIPRJMOD=$PWD/kicad")
  inc=$(python3 tools/step_exclude.py "$PCB")   # stdout: include csv; stderr: summary (shown)
  if [ -n "$inc" ]; then args+=(--component-filter "$inc"); fi
  kicad-cli pcb export step "${args[@]}" -o fab/doorbell.step "$tmp" >/tmp/doorbell_step.txt 2>&1 || true
  q </tmp/doorbell_step.txt | grep -iE "Could not add 3D model|STEP file .* created" || true
  # Anchor SMD parts with 'fake solder' blocks so the printed model doesn't shed components
  # (e.g. the K5 relay) off their thin printed leads; see step_solder.py. Non-fatal.
  "$KPY" tools/step_solder.py fab/doorbell.step 2>&1 | q || true
  rm -f "$tmp"
}

board_step() {
  echo "▶ bare-board STEP (no components) -> fab/doorbell-board.step"
  mkdir -p fab
  # Board substrate only — outline, mounting/tooling holes, and every THT pad drill; no
  # component bodies. Routing vias are NOT cut (no --cut-vias-in-body): all 80 are 0.3 mm,
  # below what a 0.4 mm-nozzle FDM can print, and none belong to SW3/SW4 or the mounting
  # holes (those are THT pad drills, which --board-only always cuts). Intended to be
  # 3D-printed and fit-tested against the real STEP_Exclude'd switches, so step_fit_holes.py
  # enlarges those flagged footprints' drills on a throwaway copy (committed board + fab
  # stay as-fab); see that script for the FDM rationale.
  local tmp="/tmp/doorbell-board.kicad_pcb"
  python3 tools/step_fit_holes.py "$PCB" "$tmp" 2>&1 | q
  # --no-extra-pad-thickness drops the soldermask slivers that otherwise hang ~0.05 mm
  # below the board's bottom face. A 0.035 mm copper annular ring around every plated
  # hole still protrudes (board-only models the bare board's real copper, no flag omits
  # it) — print the FLAT TOP face down (holes go all the way through, so flipping is fine
  # for a fit-test), or sink the model ~0.05 mm into the slicer's build plate.
  kicad-cli pcb export step --force --board-only --no-extra-pad-thickness \
    -o fab/doorbell-board.step "$tmp" >/tmp/doorbell_step_board.txt 2>&1 || true
  q </tmp/doorbell_step_board.txt | grep -iE "STEP file .* created|error" || true
  rm -f "$tmp"
}

verify() {
  erc
  check
  pcb_drc
  simulation
}

release() {
  verify
  echo "▶ schematic PDF -> kicad/doorbell.pdf"
  kicad-cli sch export pdf "$SCH" -o kicad/doorbell.pdf 2>&1 | q | tail -1
  fabrication
  step
}

case "${1:-release}" in
  verify)       verify ;;
  release)      release ;;
  schematic)    schematic ;;
  pcb)          check; pcb_drc ;;
  simulation)   simulation ;;
  fabrication)  fabrication ;;
  step)         step ;;
  board-step)   board_step ;;
  *) echo "usage: $0 {verify|release|schematic|pcb|simulation|fabrication|step|board-step}"; exit 1 ;;
esac
echo "✓ done"
