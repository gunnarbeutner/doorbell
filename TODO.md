# TODO

Open work before ordering and commissioning V4.2. Canonical handset numbering is Pₙ = line n;
see `DESIGN.md` and `wf26/wf26-schematic.md` for the circuit model.

Priority rates how important it is to get the item right for V4.2: **10/10** is essential to safety,
core function or long-term reliability; **1/10** is optional polish. It does not replace dependency
order—for example, some firmware work must wait for fabricated hardware regardless of its score.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

V4.2 uses the field-proven R28/C14/K1 TX topology and K6 to disconnect raw P4 from the internal
`K5_LATCH` node after K5's auxiliary contact proves that the relay has pulled in. JP3 provides an
open-by-default recovery bypass. See `docs/design/k5-latch-isolation-plan.md`.

- [ ] **7/10 — Review U3 return-current layout before freezing the PCB.** Keep AVDD, VMID, ADCVREF and
      DACVREF capacitors and their returns tight to U3/U4; prevent ESP/USB/SSR currents from sharing
      the local analog return geometry; and make the analog-to-main-ground join deliberate. Consider
      the ES8311 guide's suggested DVDD bead, but prioritise a quiet, continuous return path over a
      split plane or optional I²C filter components that would worsen routing.
      - **Worst case:** shared return currents bake objectionable hum or digital noise into the fabricated audio path.

## Remaining hardware qualification

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **10/10 — Close the sustained Etagenruf C19/D1 stress qualification.** With K3 and K6 closed,
      the captured 681 Hz floor-call waveform couples from P5 through C19 onto `K5_LATCH`, making D1
      a repetitive rectifier as well as K5's flyback clamp. The fitted parts are Panasonic
      **EEEFK1H220P** (C128458, 22 µF/50 V, 123.8 mA at 120 Hz) and **1N4004W** (C18199087,
      1 A/400 V, 30 A surge), with D1's cathode on `K5_LATCH` and anode on P1/GND. Remaining work:
      - Drive a transient model with the recorded `floor-call-p5` waveform and include LS1, K5 coil
        resistance/inductance, realistic source impedance, capacitor tolerance/ESR and exact D1/D7
        models. Check K3/K6 closed and open states plus transitions during and after a tone.
      - Validate the worst closed/closed state on the bench: record D1 peak/RMS/average current,
        capacitor voltage and RMS current, and junction/case-temperature rise for a 60 s held call
        plus repeated 500 ms bursts. Require datasheet margin, no K5 pull-in or twitch, no material
        tone clipping, OC2 detection without an OC1 false event, and no normal-operation D7 clamp.
      - Extend the transient regression with the recorded waveform, then run `./build.sh verify`
        before removing this item.
      - **Worst case:** repeated floor calls overheat or fail D1 or C19, disabling handset functions or damaging the board.

## Firmware (`firmware/doorbell.yaml`)

- [ ] **9/10 — Implement K5-confirmed P4 isolation only after a fabricated V4.2 board passes passive bring-up.**
      Do not change the deployed V4.1 firmware meanwhile: OC1 remains its session/ring input and the
      1.75 s ring-to-welcome `gong_until_ms` delay remains enabled. After confirming unpowered P4↔
      `K5_LATCH` continuity, K5 seal-in and JP3-open operation on V4.2, add GPIO4 `K5_SENSE` (active
      low) and GPIO48 `ISO_REQ` (active high, forced low at boot). Debounce `K5_SENSE` for 5–10 ms,
      request isolation, wait K6's maximum opening time, reconfirm K5, then allow K1/playback. Loss of
      K5 must stop playback, release K1 and clear `ISO_REQ`; keep raw OC1 for ring diagnostics. Only
      after installed-board validation may the ring-to-welcome gong wait be retired for V4.2. Keep the
      separate no-greeting visitor-reach delay unchanged.
      - **Worst case:** incorrect isolation sequencing drops the session or leaves welcome TX contaminated by P4 gong energy.

## First-board commissioning (not fabrication gates)

- [ ] **5/10 — Calibrate the V4.2 audio path on the installed board.** Confirm RX headroom and choose the final
      mic PGA; set TX to a natural handset level; and listen for hum or an objectionable first-welcome
      onset transient. The committed
      divider and output protection are already bounded by simulation and bench measurements, so
      these checks tune firmware rather than decide the PCB. If the DAC cold-start is audible, keep K1
      open until the output settles; `docs/scope/welcome-chime-p3.png` records the V4.1 observation.
      - **Worst case:** installed speech or welcome audio is too quiet, clipped, noisy or unpleasant to use.
