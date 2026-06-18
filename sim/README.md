# sim — neutral schematic simulator

A generic transient circuit simulator with a browser scope. It does two things and nothing
board-specific: **imports** `kicad/doorbell.kicad_sch` and **simulates each component by a
standard type-based model**. No knowledge of what any net or part *means* is encoded.

## Use

```sh
cd sim
python3 build.py          # imports the schematic, regenerates board-pcb.html
open board-pcb.html       # any browser; self-contained, no server
```

Re-run `build.py` after editing the schematic to re-import.

**`board-pcb.html`** is a 3-column PCB view: `[controls + layer toggles + time cursor] | [selected copper
layers, stacked] | [scopes]`. Add **Sources** (drive any net with DC/sine/square/step/pulse — each has an
on/off toggle, off = the net floats; multiple sources on one net superpose), set duration/dt, **Run**.
**Hover** a trace → tooltip with its net's voltage; **click** a trace → adds that net's scope on the right;
the time-cursor slider scrubs the instant shown on the board and the scope cursors. Colour is by voltage
(fixed 0–Vmax scale) or by net. Inner planes (In1/In2) show vias/pads only — zone fills aren't extracted yet.

## How components are modeled (by type)

**Both the classification and the parameters come from the device type, not the reference designator.**
`build.py` derives each component's *kind* from its symbol `lib_id` (library category / part name —
e.g. `…-Diodes:…`→diode, `…-Transistors:…`→MOSFET, `TPD2S017`→protection, `SM-LP-5001`→transformer),
falling back to the refdes-prefix convention only when the lib is unrecognized. So a part is modeled by
what it *is*, even if its refdes breaks convention (e.g. the `D5` ESD array is treated as protection,
not a diode).

**Device parameters are per-part** — derived from each component's part type/value (no global knobs):
diode Vf class by family (silicon `1N4148` ≈ 0.65 V, Schottky `SS14` ≈ 0.3–0.4 V, visible LED ≈ 1.9 V,
TVS forward-only); MOSFET `vth`/`Rds(on)` by part (`2N7002`); optocoupler LED + CTR (`PC817`/`LTV-217`);
transformer winding `L`/`k`/`Rdc` by part (`SM-LP-5001`: Rdc 115 Ω); relay coil resistance and pull-in
from the rated coil voltage in the value string (`DC12`, `4.5V`).

- **Auto-modeled from value + refdes:** R, C (polarized caps, `Device:C_Polarized` etc., are flagged in the
  status bar if they're ever reverse-biased — pin 1 = +), L, diode (KiCad `Device:D`: pin 1 = cathode, pin 2 = anode),
  speaker (→ R), fuse (→ short), **optocoupler** (standard 4-pin: LED diode 1→2 + CTR current source
  4→3 with a saturation clamp), **MOSFET/transistor** (gate-controlled switch, using the symbol's
  `G/D/S` pin functions), **regulator/LDO** (an IC with `VIN/VOUT/GND` pin functions → ideal regulated
  output, floored at 0; target voltage parsed from the output net name, e.g. `+3V3` → 3.3 V; ideal, so it
  doesn't draw input current), **transformer** (two coupled inductors + series winding Rdc),
  **ESD/TVS protection array** (e.g. `TPD2S017`: each channel passes IN↔OUT, with steering diodes that
  clamp the line to VCC/GND and a ~6 V VCC↔GND rail clamp — so a realistic surge through a source
  impedance clamps to ≈ VCC + Vf; an ideal 0 Ω source can't be clamped, as in reality).
- **Relays & switches** — pin-outs are **hard-coded per part type** (keyed on the symbol `lib_id`):
  Omron `G6K-2F` relay → coil 1/8, contacts COM3/NC2/NO4 + COM6/NC7/NO5; `SPPJ322300` DPDT switch →
  COM2/NC3/NO1 + COM5/NC6/NO4; tactile button → SPST 1–2; **solder bridges** (`SolderJumper`) → SPST,
  closed by default. **Relays are coil-driven** (energized when |V_coil| ≥ ~75 % of the rated coil
  voltage — drive the coil/gate to trigger; read-only state badge). **Switches & solder bridges** toggle
  manually. No configuration UI.
- **Still bare nodes:** real **ICs** (ESP32, codec) — no neutral model exists; render **red**. Use
  **Extra elements** for anything else you want to add by hand.
- **Floating vs 0 V:** nets with no DC-conductive path to ground or a source are flagged **floating**
  (dashed grey on the board, "(floating)" in the tooltip) — distinct from a real 0 V net.

## Engine

Modified Nodal Analysis, Backward-Euler transient, Newton iteration (SPICE-style relative+absolute
convergence) for the per-part diode/opto models. `build.py` is the importer; `board-pcb.template.html` is
the simulator + viewer (with a `__NETLIST_JSON__` placeholder); `board-pcb.html` is the generated,
self-contained result; `netlist.json` is the imported netlist.

## Scope / limits

Validates **design intent** — loading/impedance, RC time constants, sense thresholds, switch-topology
changes — not device precision, EMI, or layout parasitics. v1 uses analytic stimulus only (capture-CSV
replay and coupled-inductor transformers are later iterations).
