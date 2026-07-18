# sim — schematic-driven circuit simulator

A transient circuit simulator with a browser PCB view. It **imports** `kicad/doorbell.kicad_sch`
and **simulates each component by a type-based model**. Nothing is baked: the netlist is read from
the KiCad files on demand.

## Use

```sh
cd sim
npm run dev      # http://localhost:8080 — serves the UI; reads the KiCad files live for the netlist
npm test         # integration tests against the live schematic (Node's test runner)
npm run test:monte-carlo -- 1592639710 250  # optional seeded watchdog sensitivity diagnostic
```

`npm run dev` re-imports automatically when a `.kicad_sch` / `.kicad_pcb` changes — just reload.
Importing needs `kicad-cli` on `PATH` (KiCad's CLI; used for net connectivity).

The page is a 3-column PCB view: `[controls + layer toggles + time cursor] | [selected copper layers,
stacked] | [scopes]`. Add **Sources** (drive any net with DC/sine/square/step/pulse — each has an on/off
toggle, off = the net floats; multiple sources on one net superpose), set duration/dt, **Run**. **Hover**
a trace → its net's voltage; **click** a trace → a scope on the right; the time-cursor slider scrubs the
instant shown on the board and the scope cursors. Colour is by voltage (fixed 0–Vmax scale) or by net.
Inner planes (In1/In2) show vias/pads only — zone fills aren't extracted yet.

## Layout

- `src/import.js` — KiCad → netlist object (node; shells out to `kicad-cli`, parses the `.kicad_sch` /
  `.kicad_pcb`, including MPN/LCSC/datasheet fields). Replaces the old `build.py`.
- `src/engine.js` — the simulation core (device models + MNA transient solver); shared by the UI and tests.
- `src/corners.js` — fitted-part limits, explicit engineering assumptions and named deterministic corners.
- `src/ui.js` + `index.html` — the browser front-end (imports `engine.js`, fetches `/netlist.json`).
- `server.js` — dev server (`npm run dev`); serves the UI and the live netlist.
- `test/` — integration tests + model-coverage and deterministic-corner gates (`npm test`).
- `diagnostics/` — optional seeded sensitivity tools; these supplement rather than replace the
  deterministic safety gates.

## How components are modeled (by type)

Each device type is a **class in `src/components/`** (one file each: `Resistor`, `Diode`, `Mosfet`,
`Optocoupler`, `Transformer`, `Relay`, `Switch`, `SolderBridge`, `EsdArray`, `Ldo`, … + `Connector`/
`TestPoint` ports and an `Unmodeled` fallback). A class exposes:

- `static compatible(symbol)` — does this class model the part? It inspects the symbol's `lib_id`
  (library category / part name) and pin functions — **not** the reference designator. So a part is
  modeled by what it *is*, even if its refdes breaks convention (e.g. `D5`, an ESD array, is matched by
  `EsdArray`, not `Diode`).
- `elements(ctx)` — the simulation elements it contributes (with its own parameters: a diode's Is/n by
  family, a 2N7002's vth/Rds, a relay's coil R + pull-in, the transformer's L/k/Rdc, …).

The registry (`src/components/index.js`) tries the classes most-specific-first and instantiates the first
match (or `Unmodeled` → shown red). The importer no longer classifies anything; it just emits raw
components (ref, lib, value, footprint, pins, pinfn and exact-part metadata).

**Nominal device parameters are per-part** — derived from each component's part type/value:
diode Vf class by family (silicon `1N4148` ≈ 0.65 V, Schottky `SS14` ≈ 0.3–0.4 V, visible LED ≈ 1.9 V,
TVS by type: unidirectional forward-only, bidirectional anti-series with a standoff `vbr`, open across the
bus range); MOSFET `vth`/`Rds(on)` by part (`2N7002`); optocoupler LED + guaranteed CTR
(`TLP293` GB rank);
transformer winding `L`/`k`/`Rdc` by part (`SM-LP-5001`: Rdc 115 Ω); relay coil resistance, pull-in,
operate/release time and contact resistance from the fitted part.

Qualification tests may pass strict per-reference overrides to `buildElements(..., { params })`.
Every override must match a live schematic reference and a parameter that its model consumes; unknown
or misspelled values fail instead of silently running nominal. The returned element list records the
resolved nominal/override pairs in `resolvedParams` for auditability.

- **Auto-modeled from value + refdes:** R, C (including tolerance/effective-value overrides and optional
  capacitor leakage; polarized caps, `Device:C_Polarized` etc., are flagged in the
  status bar if they're ever reverse-biased — pin 1 = +), L, diode (KiCad `Device:D`: pin 1 = cathode, pin 2 = anode),
  speaker (→ R), fitted 0466 fuse (→ 75 mΩ + 0.0423 A²s melting model whose blown state remains
  latched across seeded scenario changes), **optocoupler** (standard 4-pin: LED diode 1→2 + CTR/dark-current source
  4→3 with a saturation clamp), **MOSFET/transistor** (gate-controlled switch, using the symbol's
  `G/D/S` pin functions), **regulator/LDO** (an IC with `VIN/VOUT/GND` pin functions → regulated
  output, floored at 0; target voltage parsed from the output net name, e.g. `+3V3` → 3.3 V; draws its
  output current back out of the input pin so the input rail loads down rather than supplying free power,
  and operates as a one-quadrant source only while VIN has dropout headroom — it neither back-drives a
  dead input nor sinks an externally overdriven output; pull the supply and the board de-energizes
  instead of running forever off a charged cap), **transformer** (two coupled inductors + series winding Rdc),
  **ESD/TVS protection array** (e.g. `TPD2S017`: each channel passes IN↔OUT, with steering diodes that
  clamp the line to VCC/GND and a ~6 V VCC↔GND rail clamp — so a realistic surge through a source
  impedance clamps to ≈ VCC + Vf; an ideal 0 Ω source can't be clamped, as in reality).
- **Relays & switches** — pin-outs are **hard-coded per part type** (keyed on the symbol `lib_id`):
  Omron `G6K-2F` relay → coil 1/8, contacts COM3/NC2/NO4 + COM6/NC7/NO5; `SPPJ322300` DPDT switch →
  COM2/NC3/NO1 + COM5/NC6/NO4; tactile button → SPST 1–2; **solder bridges** (`SolderJumper`) → SPST,
  closed by default. **Relays are coil-driven** (energized when |V_coil| ≥ ~75 % of the rated coil
  voltage, with datasheet operate/release delay — drive the coil/gate to trigger; read-only state badge).
  **PhotoMOS outputs likewise use operate/recovery current and voltage hysteresis plus switching delay.**
  **Switches & solder bridges** toggle
  manually. No configuration UI.
- **ICs (ESP32, codec) — supply current (+ codec VMID):** their digital I/O (GPIO, I2S, USB) is **not**
  modeled, so they still render **red** and signals through their pins aren't trusted; but their power draw
  *is* — each is an equivalent resistive load (`Ic`) from its supply pin to GND at a representative active
  current (ESP32 ~100 mA, ES8311 ~10 mA), which pulls through the LDO → +5V → Schottky → VBUS. The one
  analog exception: the ES8311's **VMID reference** (≈ AVDD/2) is modeled, because the mic front-end's
  divider/bias depends on it. Use **Extra elements** for anything else you want to add by hand.
- **Floating vs 0 V:** nets with no DC-conductive path to ground or a source are flagged **floating**
  (dashed grey on the board, "(floating)" in the tooltip) — distinct from a real 0 V net.

## Engine

Modified Nodal Analysis, Backward-Euler transient, Newton iteration (SPICE-style relative+absolute
convergence with damping for the per-part diode/opto models, all in `src/engine.js` (no DOM, importable
by the tests). A nonlinear solve that exhausts its iteration limit throws with the time, worst node and
voltage delta; it is never silently accepted. `src/import.js` produces the netlist; `src/ui.js` is the
browser front-end.

## Qualification corners

`src/corners.js` separates guaranteed fitted-part limits from named engineering bounds. Permanent tests
cover the watchdog fast/nominal/slow envelope, break-before-make timing, PhotoMOS drive and switching
delay, K5/K6 interlock and GPIO pin faults, powered boot/brownout fallback, dynamic fuse isolation,
bounded bus faults, LDO passivity, optocoupler CTR/dark current, the supply monitor, RX/TX voice-band
gain, captured-waveform replay, the welded-K1 door discriminator, timestep refinement and convergence
failure. The compact replay fixtures under `test-support/fixtures/` record the exact source capture and time
window from which they were decimated. The timing-MLCC 0.65–1.10 effective-capacitance scale
and the K6 temperature guard are explicitly labelled engineering assumptions because the vendors expose
typical curves rather than guaranteed production extrema.

`npm run test:monte-carlo -- <seed> <samples>` explores uniformly sampled interior watchdog values and
prints its seed plus fastest/slowest samples. It must stay inside the deterministic extremes, but it is a
diagnostic only: reproducible named extremes, not random coverage, are the release gate.

## Scope / limits

Validates **design intent and the explicitly modeled fitted-part envelope** — loading/impedance, RC time
constants, sense thresholds and switch topology. It still does not predict semiconductor analog behavior
with SPICE precision, derive unguaranteed temperature/DC-bias distributions, model EMI, contact bounce,
PCB parasitics or fabrication variation. Seeded sampling cannot turn an engineering bound into a vendor
guarantee; first-board measurements remain required where `VERIFICATION.md` says so.
