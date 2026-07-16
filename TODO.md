# TODO

Open work before ordering and commissioning V4.2. Canonical handset numbering is Pₙ = line n;
see `DESIGN.md` and `wf26/wf26-schematic.md` for the circuit model.

Priority rates how important it is to get the item right for V4.2: **10/10** is essential to safety,
core function or long-term reliability; **1/10** is optional polish. It does not replace dependency
order—for example, some firmware work must wait for fabricated hardware regardless of its score.

## Pre-order gates

- [ ] **8/10 — Repeat the current V4.2 enclosure fit with the actual J1 plug and cable.**
      Export and print `fab/doorbell.step` from the final source, fit the board with real SW3/SW4
      and the fully seated SM04B-SRSS mating plug/cable, then close the lid. Verify H1/H2 seating,
      connector and cable clearance/bend/strain, both front-panel actuators' full travel, and J2 wire
      access. Record the export revision and result before approving the order; the earlier V4.2
      USB-C interference finding and V4.1 installed-board fit do not qualify HEAD.
      - **Worst case:** the assembled V4.2 board or service cable obstructs the Talk/door actuator or prevents the enclosure from closing, forcing a respin.

## Firmware (`firmware/doorbell.yaml`)

- [ ] **9/10 — Implement K5-confirmed P4 isolation only after a fabricated V4.2 board passes passive bring-up.**
      Keep the deployed V4.1 safeguards meanwhile: OC1 remains its session/ring input, the 1.45 s
      ring-to-audio `welcome_not_before_ms` guard remains enabled, and ring-to-open remains at least
      1.75 s. After confirming unpowered P4↔
      `K5_LATCH` continuity, K5 seal-in and JP2-open operation on V4.2, add GPIO4 `K5_SENSE_N` (active
      low) and GPIO48 `P4_ISO` (active high, forced low at boot). Debounce `K5_SENSE_N` for 5–10 ms,
      request isolation, wait K6's maximum opening time, reconfirm K5, then allow K1/playback. Loss of
      K5 must stop playback, release K1 and clear `P4_ISO`; keep raw OC1 for ring diagnostics. Only
      after installed-board validation may the ring-to-audio guard be retired for V4.2. Keep the
      1.75 s minimum ring-to-open deadline regardless of greeting selection.
      - **Worst case:** incorrect isolation sequencing drops the session or leaves welcome TX contaminated by P4 gong energy.

## First-board commissioning (not fabrication gates)

- [ ] **5/10 — Calibrate the V4.2 audio path on the installed board.** Confirm RX headroom and choose the final
      mic PGA; set TX to a natural handset level; and listen for hum or an objectionable first-welcome
      onset transient. The retained I²S path and DAC soft-ramp have removed the codec-start transient
      on the V4.1 bench board; on V4.2, verify that factory-bridged JP3 plus R38+R39 also remove the
      remaining K1/C14 bias step on the real bus. Cut and re-bridge JP3 only if an A/B diagnosis is
      needed. The divider and output protection are already bounded by simulation and bench
      measurements, so the remaining checks tune firmware and validate the changed V4.2 analog path.
      `docs/scope/welcome-chime-p3.png` records the earlier V4.1 observation.
      - **Worst case:** installed speech or welcome audio is too quiet, clipped, noisy or unpleasant to use.
