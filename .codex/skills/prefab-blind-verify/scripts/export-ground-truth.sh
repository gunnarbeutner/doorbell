#!/usr/bin/env bash
set -euo pipefail

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
out="/tmp/prefab"
mkdir -p "$out"

kicad-cli sch export netlist "$repo/kicad/doorbell.kicad_sch" -o "$out/doorbell.net"
kicad-cli sch export python-bom "$repo/kicad/doorbell.kicad_sch" -o "$out/doorbell-bom.xml" || true
test -s "$out/doorbell.net"

printf 'repo=%s\nnetlist=%s\nbom=%s\n' "$repo" "$out/doorbell.net" "$out/doorbell-bom.xml"
