# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **Verify OC1/OC2 in JLCPCB's placement preview before ordering.** The per-footprint `ROT_FIX`
      (`kicad/jlcpcb_cpl.py`) now applies the +180 opto correction to OC1/OC2 — they were silently 0
      under the old dead `OK1-3` keys, so this is a 180° change worth eyeballing.

## Audio refactor — SSR LED-drive resistors (`kicad/doorbell.kicad_sch`)

- [ ] **Verify the SSR LED-drive resistors R4/R5/R6 (300 Ω).** 300 Ω gives ~7 mA from the 3.3 V
      GPIO — confirmed adequate for **K3 / GAQY412EH** (recommended I_F 7 mA, operate ≤3 mA, per
      `docs/GAQY412E_EH_datasheet.pdf`). **Not yet confirmed for K1/K2 / GAQY212GS:** we only have the
      JLCPCB "30 mA" figure and don't know if that's the recommended forward
      current or an absolute max. Pull the GAQY212GS datasheet; if it wants more than ~7 mA, lower
      R4/R5 (or add a 2N7002 buffer per part). Pull-downs R7/R8/R9 (10 k, SAFE-6) are fine as-is.

## Audio — deferred SSR footprint save (`kicad/doorbell.kicad_sch`)

- [ ] **(Deferred) K3+K4 → one dual-NC PhotoMOS (GAQW412S, C7435125).** Would save one footprint (both are
      1-Form-B NC on independent gates — ch1 MUTE_DRV, ch2 DOOR_DRV). **Not adopted:** only ~23 in stock
      (niche, single-source) and these are the *fail-safe* NC switches — not worth tying bring-up to a thin
      line for a pure footprint save. Keep **2× GAQY412EH** (well-stocked, already in the design); the dual
      is a drop-in if stock ever justifies it.

## Audio refactor — analog front-end (RX/TX) finalization (`kicad/doorbell.kicad_sch`)

Transformer-less codec path (Phase 5). Bus-side topology wired (TX: `OUTP→C14→TALK_BRIDGE`; RX:
`P2→C16→MIC1P`, `P1→C17→MIC1N`; `P1↔GND` bonded). Component-level choices still open:

- [ ] **RX: attenuating bias network (measured from ring4 — mandatory, not just headroom).** ring4 CH2
      (= P2) shows the gong on line 2 peaks at **±8.8 V** (15.6 Vpp, 1.04 Vrms, on a ~9 V pedestal; P2
      absolute swing −1.7…+16.1 V), and the gong is the loudest event. **±8.8 V exceeds the ES8311 mic
      abs-max (~AVDD+0.3 = 3.6 V) by 2.4×**, so the bare `C16→MIC1P` tap AC-couples ±8.8 V into the codec
      and dumps ~50 mA into its ESD clamps every ring — attenuation + a series R is *required*, not a
      nicety. Add a divider+bias per side (R24–R27 are **gone** with the old transformer nets — these are
      NEW parts), matched for CMRR: `P2→C16→Rs(22k)→MIC1P`, `MIC1P→Rb(3.3k)→ES_VMID`; symmetric
      `GND→C17→Rs'(22k)→MIC1N→Rb'(3.3k)→VMID`. **−18 dB** (Rb/(Rs+Rb)) lands the 8.8 V peak at **~1.1 V**
      (≈8 dB under the ~2.8 V FS-peak, inside abs-max), gong ~135 mVrms; the PGA (0…+30 dB) brings quieter
      voice up. `Rs` doubles as the high-Z line-2 load (BUS-1) and current-limit (~0.4 mA on gong/fault);
      `Rb` biases the pins to VMID — the codec has **no mic bias** (user guide §5.5). Bump **VMID
      decoupling 1 µF → ~10 µF** (it now carries the bias-shunt AC). Tunable: Rb = 2.2k (−21 dB, more
      protection margin) / 4.7k (−15 dB, more level); revisit only if a real voice level is ever captured.
- [ ] **TX level + OUTN handling.** Match the WF26 mic-through-2.2 k drive (codec digital volume; do
      not overdrive the TV20/S amp); decide OUTP-only vs terminating OUTN; add a buffer/atten if needed.
      The drive level is firmware-soft (codec digital volume), so the only fab-burning unknowns are the
      analog topology (R28 value, buffer-vs-none, OUTN) — capture the WF26's own line-3 talk level first
      (see "Record a real test call") for the target, and lay R28/buffer/OUTN out as reworkable.
