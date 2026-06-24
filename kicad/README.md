# Doorbell V4 — KiCad project

## Build pipeline (verify + fab; the KiCad files are authoritative)

`doorbell.kicad_sch` / `doorbell.kicad_pcb` are the authoritative source — edit them in
KiCad. `build.sh` never authors copper; it runs the checks KiCad's own DRC/ERC can't
express and exports the fab outputs:

```
./build.sh            # verify + fab (full run; = all-route)
./build.sh sch        # schematic ERC + PDF export
./build.sh check      # PCB placement constraints (check_pcb.py)
./build.sh route      # verify planes/thieving/connectivity (route.py) + DRC
./build.sh fab        # Gerbers + drill + position + BOM -> kicad/fab/
./build.sh all-route  # sch + check + route + fab (full run)
```

| Script | Interpreter | Role |
|--------|-------------|------|
| `check_pcb.py` | KiCad bundled python (pcbnew) | verify placement (edge flush/overhang, parts inside outline) |
| `route.py` | KiCad bundled python (pcbnew) | refill zones + verify connectivity + copper-thieving sliver limit |
| `jlcpcb_cpl.py` | KiCad bundled python (pcbnew) | JLCPCB CPL (pad-centroid positions) |
| `jlcpcb_files.py` | `.venv/bin/python` (kiutils) | JLCPCB BOM (from the schematic) |

`doorbell_design.py` holds the placement constants `check_pcb.py` verifies — connector edge
fit/overhang and the mounting-hole MLCC keep-out; the KiCad files are authoritative for the rest.
The board is hand-routed **in KiCad**;
`route.py` fails the build on any unrouted connection or any copper-thieving float island
over the sliver limit (≥ 2 mm² or ≥ 10 mm) — fix those in KiCad, never with a tool.

> 4-layer, ~64 × 59 mm; `check_pcb.py` gates placement (the edge connectors J1/J2/J3 and U1
> sit flush on their board edges).

## Where the rest lives (deliberately not duplicated here)

This README is only the build/verify/fab process. Everything else stays in its authoritative
source so it can't drift out of sync — so there is **no part list, net list, or pin table here**:

- **Parts / values / footprints / LCSC numbers** — in the schematic (hidden `LCSC`/`MPN`/`Footprint`
  fields); exported to `fab/doorbell-bom-jlcpcb.csv` by `build.sh fab`.
- **Net connectivity and pin assignments** — `doorbell.kicad_sch` (open it, or
  `kicad-cli sch export netlist`).
- **Architecture, pin map, relays/SSRs, audio path, power, isolation, layout** — `../DESIGN.md`;
  the requirements it satisfies — `../REQUIREMENTS.md`; ordering — `../ORDERING.md`.
