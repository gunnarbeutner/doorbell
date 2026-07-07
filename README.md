# Doorbell controller (Klingel V4)

An ESP32-S3 (ESPHome) interface board for an **STR Elektronik TV20/S** apartment-intercom bus.
It replaces a **WF26** handset and adds ring detection, gong suppression, two-way audio and
door-opener control to Home Assistant, while staying a working passive handset when unpowered —
the hardwired relay/switch/speaker core rings the gong, listens and opens the door with the
board completely dead.

![The Klingel V4 board installed in the wall](docs/design/v4-final.jpeg)

**Status:** the V4.1 board (JLCPCB-fabbed and -assembled) is bench-verified and deployed —
installed in the wall in place of the WF26, powered from the wall feed, running
`firmware/doorbell-v4.yaml`.

The **KiCad files** (`kicad/doorbell.kicad_sch` / `.kicad_pcb`) are the authoritative source for
the board — edited directly in KiCad. `./build.sh all-route` only verifies them and exports the
fab outputs; it does not author or regenerate the board.

If you own a TV20/S-family intercom and just want ring detection or chime muting: the bus
reverse-engineering in `DESIGN.md`, the WF26 handset schematic in `wf26/`, and the real-bus scope
captures in `captures/` are usable on their own, without building this board.

## Layout

| Path | What |
|------|------|
| `REQUIREMENTS.md` | *What* the board must do — functional + safety requirements (start here for intent). |
| `DESIGN.md` | *How* it's built — architecture, GPIO map, relays/SSRs, audio path, bus model. |
| `VERIFICATION.md` | Design-verification gates plus the bench bring-up / commissioning record. |
| `ORDERING.md` | JLCPCB ordering notes (Economic PCBA workflow + the review gates). |
| `kicad/` | Authoritative KiCad project (`doorbell.kicad_sch` / `.kicad_pcb`). See `kicad/README.md`. |
| `tools/` | Build/inspection Python scripts (placement check, routing verify, STEP/BOM/CPL export). |
| `firmware/` | ESPHome configs — `doorbell-v4.yaml` (deployed), `doorbell-v4-bench.yaml` (bench twin: debug SSR switches, audio loopback instrumentation, no HA events), `doorbell-v4-tonegen.yaml` (spare board as bench tone source / HA media player), older V3/V4.0 configs kept for the retired hardware. |
| `sim/` | Node circuit simulator + PCB viewer used to sanity-check the design (`cd sim`; `npm test`). |
| `wf26/` | Reverse-engineered WF26 handset (`wf26.kicad_sch`). |
| `captures/` | Bench scope captures of the real TV20/S (ring, door-open, timeout) + web viewer. |
| `docs/` | Datasheets and reference docs (`datasheets/`, `design/`, `ordering/`, `attic/`) — incl. the wall wire-up map (`design/wall-wiring-v4.svg`) and the J3 power-cable pinout (`design/usb-jst-j3-wiring.svg`). |
| `fab/` | Generated fab outputs (Gerbers, drill, BOM, CPL, STEP) — produced by `./build.sh fab`. |
| `orders/` | Shipped fabrication order archives. |

## Build

```bash
./build.sh all-route   # verify (ERC/DRC/placement/routing) + export fab outputs
```

See `kicad/README.md` for the build pipeline details.

## Firmware

```bash
cd firmware
esphome run doorbell-v4.yaml    # needs firmware/secrets.yaml (see below)
```

Secrets (WiFi credentials, API encryption key, OTA password) live in `firmware/secrets.yaml`,
which is gitignored — create it with `wifi_ssid`, `wifi_password`, `api_encryption_key` and
`ota_password` before building. The bench and production configs share device build directories
in some name-change scenarios: run `esphome clean` after switching configs or renaming a device.
