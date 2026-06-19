# Doorbell controller (Klingel V4)

An ESP32 (ESPHome) interface board for a **TCS / STR TV20/S** apartment intercom bus. It replaces a
**WF26** handset — or, with J3/J4 open, runs in parallel alongside an existing WF26 — and adds
ring detection, gong suppression, two-way audio, and door-opener control to Home Assistant.

## Where things live

- **[REQUIREMENTS.md](REQUIREMENTS.md)** — *what* the board must do (functional + safety
  requirements). The requirements source of truth; start here for intent.
- **[DESIGN.md](DESIGN.md)** — *how* it's built (architecture, pin map, relays, sense front-end,
  audio path, power, dual-mode, isolation). Authoritative for the circuit's rationale.
- **`kicad/`** — the actual schematic + PCB (`doorbell.kicad_sch` / `.kicad_pcb`); these are the
  source of truth for the board itself, edited directly in KiCad. `./build.sh all-route` verifies
  and exports fab outputs.
- **`firmware/`** — ESPHome config (`doorbell-v4.yaml`).
- **`sim/`** — Node-based circuit simulator + PCB viewer used to sanity-check the design
  (`cd sim`; `npm test`; dev server `node server.js`).
- **`wf26/`** — reverse-engineered handset; **`docs/`** — TV20/S reference PDFs.

## Working with the docs

REQUIREMENTS.md and DESIGN.md must stay in sync: a behaviour change in the design updates both.
REQUIREMENTS.md holds the requirements (extracted from DESIGN.md); DESIGN.md keeps the
implementation and rationale and links back. Verification status lives in DESIGN.md /
VERIFICATION.md, not in REQUIREMENTS.md.
