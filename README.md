# Doorbell controller (Klingel V4)

An ESP32-S3 (ESPHome) interface board for an **STR Elektronik TV20/S** apartment-intercom bus.
It replaces a **WF26** handset and adds ring detection, gong suppression, two-way audio and
door-opener control to Home Assistant, while staying a working passive handset when unpowered.

The **KiCad files** (`kicad/doorbell.kicad_sch` / `.kicad_pcb`) are the authoritative source for
the board — edited directly in KiCad. `./build.sh all-route` only verifies them and exports the
fab outputs; it does not author or regenerate the board.

## Layout

| Path | What |
|------|------|
| `REQUIREMENTS.md` | *What* the board must do — functional + safety requirements (start here for intent). |
| `DESIGN.md` | *How* it's built — architecture, GPIO map, relays/SSRs, audio path, V3→V4 rationale. |
| `VERIFICATION.md` | How to verify the board before fab — the checks to run and what to look for. |
| `ORDERING.md` | JLCPCB ordering notes (Economic PCBA workflow + the review gates). |
| `kicad/` | Authoritative KiCad project + the verify/export scripts and `fab/` outputs. See `kicad/README.md`. |
| `firmware/` | ESPHome configs — `doorbell-v4.yaml` (current), `doorbell-v3.yaml` (legacy/deployed). |
| `sim/` | Node circuit simulator + PCB viewer used to sanity-check the design (`cd sim`; `npm test`). |
| `wf26/` | Reverse-engineered WF26 handset (`wf26.kicad_sch`). |
| `osci/` | Bench scope captures of the real TV20/S (ring, door-open, timeout) + web viewer. |
| `docs/` | Datasheets and reference docs (TV20/S service manual, `KlingelV4.fzz` Fritzing source). |
| `reference/` | Raw teardown/prototype photos and the one-off Fritzing netlist extractor. |
| `fab-orders/` | Shipped fabrication order artifacts. |

## Build

```bash
./build.sh all-route   # verify (ERC/DRC/placement/routing) + export fab outputs
```

See `kicad/README.md` for the build pipeline details.
