# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **(V4.2) Status LED — remaining tails.** The active-low IO3 status LED is now wired in the
      schematic + PCB and verified (D6 cathode → `STATUS_LED` → U1 IO3; **R27** 1 kΩ pull-down → GND;
      anode kept on R15 → +3V3; ERC/DRC/schematic-parity all clean, LED fully routed). Left to do:
      **(1)** firmware — ESPHome `status_led` on **GPIO3** (`inverted: true`): blink on WiFi/API loss,
      dark when healthy; **(2)** DESIGN.md — move IO3 in the strapping note from "unconnected" to the
      status LED (its JTAG-source strap is eFuse-gated, so repurposing it is safe). **Interim, until the
      V4.2 board is installed:** the deployed V4.1 board's D6 is hardwired and still leaks — keep black
      tape over it.
- [ ] **Isolate the two VBUS power sources (J1 USB-C + J3 wall feed) — deferred, no board room.**
      J1 (USB-C, bench/flash) and J3 (the SH wall-feed, `J3.1`) both drive the raw **`VBUS`** net in
      parallel with **no isolation**: if both are powered at once — e.g. opening the cover to flash via J1
      while the wall charger feeds J3 — the two 5 V sources back-feed each other (chief risk: the laptop's
      USB port driven by the charger). **Current mitigation = usage rule:** only one power source connected
      at a time (unplug the wall feed before flashing via J1, or flash in-place via J3's far end). USB
      **D±** is already fine — J1/J3 share D5's flow-through ESD clamp; this is the **VBUS power side only**.
      **Deferred because the clean fix doesn't fit** — ~7 new parts with nowhere to place them. Options when
      revisited:
      1. **TPS2116 power-mux** (LCSC **C3235557**, sym `Power_Management:TPS2116DRL`, fp
         `Package_TO_SOT_SMD:SOT-583-8`, both stock) — best: ~0 V drop (42 mΩ), reverse-current blocking,
         auto priority; leaves F1/D10/D5/D4 untouched downstream. Hookup (VIN1 = J1 priority):
         **MODE→VIN1**, **PR1** = divider `VIN1→300k→PR1→100k→GND` (VREF 1.0 V ⇒ ~4 V switchover),
         **VIN2 = J3** (fallback — not threshold-gated, so its cable sag can't false-switch),
         **VOUT (pins 2,7) → VBUS**, **ST (8)** NC, **CIN1 = CIN2 = COUT = 1 µF**. Add a **TVS on VIN2**
         (SMF5.0A) since the mux now sits ahead of D10 and is only ~±2 kV HBM. ≈ mux + 2 R + 3 C + TVS = 7.
      2. **Two-diode front OR** — a series Schottky in each of J1/J3 merging at VBUS (keeps F1/D10/D5
         downstream protecting both); the two OR diodes make **D4 redundant → remove D4**. Net **+1 part**,
         single Schottky drop. Fewer parts than the mux but a ~0.45 V drop. One diode alone won't do it:
         protecting a laptop on J1 from a charger on J3 needs a diode in **J1's** branch too.
      Both keep both connectors behind the front-end protection (F1 fuse, D10 TVS, D5 ESD). *(DESIGN.md
      "Power tree")*
- [ ] **(V4.2) Reverse-polarity: make a miswired J3 non-destructive (must not blow F1).** Today a
      reversed feed pops F1 (pull board, reswap, replace the SMD fuse) — realistic on the hand-spliced
      J3 pigtail; J1 is keyed and can't reverse. **Root cause is D10, not F1:** SS14 already blocks the
      reverse feed to the logic non-destructively, but **D10 is a *unidirectional* TVS (SMF5.0A) — a
      forward diode at −5 V**, so it conducts GND→D10→F1 and blows the fuse; **D5's VCC** on the same
      VBUS_F node conducts its GND→VCC ESD diode too. **Fix (minimal, keeps every safety property):**
      1. **Swap D10 → bidirectional SMF5.0CA** (same SOD-123FL footprint, part-number change only). A
         bidirectional 5.0 V TVS conducts only above its ~6.4 V breakdown in *either* direction, so a
         standing −5 V (5 V < 6.4 V) **doesn't conduct → F1 survives**, while the positive
         breakdown/clamp — and thus the **overvoltage crowbar fail-safe** — is unchanged (a gross
         reverse, e.g. −12 V, still crowbars F1, which is the wanted response). Also clamps negative
         transients now.
      2. **Reroute D5's VCC bias from VBUS_F to +5 V** (behind SS14) so D5 is isolated on reverse
         (VCC ~4.6 V past the Schottky, in range) — a trace move, no new part. Or confirm D5's negative
         abs-max tolerates −5 V.
      Keep SS14. Net: reversed 5 V feed = board unharmed, F1 intact; overvoltage/short/transient
      protection and SAFE-7 containment all preserved. **If the TPS2116 mux (item above) lands instead,
      use a P-FET ideal-diode *ahead of the mux* for the reverse block** — the TPS2116's VIN abs-min
      (~−0.3 V) can't survive −5 V itself, so reverse protection must precede it (and the P-FET also
      buys back SS14's ~0.4 V drop). Reverse-polarity and the two-source back-feed are orthogonal but
      share this front-end — sequence them together (reverse block → mux → clamp → LDOs). *(DESIGN.md
      "Power tree")*
- [ ] **(V4.2) Investigate a vertical (top-entry) USB-C receptacle for J1 (e.g. LCSC C5156600).** The
      present J1 is a horizontal board-edge USB-C; once the board is mounted in the wall enclosure that
      edge faces the wall and the port is unreachable, so a USB reflash means un-mounting the board. A
      vertical receptacle points the port up out of the board face so it's reachable in place — makes
      USB **recovery** flashing viable without pulling the board (OTA stays the primary reflash path).
      Check: the vertical body clears the enclosure lid **and stays out of the button travel envelope —
      not just the buttons' rest position but their full pressed-down depth** (the same buttons whose
      gap D6 leaks through descend toward the board when pressed); the north-edge USB routing still fans
      out cleanly (IO19/IO20 → D5 ESD → J1); and C5156600's footprint + stock in the JLCPCB lib. Doesn't
      change the J1/J3 back-feed rule (that's the power-mux item above) — still one source at a time
      unless the TPS2116 lands too. *(DESIGN.md "Power tree" / USB)*
- [ ] **(V4.2) DRC punch-list — remaining exclusion decisions** (6 violations left; the via-vs-In1
      clearance turned out to be a stale zone fill — refilled + saved, clear — and the `/K4_LED` stub
      is deleted): **(1) re-exclude** the two the refill/edits invalidated (`doorbell.kicad_pro` went
      7 → 5): the isolated `thieving_F_float` at (16.4, 16.2) — route.py's sliver policy already
      accepts it — and the H4 silk-over-copper. **(2) decide** the 4× J1 pad↔own-NPTH hole-clearances —
      footprint-intrinsic on unchanged geometry that fabbed clean as V4.1 (DRC-engine drift), so
      exclude with a comment or accept. **Consider hardening `build.sh`:** add `--schematic-parity` to
      its DRC call and fail on violations — the current gate would not have caught a stale board
      against the new schematic.
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

## Audio refactor — analog front-end (RX/TX) finalization (`kicad/doorbell.kicad_sch`)

Transformer-less codec path (Phase 5). Bus-side topology + the RX attenuator/bias are wired and
committed (RX: `P2→C16→R30(22k)→MIC1P` with `R33(3.3k)→VMID`, symmetric on MIC1N via C17/R31/R32;
TX: `OUTP→R26(2.2k)→C14→TX_OUT`, handshake `P2→Ra/Cf/Rb→TX_OUT`; `P1↔GND` bonded; VMID decoupling
C12 = 10 µF). Remaining open:

- [ ] **RX divider trim (bench-confirm).** 22k/3.3k (≈−18 dB) is committed and lands the ±8.8 V gong at
      ~1.1 V, inside the ES8311 mic abs-max (~AVDD+0.3 = 3.6 V). The gong ≈ the loudest line-2 audio (V3),
      so −18 dB also bounds speech and the codec mic PGA + ~90 dB ADC SNR lift it to a usable level — the
      divider is sound; the bench just confirms the delivered ADC level and sets the PGA. Revisit Rb
      (2.2k → −21 dB / 4.7k → −15 dB) only if that confirm shows it. Tone-scale bench confirm done
      (two-board rig): measured ratio ≈ design −18 dB, ADC reads −25.7 dBFS at 0 dB PGA from a
      ~0.55 Vrms bus tone. Still open on the real bus: gong-scale abs-max headroom + the final PGA
      choice.
- [ ] **TX level (firmware turn-down / bench-confirm).** `OUTP → R26 (2.2 kΩ) → C14 → TX_OUT`;
      **OUTN parked** (`R16→C15→GND`, single-ended); R26 + D13 are the OUTP abs-max
      guard (sim B1). **No board change:** the WF26's talk is a passive 16 Ω transducer-mic (mV-class), so
      the codec's ~0.9 Vrms full-scale **overpowers it ~40-50 dB** — TX level is a firmware **turn-down**
      (set the codec digital volume so the TV20/S amp isn't overdriven), not a drive/buffer problem.
      R26 stays 2.2 kΩ (the D13 clamp limiter); note the V4.2 codec series halved (R26 alone vs the old
      R26+R28 = 4.4 kΩ) ⇒ **~+6 dB more bus level at the same digital volume — recalibrate on the new
      board**. Bench: set the
      codec volume to a handset-level talk (the real-test-call capture gives the target); *only if* the
      cut is so deep it costs DAC resolution, add a passive OUTP attenuator — still no op-amp.
      Bench reference (two-board rig): the ESPHome es8311 volume scale maps linearly to the DAC
      register with **0.75 = 0 dB**; above that is digital gain (up to +32 dB at 1.0) and clips —
      full-scale media at volume 1.0 distorts hard, ~0.8 is borderline. Calibrate talk level in
      the ≤0.75 range.
- [ ] **(V4.2) Welcome-audio onset step on line 3 — sequence K1 past the DAC cold-start (and confirm it
      even matters on-bus).** On the first greeting from idle the ES8311 output stage cold-starts, stepping
      through C14 onto line 3 as a large onset transient at the chime start — **delivered to the bus because
      K1 is already closed** (on_announcement raises PTT at playback start). Bench (off-bus, `doorbell2`):
      the step dips P3 ~**−1.5 V** and recovers over ~1 s; illustration `docs/scope/welcome-chime-p3.png`.
      Measured this session:
      - **It's the DAC output-stage (VMID) enable, not K1 and not the audio.** PTT alone (K1 make, no audio)
        moves P3 only ~−75 mV; toggling the DAC soft-ramp register shifts the step; the audio itself starts
        ~75 ms later (I²S startup gap). A cold analog enable step, coupled through C14.
      - **The DAC soft-ramp makes it worse — default it OFF.** REG0x37 ON ≈ −1480 mV vs OFF ≈ −1274 mV
        (~200–350 mV deeper across the pedestal): it fades the digital audio but stretches the analog DC
        excursion, so the `on_boot` 0x48 override is net-negative for this transient.
      - **It's a cold-start.** Play 1 ≈ −1.4 V; plays 2–5 ≈ −0.55 V (2.5× smaller), stable even at ~4.4 s
        spacing — codec warmth, not C14 charge. A keep-warm scheme is hard, though: the media_player stops
        the speaker every play, so `timeout: never` can't hold it warm (cold-start each greeting).
      - **K1 timing is the ~4× lever.** Warm-engage — hold K1 **open** through the cold enable (the step lands
        on the codec-side node, isolated from line 3 by ch2), then close it once settled — gives ~−333 mV vs
        the cold ~−1334 mV (reproducible).
      **Measurements above are the V4.1 topology (C14 on TALK_BRIDGE via R28) — re-derive on V4.2
      before spending anything:** C14 now lands on TX_OUT, where the Rb+Cf leg already terminates the
      node (τ ≈ Rb·C14 ≈ 1 ms into the 44 µF reservoir) — likely providing the settle path the proposed
      "bleed on TALK_BRIDGE→GND" was for, and the warm-engage lever (K1 open through the cold enable)
      still applies with the step landing on TX_OUT. The bus divide also still holds (R26 into the
      ~90 Ω bus ≈ ÷25), so even the cold −1.5 V likely lands in the low tens of mV in service —
      possibly a non-issue on the real bus. Confirm on
      the deployed board with the Silent greeting before spending parts. Firmware plays fine; this is polish.
      *(DESIGN.md: audio path / "TX-out reach")*
- [ ] **Hum check** with the P1↔GND bond once RX is live (bench 6).

## Bus protection & grounding (`kicad/doorbell.kicad_sch`)

- [ ] **Bus TVS — confirm the surge transient stays under the clamp; align the 3D models.** The per-line
      bidirectional TVS (H24VND3BA on D2/D3/D7/D12, P2–P5 → P1/GND) and the non-polar C19/C21 anti-series
      pair are placed and routed (DRC clean). Still open: (1) a **higher-bandwidth capture** of a ring/door
      onset — the 25–50 kSa/s captures undersample the fast switching edges, so confirm the true transient
      peak stays below the ~31 V breakdown knee (else step the standoff up); the prefab gate also flags this
      surge margin as unmeasured. (2) Align the imported 3D models (min-z = 0) + clear KiCad’s 3D cache.

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Record a real test call (full speech session) — do this before trusting the sim's talk /
      RX-TX model.** The existing captures cover the ring + door-open (`captures/runs/our-ring-door-open/notes.md`)
      but not a **call with audio**. Drive the genuine sequence: **pulse line 4 (P4) to initiate**,
      with **P2 held at +12 V for the whole call (at least)**, then talk/listen. Capture via
      `captures/capture.py` (DHO804 isolated, grounds on **P1**, 3 ch — P4, P2, P3) and write the
      usual `*.md` timeline. **Talk through the WF26 handset during the capture** — every existing P3
      trace is idle or a door-open bridge, so there is *no* TX-direction (voice-on-line-3) data yet.
      Use it to ground-truth (a) the real line levels during a call (P2 held at
      12 V, the line-4 session level, P3 in talk); (b) the **WF26's own TX drive on line 3 + the talk
      handshake DC** S2+R1 asserts — this is the **target level the codec must match** and the direct
      answer to whether the 2.2 kΩ bridge alone flips the TV20/S to talk (**derisks the TX-out-reach
      / TX-level items below before ordering the fab spin** — see "TX level + OUTN handling" and
      "Outgoing (TX)"); and (c) the **mic-bleed-during-TX** question the sim
      raised **on the V4.1 topology**: the handset (LS1→C1→K3(NC)→P4) coupled onto transmit line 3
      through the raw 2.2 kΩ handshake whenever **K3 was idle** — ~1.5 Vpp on P3 and in the codec's own
      ADC, vanishing with K3 energised. **The V4.2 Ra/Cf/Rb leg shunts this path's audio band** (same
      mechanism as the gong, ⇒ ~mVpp) — re-run the sim sweep on the new netlist; the "hold K3 for the
      whole call" rule is probably obsolete. Confirm on hardware **before** encoding either way as a
      sim regression test or in DESIGN.md.
- [ ] **Line-4 hold level (mostly settled):** line 4 *must* hold through the session (else the WF26
      relay drops and the handset goes dead), and V3 senses it fine — so it holds. Just confirm the
      hold level keeps **OC1 above its detection threshold edge-to-edge** (relay hold V < pull-in V),
      so OC1 is a clean session gate. Measure mid-talk-window P4→P1.
- [ ] **Suppress mid-session — confirm the call survives gong-suppress on the bench.** The session is
      held by the **handset's P2 seal-in** (the TV20/S only pulses line 4 ~1 s), so it does **not**
      depend on line 4 staying driven; and K3 sits in the **C1 path** (P4↔CHIME_C1), not line 4, so
      energising it mutes the gong **without breaking line 4 or the latch** — the session should
      survive by construction (C1 isn't in the latch path). Bench-confirm: with a call up, energise K3
      and check RX/TX keep working (probe P4 + P2 + P3).
- [ ] **Gong-mute timing — does K3 open inside the gong's pedestal→tone gap?** Measure the pedestal→tone
      gap (working assumption ≥~10 ms) and confirm a step-driven **K3 (GAQY412EH NC SSR)** opens within it
      so the first Klang is muted; scope where the chime becomes audible vs the pedestal rise. K3's own
      turn-off can't be isolated from the bus capture — step-drive it directly.
- [ ] **Door-opener firing threshold** — the linchpin test. Bridge P2↔P3 with (a) a **dead
      short** and (b) **2.2 kΩ**; does each fire the TV20/S opener? Expected (per the genuine
      handset): short fires, 2.2 kΩ does *not*. This confirms the choices already in the design —
      **R_ot→0** (K2 door needs a short, done) and **2.2 kΩ-on-K1** (Ra+Rb; talk's incidental bridge
      must *not* fire, done — and Cf only shunts, so the bridge never reads lower).
- [ ] **Firmware — retire the 1.75 s 'wait out the gong' door-open delay.** With K4+Q1 giving a hardware
      break-before-make, the held Türruf is never bridged onto line 3, so the `house_doorbell →
      delay: 1.75s → front_door_buzzer` mitigation is unnecessary. Removing it opens the door ~1.75 s
      sooner — confirm that's the wanted UX, then drop the delay.
- [ ] **Bench — confirm the door lead.** On the real board: a door-open drops K5 (session ends),
      and K2's make lands after the latch drop (no 12 V-DC/gong blip on line 3). Tune C18/R17 if the
      ~20 ms lead doesn't clear the actual latch-drop time.
- [ ] **(Nice-to-have) confirm the audio model** end-to-end: Etagenruf direct on line 5; gong
      DC→coil / AC→C1→speaker (expect **no** cone offset); talk mic→C1→P4→R1→line 3; listen
      line 2→relay→P4→C1→speaker.

## Firmware (`firmware/doorbell-v4.yaml`)

- [ ] **Retire the greeting gong-wait when the V4.2 board deploys.** The Ra/Cf/Rb handshake makes the
      greeting gong-free in hardware (BUS-2(a)), so wind `gong_until_ms`'s window to 0 — but **keep the
      code path** as the Cf-failure backstop (an aged/cracked-**open** Cf with no wait = the original
      bleed at full strike level; the failure signature is a gong audible at the door during
      greetings). Until the respin deploys, V4.1 keeps the wait; **interim option:** raise
      1750 → ~4200 ms to cover the measured ~3.9 s tail (`our-ring-no-door`: the 1.75 s expiry lands on
      the third Klang at ~3.6 Vpp ⇒ ~140 mVpp leaked onto P3 through V4.1's strap — empirically
      inaudible thanks to masking + pipeline latency, so optional).
- [ ] **Session-active = OC1 high.** Line 4 holds through the session, so **OC1 (the Türruf sense)
      stays asserted edge-to-edge — gate directly on OC1, no talk-window timer** (just debounce).
      Bench-confirmed on the emulated bus: OC1 asserts while the K5 latch holds and clears the
      moment it drops.
      Re-add this session arm to the K3 gate (`doorbell_sound_state`) and the cross-talk masks (both
      went PTT-only when the old session-opto was dropped; OC1 now supplies the session level).
- [ ] **OC1 PTT-mask — verify it's needed (bench).** The firmware masks OC1 (house bell) during board
      PTT to block a phantom ring → auto-open. The stated mechanism is **bench-unconfirmed and may be
      negligible:** K1 closed bridges P4↔P3 via the 2.2 kΩ Ra+Rb leg, but the K5 coil (~1.3 kΩ, P4↔P1)
      clamps P4 (P4 ≈ 0.32·V_P3 — needs P3 idling ≳ 8 V to reach OC1's threshold), OC1's 50 ms
      debounce already rejects audio-rate AC, and on V4.2 the Cf shunt strips the codec's AC from this
      path entirely. **Measure P3 idle bias and whether engaging
      PTT alone (no real ring) trips OC1.** If it doesn't, drop the mask — it currently also blanks a
      *genuine* ring that lands mid-PTT. (Comment in `doorbell-v4.yaml` House-Doorbell filter.)

## Audio path — bench-verify (the routing is wired; confirm it on hardware)

The codec taps the speech pair **transformer-less**: **RX** = a differential sense of line 2 through the
attenuating divider (`P2→C16→R30→MIC1P`, `P1→C17→R31→MIC1N`, each pin biased to VMID via R33/R32); **TX**
= the codec DAC → R26 (2.2 kΩ) → C14 (DC-block) → TX_OUT → line 3, with the gong-filtered talk
handshake (`P2 → Ra/Cf/Rb → TX_OUT`), both behind **K1**. Independent of line 4 / K3, so RX/TX survive
gong-suppress. **Gated on OC1** (session = Türruf held; OC1 stays high, no timer), direction by PTT.
What remains is hardware confirmation:

- [ ] **Outgoing (TX) — confirm line-3 drive reaches the door + the handshake.** Bench: in a talk
      window, does the codec driving **line 3** get audio out to the door station, and is the
      **2.2 kΩ (Ra+Rb) bridge** (gated by K1, RC-ramped ~25 ms) the only thing the TV20/S needs to
      switch to talk — or
      something more? A WF26's C1 + 16 Ω speaker always loads line 4, which is why TX drives line 3,
      not line 4 — check the line-3 drive level with that load present. **Derisk before fab:** the
      real-test-call capture (above) measures the WF26's own line-3 talk level + handshake DC with the
      true load present — get that first, then optionally inject a tone through a breadboard
      `DC-block + 2.2 kΩ` onto line 3 (real WF26 load on line 4) to confirm reach with no board.
      *(DESIGN.md: "TX-out reach")*
- [ ] **Incoming (RX) — confirm the line-2 tap level/impedance.** RX is on **line 2** (ref line 1),
      independent of line 4 / K3. Bench-check the received level and source impedance on line 2↔P1
      during a call, and that the R30/R33 (and R31/R32) divider lands the codec input in range.
      *(DESIGN.md: "TX-out reach")*
- [ ] **Validate the handset mic (LS1) never bleeds into the RX/TX path by accident.** LS1-as-mic
      must reach the line *only* when intended (deliberate handset talk via S2) — never leak into the
      codec's transmit (line 3) or receive (the codec ADC) on its own. On the **V4.1 topology** the sim
      found one accidental path: with K1 in **talk** and **K3 idle**, the mic rode
      `LS1→C1→K3(NC)→P4→latch→P2→K1` and the raw 2.2 kΩ strap onto P3 (~1.5 Vpp, louder than the
      codec's ~0.9 Vpp TX), vanishing with K3 energised. **The V4.2 Ra/Cf/Rb leg shunts this path's
      audio band** (same divider as the gong ⇒ ~mVpp expected) — re-run the sim sweep on the new
      netlist, then sweep mic injection at LS1 across
      {K1 idle/talk × K3 idle/energised × S2 released/pressed} with **P2 held at 12 V**, and assert P3
      and `ES_MICP/MICN` stay clean except in deliberate S2 talk. If the filter holds, the
      "hold K3 for the whole call" rule is obsolete — decide, then
      encode the surviving conditions as a sim regression test.
- [ ] **Re-check the DESIGN.md "TV20/S audio behaviour" section** — confirm the talk/listen/
      Etagenruf/Türruf routing it describes is still correct against the current model + bench
      findings (some of it predates the recent corrections). *(DESIGN.md: "TV20/S audio behaviour")*
