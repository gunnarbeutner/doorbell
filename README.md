# Doorbell controller (Klingel V4)

Single-board redesign of an STR Elektronik TV20/S intercom controller: ESP32-C6 +
USB-C + on-board relay drivers and opto bell-sense. The KiCad project is fully
**code-generated** — `kicad/doorbell_design.py` is the single source of truth.

## Layout

| Path | What |
|------|------|
| `build.sh` | Build entry point — regenerates schematic + PCB + fab outputs (`./build.sh all-route`). |
| `DESIGN.md` | Full design reference (topology, GPIO map, V3→V4 rationale). |
| `ORDERING.md` | JLCPCB ordering notes. |
| `VERIFICATION.md` | Pre-fabrication schematic review. |
| `kicad/` | Code-generated KiCad project (generators, libraries, `fab/` outputs). See `kicad/README.md`. |
| `firmware/` | ESPHome configs — `doorbell-v4.yaml` (current), `doorbell-v3.yaml` (legacy/deployed). |
| `docs/` | Datasheets and reference docs (TV20/S service manual, `KlingelV4.fzz` Fritzing source). |
| `reference/` | Raw teardown/prototype photos and the one-off Fritzing netlist extractor. |
| `fab-orders/` | Shipped fabrication order artifacts. |

## Build

```bash
./build.sh all-route   # schematic + PCB + route + fab outputs
```

See `kicad/README.md` for the build pipeline details.
