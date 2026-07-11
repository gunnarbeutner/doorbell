# TODO

Open work before ordering and commissioning V4.2. Canonical handset numbering is Pₙ = line n;
see `DESIGN.md` and `wf26/wf26-schematic.md` for the circuit model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **(V4.2 gate) Breadboard the passive split on the live bus — before ordering the respin**
      (verifies **BUS-2(a)/(b)** on the real TV20/S; the Ra/Cf/Rb leg is in the V4.2 schematic + PCB,
      sim-verified — `gong rejection`, `JP1 cut`, BUS-1 tests — with spectrum/levels capture-gated
      against `our-ring-no-door`; this gate owns the two things only the wall can answer:
      forwarded + ramp-assert).
      Runs against the **deployed V4.1 board** without pulling it from the wall, and doubles as the
      **TX-out-reach yes/no**. **Non-invasive rig** (wiring: `docs/design/breadboard-handshake-test.svg`;
      all via the screw terminals + a TX_OUT pad tap): `P2 → Ra (1.2 kΩ) → HS_FILT → Rb (1 kΩ) → P3`
      with `Cf (47 µF/25 V electrolytic, + toward HS_FILT) → P1`; bring the codec audio over with a
      `TX_OUT → P3` jumper and drive **`debug_test_tone` ON / `intercom_ptt` OFF** (bench config) so K1
      stays open (its ch1 raw-P2 tap — the gong path on V4.1 — never engages) while the DAC still
      reaches TX_OUT through the V4.1 board's always-wired `R26 → C14 → R28` chain. Board otherwise
      idle so every board-side P3 path stays open. **Checks:** ring the station, listen at the door → (a) **forwarded?** (#1 — the
      TV20/S's only unverified yes/no), (b) **gong-free?** (#3), (c) **talk asserts despite the ~25 ms
      RC ramp?** — the one thing the passive leg does that a switch press doesn't; an edge-sensitive
      talk-detect here is the OPA991 trigger. The electrical half — the filter strips an injected 1 kHz,
      the pedestal level — runs on the bench **off-bus** with a sig-gen (no wall). **Unclip after:** the
      rig is a standing 2.2 kΩ P2↔P3 strap — it holds "talk" asserted while clipped. **Decision:** all
      three pass → order the respin; (c) fails → the **OPA991** (`C2864555`,
      Mouser/Digikey/Farnell) buffered high-Z variant (`P2 → 100k → 100n → buffer → 2.2 k → P3`) — no
      follower step, a low-pedestal proxy no longer models anything we'd ship; (a) fails → the TX plan
      needs rethinking and no filter variant rescues it. **Design-for-rework on the respin regardless:**
      the split is purely additive and the Cf pair returns to GND through **JP1 (bridged solder
      jumper)**, so the fallback ladder is (1) retune — swap the Cf pair smaller for a faster assert
      (even 2×4.7 µF keeps the residual ~2 mVpp); (2) full revert — **cut JP1** and the leg degenerates
      to the **exact 2.2 kΩ strap** (Ra+Rb) = V4.1 with a step assert; re-arm the retained firmware
      gong-wait; blob JP1 to re-enable — a repeatable seconds-scale A/B, no parts touched. JP1 is why
      there is **no DNP direct-strap resistor**: the jumper has no illegal state (P2↔P3 stays 2.2 kΩ
      open or closed, whereas a populated strap ∥ Ra+Rb ≈ 1.1 kΩ would sit under the door-fire floor),
      and a damaged Ra/Rb chain is a pad-to-pad bodge, not a footprint. A #1 surprise stays a solder
      fix, not a spin. Bench BOM: Ra/Rb ¼ W + Cf 47 µF/25 V from bench stock;
      op-amp only if (c) fails.

- [ ] **Close the regulator-capacitance stability margins.** From the exact fitted MLCC datasheets,
      calculate U2's total effective +3V3 output capacitance and U4's effective input/output
      capacitance plus ESR at their DC bias, tolerance and temperature corners. Confirm the results
      remain inside the SGM2212 and LP5907 stability ranges; change the local bulk arrangement before
      fabrication if they do not.

- [ ] **Review U3 return-current layout before freezing the PCB.** Keep AVDD, VMID, ADCVREF and
      DACVREF capacitors and their returns tight to U3/U4; prevent ESP/USB/SSR currents from sharing
      the local analog return geometry; and make the analog-to-main-ground join deliberate. Consider
      the ES8311 guide's suggested DVDD bead, but prioritise a quiet, continuous return path over a
      split plane or optional I²C filter components that would worsen routing.

## Remaining hardware qualification

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Sustained Etagenruf stress — close the C19/C21/D1 qualification warning.** Drive the longest
      credible floor-call waveform and measure or simulate each anti-series electrolytic's voltage
      (including reverse voltage), ripple current and midpoint charge, plus D1 current. The exact RVT
      datasheet does not qualify bipolar/reverse-bias service; replace the pair with a qualified
      bipolar solution if the measured stress cannot be justified. Also watch for unintended K5
      movement and an objectionable LS1 impulse.
## Firmware (`firmware/doorbell.yaml`)

- [ ] **Retire the ring → welcome-audio gong-wait when the V4.2 board deploys.** The Ra/Cf/Rb handshake makes the
      greeting gong-free in hardware (BUS-2(a)), so wind `gong_until_ms`'s window to 0 — but **keep the
      code path** as the Cf-failure backstop (an aged/cracked-**open** Cf with no wait = the original
      bleed at full strike level; the failure signature is a gong audible at the door during
      greetings). Until the respin deploys, V4.1 keeps the wait; **interim option:** raise
      1750 → ~4200 ms to cover the measured ~3.9 s tail (`our-ring-no-door`: the 1.75 s expiry lands on
      the third Klang at ~3.6 Vpp ⇒ ~140 mVpp leaked onto P3 through V4.1's strap — empirically
      inaudible thanks to masking + pipeline latency, so optional). This is independent of the
      intentional no-greeting auto-open hold, which gives the visitor time to reach the door and stays.
- [ ] **Session-active = OC1 high.** Line 4 holds through the session, so **OC1 (the Türruf sense)
      stays asserted edge-to-edge — gate directly on OC1, no talk-window timer** (just debounce).
      Bench-confirmed on the emulated bus: OC1 asserts while the K5 latch holds and clears the
      moment it drops.
      Re-add this session arm to the K3 gate (`doorbell_sound_state`) and the cross-talk masks (both
      went PTT-only when the old session-opto was dropped; OC1 now supplies the session level).

## First-board commissioning (not fabrication gates)

- [ ] **Calibrate the V4.2 audio path on the installed board.** Confirm RX headroom and choose the final
      mic PGA; turn TX down to a natural handset level (V4.2 is about 6 dB hotter at the same codec
      setting); and listen for hum or an objectionable first-welcome onset transient. The committed
      divider and output protection are already bounded by simulation and bench measurements, so
      these checks tune firmware rather than decide the PCB. If the DAC cold-start is audible, keep K1
      open until the output settles; `docs/scope/welcome-chime-p3.png` records the V4.1 observation.
