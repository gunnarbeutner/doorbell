# Doorbell controller — KiCad project

## Build pipeline (verify + fab; the KiCad files are authoritative)

`doorbell.kicad_sch` / `doorbell.kicad_pcb` are the authoritative source — edit them in
KiCad. `build.sh` never authors copper; it runs the checks KiCad's own DRC/ERC can't
express and exports the fab outputs:

```
./build.sh              # verify + all order-ready exports (full release)
./build.sh verify       # ERC + placement + PCB/DRC + simulation; no exports
./build.sh schematic    # schematic ERC + PDF export
./build.sh pcb          # placement + planes/thieving/connectivity + DRC
./build.sh simulation   # circuit-simulator tests
./build.sh fabrication  # Gerbers + drill + position + BOM -> fab/
./build.sh step         # populated STEP model
./build.sh board-step   # bare-board STEP model
```

| Script | Interpreter | Role |
|--------|-------------|------|
| `tools/check_pcb.py` | KiCad bundled python (pcbnew) | verify placement (edge flush/overhang, parts inside outline) |
| `tools/route.py` | KiCad bundled python (pcbnew) | refill zones + verify connectivity + copper-thieving sliver limit |
| `tools/jlcpcb_cpl.py` | KiCad bundled python (pcbnew) | JLCPCB CPL (pad-centroid positions) |
| `tools/jlcpcb_files.py` | `.venv/bin/python` (kiutils) | JLCPCB BOM (from the schematic) |

`tools/doorbell_design.py` holds the placement constants `check_pcb.py` verifies — connector edge
fit/overhang and the mounting-hole MLCC keep-out; the KiCad files are authoritative for the rest.
The board is hand-routed **in KiCad**;
`route.py` fails the build on any unrouted connection or any copper-thieving float island
over the sliver limit (≥ 2 mm² or ≥ 10 mm) — fix those in KiCad, never with a tool.

> 4-layer, ~64 × 59 mm; `tools/check_pcb.py` gates placement (the edge connectors J1/J2/J3 and U1
> sit flush on their board edges).

## Where the rest lives (deliberately not duplicated here)

This README is only the build/verify/fab process. Everything else stays in its authoritative
source so it can't drift out of sync — so there is **no part list, net list, or pin table here**:

- **Parts / values / footprints / LCSC numbers** — in the schematic (hidden `LCSC`/`MPN`/`Footprint`
  fields); exported to `fab/doorbell-bom-jlcpcb.csv` by `build.sh fabrication`.
- **Net connectivity and pin assignments** — `doorbell.kicad_sch` (open it, or
  `kicad-cli sch export netlist`).
- **Architecture, pin map, relays/SSRs, audio path, power, isolation, layout** — `../DESIGN.md`;
  the requirements it satisfies — `../REQUIREMENTS.md`; ordering — `../ORDERING.md`.