- [ ] **Hum check** with the P1↔GND bond once RX is live (bench 6).

## Bus protection & grounding (`kicad/doorbell.kicad_sch`)

- [ ] **Investigate P1↔GND bond options — it's currently a hard net merge.** `/P1` isn't a net; it's
      *merged* into GND (same copper), so the bond is irreversible without a respin. The bond is
      required for TX (the codec drives line 3 relative to P1) but is a SAFE-3 deviation justified by
      one install's ~0.5 V P1↔earth measurement. Options: a **default-closed solder jumper / 0 Ω**
      between separate `/P1` and `GND` nets (bonded by default; breakable on the bench, for a different
      install, or to run RX-only) plus a soft **~1 MΩ** bleed so `/P1` doesn't float when open; vs the
      RX-preferred soft-tie-only (no hard bond — but then TX needs another return). A hard merge blocks
      the hum A/B (bench 6), can't measure the P1↔earth offset in-circuit, and puts the bus common on
      the USB ground **unfused** (F1 is on VBUS, not GND). **Decided: kept the hard merge** (simplest,
      lowest-impedance TX return); the breakable option is a respin-free swap if the bench hum A/B (bench 6)
      ever needs it — a default-closed **0 Ω** (`C17888`) between separate `/P1` and `GND` nets plus a soft
      **1 MΩ** bleed (`C17927`) so `/P1` doesn't float when the 0 Ω is removed.
