# sim — neutral schematic simulator

A generic transient circuit simulator with a browser scope. It does two things and nothing
board-specific: **imports** `kicad/doorbell.kicad_sch` and **simulates each component by a
standard type-based model**. No knowledge of what any net or part *means* is encoded.

## Use

```sh
cd sim
python3 build.py          # imports the schematic, regenerates board-sim.html
open board-sim.html       # any browser; self-contained, no server
```

Re-run `build.py` after editing the schematic to re-import.

In the page: add **Sources** (drive any net with DC/sine/square/step/pulse), check **Probes**
(any net), set duration/dt, **Run** → the scope plots the probed node voltages.

Two generated tools share the same importer + engine:
- **`board-sim.html`** — controls + a single scope. Pick sources/probes, Run.
- **`board-pcb.html`** — 3-column PCB view: `[controls + layer toggles + time cursor] | [selected copper
  layers, stacked] | [scopes]`. **Hover** a trace → tooltip with its net's voltage (and best-effort
  current); **click** a trace → adds that net's scope on the right; the time-cursor slider scrubs the
  instant shown on the board and on the scope cursors. Inner planes (In1/In2) show vias/pads only —
  zone fills aren't extracted yet.

## How components are modeled (neutral, by type)

- **Auto-modeled from value + refdes:** R, C, L, diode (KiCad `Device:D`: pin 1 = cathode, pin 2 = anode),
  speaker (→ R), fuse (→ short), **optocoupler** (standard 4-pin: LED diode 1→2 + CTR current source
  4→3 with a saturation clamp), **MOSFET/transistor** (gate-controlled switch, using the symbol's
  `G/D/S` pin functions), **regulator/LDO** (an IC with `VIN/VOUT/GND` pin functions → ideal regulated
  output; target voltage parsed from the output net name, e.g. `+3V3` → 3.3 V; ideal, so it doesn't draw
  input current), **transformer** (two coupled inductors; windings = the first/second half of the
  connected pins; L and coupling `k` editable in the UI).
- **Relays & switches** — pin-outs are **hard-coded per part type** (keyed on the symbol `lib_id`):
  Omron `G6K-2F` relay → coil 1/8, contacts COM3/NC2/NO4 + COM6/NC7/NO5; `SPPJ322300` DPDT switch →
  COM2/NC3/NO1 + COM5/NC6/NO4; tactile button → SPST 1–2. **Relays are coil-driven** (energized when
  |V_coil| ≥ 2.5 V — drive the coil/gate to trigger; read-only state badge). **Switches** are physical
  buttons with a manual press toggle. No configuration UI.
- **Still bare nodes:** real **ICs** (ESP32, codec) — no neutral model exists; render **red**. Use
  **Extra elements** for anything else you want to add by hand.
- **Floating vs 0 V:** nets with no DC-conductive path to ground or a source are flagged **floating**
  (dashed grey on the board, "(floating)" in the tooltip) — distinct from a real 0 V net.

## Engine

Modified Nodal Analysis, Backward-Euler transient, Newton iteration for diodes (one shared generic
diode model, `Is`/`n` editable in the UI). `build.py` is the importer; `board-sim.template.html` is
the generic simulator (with a `__NETLIST_JSON__` placeholder); `board-sim.html` is the generated,
self-contained result; `netlist.json` is the imported netlist.

## Scope / limits

Validates **design intent** — loading/impedance, RC time constants, sense thresholds, switch-topology
changes — not device precision, EMI, or layout parasitics. v1 uses analytic stimulus only (capture-CSV
replay and coupled-inductor transformers are later iterations).
