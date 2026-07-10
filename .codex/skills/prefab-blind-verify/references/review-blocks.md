# Review blocks

## Blindness rules

Blind agents may use only:

- `/tmp/prefab/doorbell.net`.
- `kicad/doorbell.kicad_sch`, limited to connectivity, component values, MPN, LCSC, and Datasheet
  fields. Ignore Description fields, comments, and schematic text as unverified claims.
- Datasheets and primary references under `docs/` selected by the authoritative part map.
- Measured bus stimuli and their notes under `captures/runs/`.

Blind agents must not read `DESIGN.md`, `REQUIREMENTS.md`, `VERIFICATION.md`, `TODO.md`,
`kicad/README.md`, `sim/README.md`, `sim/test/`, `prefab-report.html`, or prior review output.

Resolve parts by functional role rather than trusting a reference designator supplied by a question.
Enumerate every part matching the role. Read brands and ratings from the mapped PDF, never memory or a
better-known similarly named part. Treat captures as actual signals traversing a closed path, not
merely as voltage envelopes. Show Ohm/Kirchhoff and transfer calculations. Do not edit files.

## Questions

### Power chain and rail integrity

Trace USB power through every series protection element and regulator to every powered IC, including
secondary analog rails and filters. Derive actual pin voltages, worst-case current and series drops;
compare every supply with the exact datasheet range.

### Absolute-maximum sweep

For every pin of every active IC, determine whether normal measured bus operation or a single
bus-line fault/miswire exceeds an absolute maximum. List computed and rated voltages for every risk.

### RX audio front-end

Trace bus lines 2 and 1 to the codec inputs. Apply the measured line-2 gong, compute input DC and AC,
and compare with codec absolute maxima and operating range.

### TX path and idle isolation

Trace codec DAC output to the talk line. Derive whether audio reaches it with the talk gate idle and
driven, and whether the talk line is high impedance at idle.

### Ring detection

For each bus-sense optocoupler, derive LED polarity and current over the measured bus range. Compare
with that exact optocoupler's ratings and guaranteed detection behavior.

### Door opener timing and watchdog

Derive make/break ordering and maximum on-time from the opener switches, FETs, and RC networks. Check
that break leads make and a stuck drive self-releases.

### Default-safe boot and unpowered states

With MCU drives at zero or floating, derive every SSR/relay output state. Check passive gong,
handset-latch seal-in, and that the door bridge remains open.

### Bus TVS sizing

Compare each bus TVS stand-off and clamp behavior with measured normal transients and the off-state
rating of downstream switches. Identify normal conduction or under-protection.

### SSR LED drive and GPIO fan-out

Using the MCU's guaranteed VOH at load, compute every SSR LED current against operate, recommended,
and absolute limits. Sum all loads sharing a GPIO and compare per-pin and aggregate drive ratings.

### Footprint and pinout correctness

For every non-trivial part, compare the schematic symbol pin-to-net assignment with the exact
datasheet pinout. Include ICs, regulators, connectors, SSRs, optocouplers, and polarized packages.

### Polarized-part orientation

Check every diode, opto/SSR LED, electrolytic or other polarized capacitor, and the claimed
bidirectionality of TVS parts against topology and exact datasheets.

### Analog and reference supply integrity

For every sensitive supply, reference, or filtered input, identify the dominant upstream aggressor.
Compute filter rejection across the actual band of interest and compare residual noise with the
signal or functional tolerance. Do not treat a ferrite's high-frequency impedance as low-frequency
rejection.

### Datasheet application conformance

For every active IC, enumerate datasheet typical-application and recommended/must guidance covering
decoupling, supply separation, reference filtering, grounding, series elements, and layout. Mark the
board PASS or DEVIATE for each item with exact citations and implemented values.

### Unintended-signal sweep

Inventory every switching contact and its idle/active state, every bus-driven latch, every measured
scenario source, codec source, and electro-acoustic source. Sweep reachable composed states and trace
each source to every bus line and analog input. Compute unintended versus intended level. Flag an
unintended contributor less than 20 dB below intended, or any unintended DC operating-point shift.

### State-transition transients

For every contact and source transition, derive capacitor precharge, instantaneous step, victim-node
divider, and settling time. Flag large shared-line/analog-pin steps, safety depending on unenforced
contact ordering, and unabsorbed enable/disable transients warned about by a datasheet.
