# sim — schematic-driven circuit simulator

A transient circuit simulator with a browser PCB view. It **imports** `kicad/doorbell.kicad_sch`
and **simulates each component by a type-based model**. Nothing is baked: the netlist is read from
the KiCad files on demand.

## Use

```sh
cd sim
npm run dev      # incrementally builds host firmware, then serves http://localhost:8080
npm test         # all required circuit + firmware/HEAD tests
npm run test:circuit  # circuit-only tests against the live schematic
npm run test:firmware # deterministic ESPHome-host + live-HEAD circuit co-simulation
npm run test:firmware:scenarios # fastest rerun after config/build; scenarios only
npm run check:tv20s-calibration # verify evidence hashes and captured DC envelopes
npm run test:monte-carlo -- 1592639710 250  # optional seeded watchdog sensitivity diagnostic
```

`npm run dev` must finish the incremental `doorbell-host.yaml` build before the server listens. It
re-imports automatically when a `.kicad_sch` / `.kicad_pcb` changes — just reload. Importing needs
`kicad-cli` on `PATH` (KiCad's CLI; used for net connectivity).

There is deliberately no firmware/no-firmware mode. A `doorbell` browser session always gets its own
server worker, host firmware process, virtual clock, preferences directory and live HEAD circuit.
Both `doorbell` and `wf26` default to a synthetic, capture-calibrated TV20/S terminal model; select
`manual circuit lab` when arbitrary sources and components are needed. The `wf26` board remains a
passive reference-handset circuit with no MCU in either environment. Closing an idle browser session
releases its worker and firmware process; abandoned sessions expire server-side.

The page is a 3-column PCB view: `[controls + layer toggles + time cursor] | [selected copper layers,
stacked] | [scopes]`. In the default TV20/S environment, use the own-ring, neighbour-ring, floor-call,
neighbour-door and timeout controls. The model owns P1–P5 and composes the selected endpoint with a
second live-imported WF26 endpoint for the neighbour. In the manual lab, add **Sources** (drive any net with
DC/sine/square/step/pulse — each has an on/off toggle, off = the net floats, and an editable Thevenin
source impedance). Both environments use pause, 1×, 10×, maximum-speed or the 1 ms single-step. Ideal
sources on the same net conflict, and a source attached to a firmware-owned U1/U3 output must have
non-zero impedance. **Hover**
a trace → its net's voltage; **click** a trace → a scope on the right; the time-cursor slider scrubs the
instant shown on the board and the scope cursors. Colour is by voltage (fixed 0–Vmax scale) or by net.
Inner planes (In1/In2) show vias/pads only — zone fills aren't extracted yet.

## Layout

- `src/import.js` — KiCad → netlist object (node; shells out to `kicad-cli`, parses the `.kicad_sch` /
  `.kicad_pcb`, including MPN/LCSC/datasheet fields). Replaces the old `build.py`.
- `src/engine.js` — the simulation core (MNA transient solver); shared by session workers and tests.
- `src/corners.js` — fitted-part limits, explicit engineering assumptions and named deterministic corners.
- `src/ui.js` + `index.html` — remote browser front-end; renders server samples and submits controls but
  never creates an electrical stepper or manually programs U1/U3.
- `src/session-worker.js` — isolated per-browser circuit owner, virtual-time pacer, safety monitor and
  host-process lifecycle manager. Doorbell sessions reuse the deterministic firmware-test runner;
  WF26 sessions run the same TV20/S terminal environment around their passive circuit, or the manual
  lab when selected.
- `src/tv20s/` — captured-evidence manifest, terminal-equivalent calibration and the synthetic
  TV20/S state machine. Unsupported compositions throw with the missing evidence they require.
- `server.js` — HTTP/SSE session API, live KiCad import and static dev server (`npm run dev`).
- `test/` — integration tests + model-coverage and deterministic-corner gates (`npm run test:circuit`).
- `firmware-test/` — sequential host-firmware/circuit scenarios (`npm run test:firmware`).
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
- **ICs (ESP32, codec) — supply current (+ codec VMID):** generic digital I/O (I2S, USB and internal
  behavior) is **not** modeled, so they still render **red**; but their power draw
  *is* — each is an equivalent resistive load (`Ic`) from its supply pin to GND at a representative active
  current (ESP32 ~100 mA, ES8311 ~10 mA), which pulls through the LDO → +5V → Schottky → VBUS. The one
  analog exception: the ES8311's **VMID reference** (≈ AVDD/2) is modeled, because the mic front-end's
  divider/bias depends on it. In a doorbell session the host firmware exclusively supplies U1's four
  modeled output drivers and U3's bounded representative codec output; there are no manual IC controls.
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
constants, sense thresholds and switch topology. The TV20/S environment additionally reproduces the
captured idle/session/timeout terminal bias, own and one-neighbour ring/gong, floor call, direct door
bridge and recovery. A direct door bridge during the local endpoint's own gong composes those same
calibrated terminal equivalents, allowing the production auto-open timing to run without a special
DUT assumption. The documented 2.2 kΩ Talk handshake is supported as a terminal state, but the
TV20/S audio gain and remote acoustic path are not synthesized. It deliberately rejects other
intermediate P2–P3 impedances, multiple neighbours, overlapping bell types, door actions during a
neighbour/foreign gong and central-unit/opener-terminal faults; those need new evidence, not guessed
behavior. During stock WF26
Talk, `R1_BRIDGE` is connected to P3 on the low side of R1, so the terminal-equivalent model puts it
near 1 V while P4 retains the approximately 9.4 V session bias. This is not the main board's
`TALK_BRIDGE`: K1 holds that node directly at P2, with `TX_OUT`/P3 on the low side of R28. It still
does not predict semiconductor analog behavior
with SPICE precision, derive unguaranteed temperature/DC-bias distributions, model EMI, contact bounce,
PCB parasitics or fabrication variation. Seeded sampling cannot turn an engineering bound into a vendor
guarantee; first-board measurements remain required where `VERIFICATION.md` says so.

## Firmware/HEAD co-simulation

`./build.sh firmware-test` is the narrow firmware gate. It resolves the production and bench YAML,
incrementally builds `firmware/doorbell-host.yaml`, then starts a fresh host process, Unix socket and
preferences directory for every scenario. Production remains the installed V4.1 adapter; the host
adapter enables the expected HEAD/V4.2 K5-confirmed P4 isolation, physical-Talk hand-off and serialized
door-command/re-arm policy. Its candidate manual-conversation policy keeps K3 passive for up to 30 s
after physical-Talk release while K5 remains confirmed; K5 loss, smart TX or a door request ends that
window sooner. These behaviors are gating host scenarios without claiming that the changed functions
have passed fabricated-board tests.

The live KiCad import and passive powered-state operating point are cached only within one Node test process;
every scenario still gets a fresh firmware process, socket, preferences directory and independent copy
of the settled electrical state. The runner solves the DC target directly (capacitors open, inductors at
DC, discrete devices iterated to a stable topology), follows topology and waveform transients at
fine/medium/coarse steps, and jumps an interval only when live storage and discrete state agree with that
operating point within the solver tolerances. Numerical step horizons select resolution; they do not
declare a static circuit settled. The deliberately bounded representative codec waveform remains a
separate policy-test abstraction; after its documented exercise window, the remaining media duration
advances as policy-only time. Long greetings and timeout tests therefore retain virtual-time coverage
without repeatedly solving an unchanged nonlinear circuit.

`npm run test:firmware` remains the self-contained direct gate: it resolves production/bench and
incrementally builds the host target. After those inputs are already known-good, use
`npm run test:firmware:scenarios` for the shortest edit/rerun loop; `./build.sh firmware-test` performs
the validation/build itself and then uses that scenarios-only command, avoiding duplicate work.

The host binary replaces the stock host wall-clock and wake HAL with a 64-bit simulator-controlled
clock. `millis()` intentionally exposes its low 32 bits. Firmware and circuit exchange protocol-v1
newline messages over the per-test socket: firmware sends `HELLO`, ordered `WRITE`, `MEDIA`, `EMIT`
and `ADVANCE`; the runner replies with `AT` containing virtual time, raw input mask, ADC millivolts,
stop reason and queued commands. A version/mapping error, nonlinear-solver failure or stable voltage
in the ESP32 indeterminate region fails the scenario. Short analog transitions retain the previous
Schmitt state for at most 20 ms; remaining in the undefined band after that fails with net and voltage.

The runner imports `kicad/doorbell.kicad_sch` at runtime and checks U1 plus P1–P5 during handshake.
P2/P4/P5 DC, tone, pulse and captured-waveform sources use the measured nominal 90 Ω source
impedance. It carries capacitor, relay, SSR,
fuse and regulator state across adaptive timestep rebuilds, uses fine steps around topology/input
edges, and retries a hard source/clamp transition on a bounded smaller-timestep ladder before reporting
strict nonlinear non-convergence. A non-interactive host exit can remove U1 program drivers to model
reset/power loss. The fake media player derives duration
from each embedded WAV's actual metadata and drives U3 with a bounded representative tone while it is
active. Failures print a compact ordered timeline; detailed exploratory traces are not committed.

This fixture validates the electrical contract at the connector and firmware-observable HEAD nets. Its
TV20/S terminal model is tied to the named capture files and their recorded channel confidence; it is
not a model of unobserved central-unit internals, a substitute for the remaining real-bus checks, or
validation of a fabricated V4.2 board.

### Interactive virtual time

The interactive UI uses the same protocol and HEAD fixture. The server is the sole authority for
circuit state and ordered firmware writes. At 1×/10× it advances a wall-time-derived virtual horizon;
`max` advances bounded chunks as quickly as the solver and host scheduler permit. Pause leaves the
host blocked in `ADVANCE`, and `+1 ms` advances exactly one virtual millisecond. Firmware commands,
TV20/S stimuli and circuit/source edits made while paused are queued at the frozen boundary; repeated
lab-circuit edits collapse to the final configuration and are applied only by `+1 ms` or resume. Until
then the complete published snapshot—including voltages, storage state, environment state and floating
classification—remains unchanged. Full reset starts a clean circuit, host and preferences set.
**Freeze firmware** stops host execution while retaining the last U1/U3 GPIO and peripheral drive,
modeling a wedged MCU. The physical circuit continues in virtual time: in particular, a frozen-high
`DOOR_DRV` remains high while the independent Q3/RC watchdog releases K2. Reboot resets the program
outputs and starts a new host process at the same circuit time without resetting capacitor, relay, SSR
or fuse state.

Every source, extra element and switch edit is validated in the worker and rebuilt at its permitted
virtual-time boundary while carrying physical state. HTTP action completion acknowledges worker
completion, so pause/configure ordering does not depend on wall-clock timing. Samples, current injections,
safety events, firmware entities, media ownership and the ordered write timeline stream back over SSE.
The UI keeps a bounded display window; detailed deterministic assertions remain the job of
`npm run test:firmware`.
