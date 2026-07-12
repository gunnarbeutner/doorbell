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

- [ ] **9/10 — Close the regulator-capacitance stability margins.** From the exact fitted MLCC datasheets,
      calculate U2's total effective +3V3 output capacitance and U4's effective input/output
      capacitance plus ESR at their DC bias, tolerance and temperature corners. Confirm the results
      remain inside the SGM2212 and LP5907 stability ranges; change the local bulk arrangement before
      fabrication if they do not.
      - **Worst case:** an unstable regulator causes resets, codec malfunction, persistent noise or component stress.

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

- [ ] **10/10 — Find why the physical Talk actuator cannot be pushed all the way in.** Check the actuator,
      enclosure and SW4/PCB alignment and travel for interference or a dimensional mismatch; confirm
      whether SW4 reaches its intended electrical state before the mechanical stop, and correct the
      responsible mechanical part or placement. This is independent of the P4/K5 bleed and electronic
      talk-handshake work.
      - **Worst case:** the Talk button cannot engage, disabling the handset's passive/manual transmit function.

- [ ] **10/10 — Upgrade D1 and close the sustained Etagenruf C19/C21/D1 stress warning.** D1 is both K5's
      flyback clamp and the unresisted clamp for negative P4 excursions coupled through C19/C21; the
      captured floor-call waveform therefore exercises it repetitively, not as a rare relay kick.
      Replace the 1N4148W with a footprint-compatible, low-leakage rectifier rated for at least 1 A
      and 40 V, using the exact ordered-part datasheet. Then drive the longest credible floor-call
      waveform and measure or simulate D1 peak/RMS current plus each anti-series electrolytic's
      voltage (including reverse voltage), ripple current and midpoint charge. The exact RVT sheet
      does not qualify bipolar/reverse-bias service; replace the pair with a qualified bipolar
      solution if the measured stress cannot be justified. Also watch for unintended K5 movement,
      source clipping and an objectionable LS1 impulse. Include D7 in this review: it is correctly
      connected from raw P4 to GND, but its fault-level TVS clamp does not by itself qualify the normal
      repetitive C19/C21/D1 waveform.
      - **Worst case:** repeated floor calls overheat or fail D1 or C19/C21, disabling handset functions or damaging the board.

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
