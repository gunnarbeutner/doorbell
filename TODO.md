# TODO

Open work before ordering and commissioning V4.2. Canonical handset numbering is Pₙ = line n;
see `DESIGN.md` and `wf26/wf26-schematic.md` for the circuit model. The current KiCad sources are a
candidate, not a finalized or fabricated V4.2 board.

Priority rates how important it is to get the item right for V4.2: **10/10** is essential to safety,
core function or long-term reliability; **1/10** is optional polish. It does not replace dependency
order—for example, some firmware work must wait for fabricated hardware regardless of its score.

## Pre-order gates

- [ ] **8/10 — Repeat the current V4.2 enclosure fit with the actual J1 plug and cable.**
      Export and print `fab/doorbell.step` from the final source, fit the board with real SW3/SW4
      and the fully seated SM04B-SRSS mating plug/cable, then close the lid. Verify H1/H2 seating,
      connector and cable clearance/bend/strain, both front-panel actuators' full travel, and J2 wire
      access. Record the export revision and result before approving the order. V4.1 seats in the
      enclosure, but its fitted USB-C connector prevents SW4 from fully engaging; the current V4.2
      candidate removes that connector, yet neither that change nor the earlier printed fit qualifies
      the current HEAD.
      - **Worst case:** the assembled V4.2 board or service cable obstructs the Talk/door actuator or prevents the enclosure from closing, forcing a respin.

- [ ] **9/10 — Decouple GPIO4 sensing from the K6 LED return before ordering V4.2.**
      The current candidate connects K5's auxiliary NO contact, the K6 LED cathode and GPIO4 on
      `K5_SENSE_N`. A GPIO configured or failed low can therefore sink K6 LED current before K5 has
      pulled in, defeating the intended physical interlock when `P4_ISO` is requested. Keep the K5
      auxiliary contact directly in K6's return and isolate GPIO4 with a gate buffer rather than a
      passive divider: the earlier 4.7 kΩ/47 kΩ starting point could still pass about 0.4 mA,
      above K6's 0.1 mA guaranteed recovery current at 25 °C, while values large enough to approach
      the cold-temperature curve leave poor contact-wetting and input-impedance margins. The proposed
      implementation reuses an AO3400A: retain R35 = 10 kΩ from +3V3 to the renamed physical
      `K5_AUX_N` node and connect that node only to K5 auxiliary NO, K6 LED cathode and Q5 gate; Q5
      source goes to GND, while its drain reaches the separate active-high `K5_SENSE`/GPIO4 net through
      R44 = 1 kΩ and R45 = 10 kΩ pulls that GPIO net up to +3V3. Name the Q5-drain intermediate
      net `K5_SENSE_D`. Corner-check K6 LED reverse voltage, Q5 leakage and transitions, GPIO levels
      and output-contention current, then add simulator regressions that drive GPIO4 both low and high
      with K5 released and prove K6 stays closed.
      - **Worst case:** one GPIO configuration or pin fault suppresses the raw-P4 ring path, so K5 never pulls in and the passive handset misses a call while locally powered.

## Firmware (`firmware/doorbell.yaml`)

- [ ] **9/10 — Implement K5-confirmed P4 isolation only after a fabricated V4.2 board passes passive bring-up.**
      Keep the deployed V4.1 safeguards meanwhile: OC1 remains its session/ring input, the 1.45 s
      ring-to-audio `welcome_not_before_ms` guard remains enabled, and ring-to-open remains at least
      1.75 s. After confirming unpowered P4↔
      `K5_LATCH` continuity, K5 seal-in and JP2-open operation on V4.2, add GPIO4 `K5_SENSE` (active
      high through the proposed Q5 buffer; follow the final schematic) and GPIO48 `P4_ISO` (active
      high, forced low at boot). Configure GPIO4 strictly as an external-pull-up input with no
      internal pull or output mode. Debounce `K5_SENSE` for 5–10 ms,
      request isolation, wait K6's maximum opening time, reconfirm K5, then allow K1/playback. Loss of
      K5 must stop playback, release K1 and clear `P4_ISO`; keep raw OC1 for ring diagnostics. K6
      removes only this endpoint's raw-P4 contribution: do not treat K5 sense or isolation as a
      neighbour-busy detector, and do not claim that it suppresses audio already on shared P2. Only
      after installed-board validation may the own-P4 portion of the ring-to-audio guard be retired;
      retaining a conservative guard is acceptable for V4.2. Keep the 1.75 s minimum ring-to-open
      deadline regardless of greeting selection.
      - **Worst case:** incorrect isolation sequencing drops the session or leaves welcome TX contaminated by local P4 gong energy; shared-P2 neighbour audio remains an accepted bus limitation.

