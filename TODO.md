# TODO

Open work before ordering and commissioning V4.2. Canonical handset numbering is Pₙ = line n;
see `DESIGN.md` and `wf26/wf26-schematic.md` for the circuit model.

Priority rates how important it is to get the item right for V4.2: **10/10** is essential to safety,
core function or long-term reliability; **1/10** is optional polish. It does not replace dependency
order—for example, some firmware work must wait for fabricated hardware regardless of its score.

## Firmware (`firmware/doorbell.yaml`)

- [ ] **9/10 — Implement K5-confirmed P4 isolation only after a fabricated V4.2 board passes passive bring-up.**
      Keep the deployed V4.1 safeguards meanwhile: OC1 remains its session/ring input, the 1.45 s
      ring-to-audio `welcome_not_before_ms` guard remains enabled, and ring-to-open remains at least
      1.75 s. After confirming unpowered P4↔
      `K5_LATCH` continuity, K5 seal-in and JP3-open operation on V4.2, add GPIO4 `K5_SENSE` (active
      low) and GPIO48 `ISO_REQ` (active high, forced low at boot). Debounce `K5_SENSE` for 5–10 ms,
      request isolation, wait K6's maximum opening time, reconfirm K5, then allow K1/playback. Loss of
      K5 must stop playback, release K1 and clear `ISO_REQ`; keep raw OC1 for ring diagnostics. Only
      after installed-board validation may the ring-to-audio guard be retired for V4.2. Keep the
      1.75 s minimum ring-to-open deadline regardless of greeting selection.
      - **Worst case:** incorrect isolation sequencing drops the session or leaves welcome TX contaminated by P4 gong energy.

## First-board commissioning (not fabrication gates)

- [ ] **5/10 — Calibrate the V4.2 audio path on the installed board.** Confirm RX headroom and choose the final
      mic PGA; set TX to a natural handset level; and listen for hum or an objectionable first-welcome
      onset transient. The committed
      divider and output protection are already bounded by simulation and bench measurements, so
      these checks tune firmware rather than decide the PCB. If the DAC cold-start is audible, keep K1
      open until the output settles; `docs/scope/welcome-chime-p3.png` records the V4.1 observation.
      - **Worst case:** installed speech or welcome audio is too quiet, clipped, noisy or unpleasant to use.
