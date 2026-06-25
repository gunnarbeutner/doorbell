# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

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

## Audio refactor — analog front-end (RX/TX) finalization (`kicad/doorbell.kicad_sch`)

Transformer-less codec path (Phase 5). Bus-side topology + the RX attenuator/bias are wired and
committed (RX: `P2→C16→R30(22k)→MIC1P` with `R33(3.3k)→VMID`, symmetric on MIC1N via C17/R31/R32;
TX: `OUTP→R26(2.2k)→C14→TALK_BRIDGE`; `P1↔GND` bonded; VMID decoupling C12 = 10 µF). Remaining open:

- [ ] **RX divider trim (bench).** 22k/3.3k (≈−18 dB) is committed and lands the ±8.8 V gong at ~1.1 V,
      inside the ES8311 mic abs-max (~AVDD+0.3 = 3.6 V). Revisit Rb (2.2k → −21 dB more margin / 4.7k →
      −15 dB more level) only if a captured real voice level demands it — bench-gated against the
      measured ADC full-scale.
- [ ] **TX level.** Match the WF26 mic-through-2.2 k drive (codec digital volume; do not overdrive the
      TV20/S amp); add a buffer/atten only if needed. **OUTN is parked/terminated** (`R16→C15→GND`,
      single-ended off OUTP) and **R26 (2.2 kΩ) now sits in series at OUTP** for abs-max protection
      (sim B1), so the codec sees R26 + R28 ≈ 4.4 kΩ of source resistance into line 3 — fold that into
      the level target (drive level is firmware-soft via codec digital volume; the source-Z rise is
      not). Remaining fab-burning unknowns: the analog topology (R26/R28 values, buffer-vs-none) —
      capture the WF26's own line-3 talk level first (see "Record a real test call") for the target,
      and lay R26/R28/buffer out as reworkable.
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
      RX-TX model.** The existing captures cover the ring + door-open (`osci/our-ring-door-open.md`)
      but not a **call with audio**. Drive the genuine sequence: **pulse line 4 (P4) to initiate**,
      with **P2 held at +12 V for the whole call (at least)**, then talk/listen. Capture via
      `osci/capture.py` (DHO804 isolated, grounds on **P1**, 3 ch — P4, P2, P3) and write the
      usual `*.md` timeline. **Talk through the WF26 handset during the capture** — every existing P3
      trace is idle or a door-open bridge, so there is *no* TX-direction (voice-on-line-3) data yet.
      Use it to ground-truth (a) the real line levels during a call (P2 held at
      12 V, the line-4 session level, P3 in talk); (b) the **WF26's own TX drive on line 3 + the talk
      handshake DC** S2+R1 asserts — this is the **target level the codec must match** and the direct
      answer to whether the 2.2 kΩ R28 bridge alone flips the TV20/S to talk (**derisks the TX-out-reach
      / TX-level items below before committing a fab spin** — see "TX level + OUTN handling" and
      "Outgoing (TX)"); and (c) the **mic-bleed-during-TX** question the sim
      raised: the handset (LS1→C1→K3(NC)→P4) couples onto transmit line 3 through K1's 2.2 kΩ (R28)
      handshake whenever **K3 is idle** — sim shows ~1.5 Vpp on P3 *and* in the codec's own ADC (louder
      than the codec's own ~0.9 Vpp TX), and it vanishes with K3 energised. Confirm whether a real call
      holds K3 and what the actual bleed is **before** encoding "codec TX needs K3 energised for handset
      isolation" as a sim regression test or in DESIGN.md.
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
      **R_ot→0** (K2 door needs a short, done) and **2.2 kΩ-on-K1** (R28; talk's incidental bridge
      must *not* fire, done).
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

- [ ] **Session-active = OC1 high.** Line 4 holds through the session, so **OC1 (the Türruf sense)
      stays asserted edge-to-edge — gate directly on OC1, no talk-window timer** (just debounce).
      Re-add this session arm to the K3 gate (`doorbell_sound_state`) and the cross-talk masks (both
      went PTT-only when the old session-opto was dropped; OC1 now supplies the session level).
- [ ] **OC1 PTT-mask — verify it's needed (bench).** The firmware masks OC1 (house bell) during board
      PTT to block a phantom ring → auto-open. The stated mechanism is **bench-unconfirmed and may be
      negligible:** K1 closed bridges P4↔P3 via R28 (2.2 kΩ), but the K5 coil (~1.3 kΩ, P4↔P1)
      clamps P4 (P4 ≈ 0.32·V_P3 — needs P3 idling ≳ 8 V to reach OC1's threshold), and OC1's 50 ms
      debounce already rejects the codec's audio-rate AC. **Measure P3 idle bias and whether engaging
      PTT alone (no real ring) trips OC1.** If it doesn't, drop the mask — it currently also blanks a
      *genuine* ring that lands mid-PTT. (Comment in `doorbell-v4.yaml` House-Doorbell filter.)

## Audio path — bench-verify (the routing is wired; confirm it on hardware)

The codec taps the speech pair **transformer-less**: **RX** = a differential sense of line 2 through the
attenuating divider (`P2→C16→R30→MIC1P`, `P1→C17→R31→MIC1N`, each pin biased to VMID via R33/R32); **TX**
= the codec DAC → R26 (2.2 kΩ) → C14 (DC-block) → R28 (2.2 kΩ) → line 3,
with **K1** gating the talk handshake (`TALK_BRIDGE↔P4`). Independent of line 4 / K3, so RX/TX survive
gong-suppress. **Gated on OC1** (session = Türruf held; OC1 stays high, no timer), direction by PTT.
What remains is hardware confirmation:

- [ ] **Outgoing (TX) — confirm line-3 drive reaches the door + the handshake.** Bench: in a talk
      window, does the codec driving **line 3** get audio out to the door station, and is the **R28
      2.2 kΩ line-4↔line-3 bridge** (gated by K1) the only thing the TV20/S needs to switch to talk — or
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
      codec's transmit (line 3) or receive (the codec ADC) on its own. The sim found one accidental
      path: with K1 in **talk** and **K3 idle**, the mic rides `LS1→C1→K3(NC)→P4→K1→TALK_BRIDGE→R28`
      onto P3 (~1.5 Vpp on P3 *and* in the codec's own ADC, louder than the codec's ~0.9 Vpp TX);
      energising K3 (opening C1) kills it (the only hop to P3 is gated by K1, so with K1 idle there's
      no bleed at all). Sweep mic injection at LS1 across
      {K1 idle/talk × K3 idle/energised × S2 released/pressed} with **P2 held at 12 V**, and assert P3
      and `ES_MICP/MICN` stay clean except in deliberate S2 talk; then confirm the firmware rule
      (**hold K3 for the whole call** — see the Firmware item) actually suppresses it on hardware.
      Encode as a sim regression test once the real-call capture (above) backs the conditions.
- [ ] **Re-check the DESIGN.md "TV20/S audio behaviour" section** — confirm the talk/listen/
      Etagenruf/Türruf routing it describes is still correct against the current model + bench
      findings (some of it predates the recent corrections). *(DESIGN.md: "TV20/S audio behaviour")*