- [ ] **Bus-interface transient/ESD protection (whole 5-way bus) — per-line bidirectional TVS to P1
      at the connector.** Today's only bus-side clamps are small-signal 1N4148W (D1 coil flyback,
      D8/D9 opto reverse) — **no primary TVS**; SAFE-1 (MUST) wants surge/ESD tolerance on the terminals.
      **Measured envelope** (`osci/`, all captures, true volts): **≈ −11 V to +17 V.** P2 +12.1 V DC with
      **+16–17 V ring/door switching transients** (4 captures, few-sample); P4 0→+11 V pedestal (+15.5 V
      onset), −8.5 V; P3 +10.5 / −4.8 V; P5 ±8 V (−11 V 1-sample). Nothing > +18 V, no sustained DC > +12.1 V.
      The front-end already tolerates this (SSRs 60 V, optos R_lim + clamp, codec taps AC-coupled ≥ 50 V),
      so the TVS is **fault-only**: **~20 V standoff** (clears the +17 V transients so it's idle in normal
      use — a DC-only ~15–16 V pick would clip them), bidirectional (bus swings to −11 V + miswire/ESD),
      clamp ~32 V ≪ 60 V SSR. Low-speed bus ⇒ capacitance is a non-issue. **Discrete candidates** (all
      20 V / ~32 V clamp): **SMF20CA** (SOD-123FL, matches D10) `C2990488`; SMAJ20CA (SMA); SMBJ20CA (SMB).
      For **cramped J2**: shrink to **SOD-323** discretes and/or place them a short trace inboard (slow bus
      ⇒ lead inductance is irrelevant). **Array option:** no single 4-channel part fits — 4-ch arrays
      (e.g. TPD4E02B04) are 3.6–5 V data-line ESD, useless here. The only surge-rated multi-line part at
      this voltage is a 2-line CAN/RS-485 array: **2× SM24CANB-02HTG** `C151237` (24 V, IEC 61000-4-5,
      SOT-23, common pin → P1) covers the 4 lines in 2 small packages — trade-off is a ~50 V max clamp
      (still < 60 V SSR) and 2× Extended.
      **SAFE-2 (survive miswire, need not function):** the bidirectional TVS + bidirectional front-end
      already tolerate any line ordering; the one fix is **C19 → non-polar** (single NP electrolytic SMD is
      scarce on JLCPCB → use an **anti-series pair, 2× 47 µF/50 V** `C3349`/`C97806` ≈ 22 µF NP, or a THT NP
      can). **J2 keying is N/A** — J2 is a *fixed* PCB-mount screw terminal (DIBO DB125-3.5-5P,
      `C3646874`), not a pluggable block: there's no plug to key and no plug to insert reversed. Bare
      wires clamp directly into the soldered block, so the only miswire mode is a per-conductor scramble,
      which no connector feature can prevent. SAFE-2 rests entirely on the silkscreen labels (an installer
      aid, already present) + the survive-miswire topology above (bidirectional TVS/front-end + non-polar C19).
      **Chosen + imported:** TVS = **H24VND3BA** (`C20615815`, SOD-323, 24 V/31 V/50 V bidirectional,
      Preferred/free) → `kicad/lib_protection/h24vnd3ba` (+ sym/fp tables); C19 → non-polar **anti-series
      pair, 2× RVT1H470M0607** (`C3349`, Honor Elec, 47 µF/50 V — Economy-PCBA eligible; `C72523`/ROQANG is
      the identical part with higher stock but not Economy-eligible) → `kicad/lib_audio/rvt1h470m0607`. (TVS also exists
      in the installed `PCM_JLCPCB-Diodes` PCM lib if a repo-local copy isn't wanted.)
      **Placed & routed:** 4× H24VND3BA (D2/D3/D7/D12, P2–P5 → P1/GND) and the C19/C21 anti-series
      non-polar pair are in the schematic; board re-routed, DRC clean (0 errors). **Still open:** (1) a
      **higher-bandwidth capture** of a ring/door onset (25–50 kSa/s
      undersamples fast spikes — confirm the true transient stays below the ~31 V breakdown knee, else step the
      standoff up); (2) align the imported 3D models (min-z = 0) + clear KiCad's 3D cache. Subsumes the
      "SAFE-7 protection on the P2/P3 taps" item above.

## D5 refdes — `D` prefix on a powered IC (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **Reconsider D5's `D` reference designator.** D5 is a **TPD2S017** — a powered (VCC), 6-pin
      USB ESD-protection IC (CH1/CH2 in/out + VCC + GND), not a 2-terminal diode. By convention a
      powered multi-pin IC is **`U`**, not `D`; the `D` prefix makes refdes-keyed tooling (BOM class,
      the sim's component classifier) treat it as a plain diode. Re-annotate to `U` in its own number
      band if agreed; keep ERC/DRC clean and update any DESIGN.md / ORDERING.md references.

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Record a real test call (full speech session) — do this before trusting the sim's talk /
      RX-TX model.** The existing captures cover the ring + door-open (`osci/ring-20260617-195221.md`)
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
- [ ] **C1 polarity** — set **+ toward P4** (the Türruf +12 V DC side; + toward P5 would reverse-bias
      it through the held session). Schematic now reflects this; bench-confirm against the genuine unit.
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

The codec taps the speech pair **transformer-less**: **RX** = a differential sense of line 2
(`P2→C16→MIC1P`, `P1→C17→MIC1N`); **TX** = the codec DAC → C14 (DC-block) → R28 (2.2 kΩ) → line 3,
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
      during a call, and that the R26/R27 divider lands the codec input in range.
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

## Bell / session-sense simplifications (optional)

- [ ] **Drop D8 (Türruf clamp); KEEP D9 (Etagenruf clamp).** **D8 (OC1 / line 4, DC)** is one
      polarity with nothing to clamp — droppable. **D9 (OC2 / line 5) stays:** line 5's Etagenruf is
      an AC tone that reverse-biases the LED to ~−5 V, and the deployed **V3 board's Etagenruf opto
      died of reverse stress** (`osci/p5-chime-20260621-165156`) — so this LED avalanches below ~11 V
      and reverse-bias is its fatal mode, putting the ~5 V self-reverse too close to risk. D9 is one
      1N4148W of insurance. *(DESIGN.md: "Bell / session sense front-end", "V3")*
- [ ] **(Future) fold session-sense into the K5 latch, drop OC1.** Make K5 a **12 V DPDT,
      coil on P4↔P1**, with a spare pole = 3V3→GPIO + pull-down for a galvanically-isolated
      session/ring signal — replaces OC1 (+ its limiter, D8). **Not adopted** — OC1 works; keep it for
      now. *(DESIGN.md: "On-board passive WF26 core")*
