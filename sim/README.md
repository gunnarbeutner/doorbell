# sim — schematic-driven circuit simulator

A transient circuit simulator with a browser PCB view. It **imports** `kicad/doorbell.kicad_sch`
and **simulates each component by a type-based model**. Nothing is baked: the netlist is read from
the KiCad files on demand.

## Use

```sh
cd sim
npm run dev      # http://localhost:8080 — serves the UI; reads the KiCad files live for the netlist
npm test         # integration tests against the live schematic (Node's test runner)
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
  `.kicad_pcb`). Replaces the old `build.py`.
- `src/engine.js` — the simulation core (device models + MNA transient solver); shared by the UI and tests.
- `src/ui.js` + `index.html` — the browser front-end (imports `engine.js`, fetches `/netlist.json`).
- `server.js` — dev server (`npm run dev`); serves the UI and the live netlist.
- `test/` — integration tests + a model-coverage gate that fails if an active part isn't an explicitly reviewed model (`npm test`).

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
components (ref, lib, value, pins, pinfn).

**Device parameters are per-part** — derived from each component's part type/value (no global knobs):
diode Vf class by family (silicon `1N4148` ≈ 0.65 V, Schottky `SS14` ≈ 0.3–0.4 V, visible LED ≈ 1.9 V,
TVS by type: unidirectional forward-only, bidirectional anti-series with a standoff `vbr`, open across the
bus range); MOSFET `vth`/`Rds(on)` by part (`2N7002`); optocoupler LED + CTR (`PC817`/`LTV-217`);
transformer winding `L`/`k`/`Rdc` by part (`SM-LP-5001`: Rdc 115 Ω); relay coil resistance and pull-in
from the rated coil voltage in the value string (`DC12`, `4.5V`).

- **Auto-modeled from value + refdes:** R, C (polarized caps, `Device:C_Polarized` etc., are flagged in the
  status bar if they're ever reverse-biased — pin 1 = +), L, diode (KiCad `Device:D`: pin 1 = cathode, pin 2 = anode),
  speaker (→ R), fuse (→ short), **optocoupler** (standard 4-pin: LED diode 1→2 + CTR current source
  4→3 with a saturation clamp), **MOSFET/transistor** (gate-controlled switch, using the symbol's
  `G/D/S` pin functions), **regulator/LDO** (an IC with `VIN/VOUT/GND` pin functions → regulated
  output, floored at 0; target voltage parsed from the output net name, e.g. `+3V3` → 3.3 V; draws its
  output current back out of the input pin so the input rail loads down rather than supplying free power,
  and only regulates while its input is actually fed by a source — pull the supply and the board
  de-energizes instead of running forever off a charged cap), **transformer** (two coupled inductors + series winding Rdc),
  **ESD/TVS protection array** (e.g. `TPD2S017`: each channel passes IN↔OUT, with steering diodes that
  clamp the line to VCC/GND and a ~6 V VCC↔GND rail clamp — so a realistic surge through a source
  impedance clamps to ≈ VCC + Vf; an ideal 0 Ω source can't be clamped, as in reality).
- **Relays & switches** — pin-outs are **hard-coded per part type** (keyed on the symbol `lib_id`):
  Omron `G6K-2F` relay → coil 1/8, contacts COM3/NC2/NO4 + COM6/NC7/NO5; `SPPJ322300` DPDT switch →
  COM2/NC3/NO1 + COM5/NC6/NO4; tactile button → SPST 1–2; **solder bridges** (`SolderJumper`) → SPST,
  closed by default. **Relays are coil-driven** (energized when |V_coil| ≥ ~75 % of the rated coil
  voltage — drive the coil/gate to trigger; read-only state badge). **Switches & solder bridges** toggle
  manually. No configuration UI.
- **ICs (ESP32, codec) — supply current only:** their I/O (GPIO, I2S, USB, codec) is **not** modeled, so
  they still render **red** and signals through their pins aren't trusted; but their power draw *is* — each
  is an equivalent resistive load (`Ic`) from its supply pin to GND at a representative active current
  (ESP32 ~100 mA, ES8311 ~10 mA), which pulls through the LDO → +5V → Schottky → VBUS. Use **Extra
  elements** for anything else you want to add by hand.
- **Floating vs 0 V:** nets with no DC-conductive path to ground or a source are flagged **floating**
  (dashed grey on the board, "(floating)" in the tooltip) — distinct from a real 0 V net.

## Engine

Modified Nodal Analysis, Backward-Euler transient, Newton iteration (SPICE-style relative+absolute
convergence) for the per-part diode/opto models, all in `src/engine.js` (no DOM, importable by the
tests). `src/import.js` produces the netlist; `src/ui.js` is the browser front-end.

## Scope / limits

Validates **design intent** — loading/impedance, RC time constants, sense thresholds, switch-topology
changes — not device precision, EMI, or layout parasitics. v1 uses analytic stimulus only (capture-CSV
replay and coupled-inductor transformers are later iterations).