- [ ] **8/10 — Add and qualify GPIO47 physical-PTT sensing after the V4.2 hardware check below passes.**
      The candidate now implements active-low `PTT_SENSE_N` with R42/R43 and SW4 pins 1/2/3; it is
      independent of P4/K5 and mechanically opens K1's LED return while pressed. After validating
      the fabricated circuit, add the input to production and bench firmware using the fitted
      external pull-up (leave the MCU's internal pulls disabled), explicit active-low polarity and
      measured assertion/release debounce. Expose a bench diagnostic, command K1 off whenever
      physical Talk is asserted even though the hardware already inhibits it, stop the media player,
      clear `P4_ISO`, release K3 so the passive crossover is restored, and wait the measured K6/K3
      release interval before declaring manual Talk ready. Hold K1 off and keep the passive path
      restored through the entire press and a stable release debounce before allowing smart PTT or
      chime suppression again. Do not treat this switch state as proof of a session or as a
      neighbour-gong detector. Hardware does not force K3/K6 passive during a powered MCU stall; that
      rare loss of manual audio is accepted, while SW4 still excludes smart K1 and power loss restores
      normal passive operation.
      - **Worst case:** wrong polarity/debounce defeats manual-conversation policy, chatters K3/K1, or re-enables smart Talk during the physical switch transition.

- [ ] **9/10 — Serialize every production door command through one firmware coordinator.**
      Replace direct production access to `front_door_buzzer_bin` with a single script used by the HA
      button, auto-open, greeting/open actions and API actions. Before DOOR_DRV rises, stop/cancel
      playback, command K1 off and wait its release margin; clear `P4_ISO` and wait K6's maximum close
      time so breaking K5 cannot make a still-high raw P4 alternately repull K5 and reopen K6. Keep
      isolation clear until DOOR_DRV is low and K5 is inactive. Enforce at least 500 ms continuously
      low between door pulses so C18/Q3 fully re-arms the K4-before-K2 delay; coalesce or reject repeat
      requests during the active pulse and re-arm interval. Keep the bench's deliberate raw hold
      control diagnostic-only. Add simulator regressions for isolation + early door, K1 + door, and a
      rapid repeated command with a newly latched session.
      - **Worst case:** overlapping TX/door corrupts the shared speech pair, early door release makes K5/K6 chatter while raw P4 is high, or a rapid repeat bypasses break-before-make and the watchdog's intended re-arm.

- [ ] **8/10 — Replace the interim full-session K3 mute after a PTT-capable V4.2 board is fabricated and validated.**
      Production and bench firmware currently keep K3 open whenever chime suppression is effectively
      requested. This prevents a later neighbour gong on shared P2 from reaching LS1 through our
      sealed K5, but deliberately disables passive LS1 listen and the physical SW4 microphone in
      suppression mode. Keep smart TX independent of K3. Once the resulting board passes K5/K6 and
      SW4-sense/interlock bring-up and the GPIO47 input above is qualified, define and validate a
      manual-conversation state: decide when passive listening is intentionally restored, whether it
      persists for a bounded window after Talk is released, and how K1/K3/K6 transition without
      forwarding a gong. The PTT task above defines the minimum press/release hand-off; this task owns
      the longer-lived listening policy. Keep K1 commanded off across the entire physical-Talk window
      and release debounce even though SW4 also inhibits it in hardware.
      - **Worst case:** restoring passive audio recreates the neighbour-gong leak or a transition presents an unqualified ~1.1 kΩ P2↔P3 bridge.

## First-board commissioning (not fabrication gates)

- [ ] **8/10 — Validate SW4 physical-PTT sense and the K1 hardware interlock on fabricated V4.2 hardware.**
      Confirm the fitted switch orientation and actual housing actuator first. With logic power off,
      verify the passive pins 5↔4 Talk contact and R29 path still work. With local power on, measure
      `PTT_SENSE_N` high when released and about 0.30 V when pressed. Hold `PTT_DRV` asserted and
      prove that pressing SW4 opens both K1 output contacts even if the GPIO remains high. Finally,
      with K5 sealed, scope repeated press/release transitions at the K1 and R29 paths: the switch is
      non-shorting within each pole, but its datasheet does not guarantee relative pole timing, so
      require no interval in which the smart R28 and passive R29 handshakes conduct in parallel.
      Record voltages, debounce times and the worst transition before enabling the firmware policy.
      - **Worst case:** a wrong switch orientation or cross-pole overlap defeats sensing/interlock, loses passive Talk, or briefly presents ~1.1 kΩ instead of the intended 2.2 kΩ handshake.

- [ ] **5/10 — Calibrate the V4.2 audio path on the installed board.** Confirm RX headroom and choose the final
      mic PGA; set TX to a natural handset level; and listen for hum or an objectionable first-welcome
      onset transient. The retained I²S path and DAC soft-ramp have removed the codec-start transient
      on the V4.1 bench board; on V4.2, verify that factory-bridged JP3 plus R38+R39 also remove the
      remaining K1/C14 bias step on the real bus. Cut and re-bridge JP3 only if an A/B diagnosis is
      needed. The divider and output protection are already bounded by simulation and bench
      measurements, so the remaining checks tune firmware and validate the changed V4.2 analog path.
      `docs/scope/welcome-chime-p3.png` records the earlier V4.1 observation.
      - **Worst case:** installed speech or welcome audio is too quiet, clipped, noisy or unpleasant to use.
