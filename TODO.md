# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

All planned board changes are now in the KiCad files: K2 is a direct P2↔P3 short, the 2.2 kΩ (R28)
is on the K1 talk strap, the K3↔K1 interlock is gone (K1/K2/K3 independent), and the third
(session-sense) opto is gone — the two remaining bell-sense optos are **OC1** = house/Türruf and
**OC2** = apartment/Etagenruf. All matching the handset. ERC 0 errors; DRC clean (1 benign isolated-copper thieving-zone warning).
Open layout items:

- [ ] **PCB: re-stamp the ten 10 k → R_0402 + reroute.** 0603 10 k (C25804) is out of stock at JLCPCB;
      the schematic is already restamped to **R_0402 / C25744** (R7/8/9/10/11/18/19/20/22/23 — all
      logic-side, ≤3.3 V). Do "Update PCB from Schematic" + reroute (0402 < 0603, drops into the space);
      the other resistor values stay R_0603.
- [ ] **PCB: place/route the dual K1 (GAQW212GS SOP-8) + R24 (ch2 LED) + TX_OUT net** — gated-TX layout;
      the schematic + sim are done (see "gated TX" below), only the layout remains.
- [ ] **Verify OC1/OC2 in JLCPCB's placement preview before ordering.** The per-footprint `ROT_FIX`
      (`kicad/jlcpcb_cpl.py`) now applies the +180 opto correction to OC1/OC2 — they were silently 0
      under the old dead `OK1-3` keys, so this is a 180° change worth eyeballing.

## Audio refactor — SSR LED-drive resistors (`kicad/doorbell.kicad_sch`)

- [ ] **Verify the SSR LED-drive resistors R4/R5/R6 (300 Ω).** 300 Ω gives ~7 mA from the 3.3 V
      GPIO — confirmed adequate for **K3 / GAQY412EH** (recommended I_F 7 mA, operate ≤3 mA, per
      `docs/GAQY412E_EH_datasheet.pdf`). **Not yet confirmed for K1/K2 / GAQY212GS** (currently
      U4/U5): we only have the JLCPCB "30 mA" figure and don't know if that's the recommended forward
      current or an absolute max. Pull the GAQY212GS datasheet; if it wants more than ~7 mA, lower
      R4/R5 (or add a 2N7002 buffer per part). Pull-downs R7/R8/R9 (10 k, SAFE-6) are fine as-is.

## Audio refactor — gated TX: replace K1 with a dual-NO SSR (`kicad/doorbell.kicad_sch`)

Solves the **BUS-1 idle load** and **session-independent TX** together. Today K1 (single 1-Form-A) gates
only the DC handshake (`TALK_BRIDGE ↔ P4`), so the codec sits **permanently** on line 3
(`OUTP → C14 → TALK_BRIDGE → R28 → P3`): a standing **~2.3 kΩ AC load on the *shared* talk pair** whenever
the codec is powered, and audio reaches line 3 with no session. **Muting the DAC does NOT remove the
load** — a muted output is still a low-Z node at VMID (an AC ground); only Hi-Z (a DAC power-down, heavier
than mute) or a hardware gate lifts it. Plus the handshake is sourced from **P4**, so it's only live
during a session (blocks autonomous TTS/announcements).

- [ ] **Replace K1 → GAQW212GS dual 1-Form-A NO (C7435123, SOP-8, 60 V).** *Schematic + sim done — only the PCB place/route (SOP-8 + R24 + TX_OUT) remains.* Imported to
      `kicad/lib_switches/gaqw212gs` + `sym-lib-table`. Both LEDs on **PTT_DRV** (no new GPIO/firmware):
      - **ch1 (LED 1/2, contact 7/8): `P2 ↔ TALK_BRIDGE`** — handshake gate, sourced from the **always-on
        P2** (not P4) ⇒ TX works **with or without a session**.
      - **ch2 (LED 3/4, contact 5/6): `TX_OUT ↔ P3`** — output gate. Split R28 to
        `TALK_BRIDGE → R28 → TX_OUT`, ch2 the final element ⇒ open lifts the codec off line 3 (and line 2,
        via ch1) — **zero standing load when idle**.
      PTT on ⇒ `P2 → ch1 → TALK_BRIDGE → R28 → ch2 → P3` (the 2.2 kΩ talk handshake) + codec audio; idle ⇒
      both open, TALK_BRIDGE floats with only the codec, both shared lines high-Z. **BOM delta:** the dual
      replaces the K1 single (+1 channel, no added package) + one 300 Ω LED-drive R for ch2 (the R7 10 k
      pull-down already covers both LEDs on PTT_DRV). LED→contact mapping confirmed (ch1 LED 1/2→contact 7/8,
      ch2 LED 3/4→5/6; modelled in `sim/src/components/Photomos.js`). **Side effects:** K1 no longer touches
      line 4 ⇒ the **OC1 PTT-mask** worry disappears (drop that mask), and the `TX idle isolation` sim test
      is now active and passing.
      Still open: whether a P2-sourced **no-session** handshake is actually forwarded = the **TX-out-reach**
      bench question — but the hardware now *enables* on-demand TX, which is the point.
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
- [x] **TX line-3 isolation (BUS-1) — met by the dual GAQW212GS (schematic + sim).** ch2 lifts the codec
      off line 3 at idle (no standing load), ch1 sources the handshake from the always-on P2. The
      `TX idle isolation` test (`sim/test/integration.test.js`) is now active and passing. (Mute ≠ no load
      — only the gate or a DAC Hi-Z removes it.) Bench-confirm the real idle load via the TX-out-reach item.
- [ ] **SAFE-7 protection on the P2/P3 taps.** C16 (on P2) sees **+16 V peak** (measured P2 max, ring4)
      plus fault transients → DC-block caps rate **≥ 50 V** (not the 6.3/16 V default at 1 µF 0603). Add a
      bidirectional TVS / clamp (> ±12 V) at the taps; the RX `Rs` (22 k, above) limits the clamp current.
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
      the USB ground **unfused** (F1 is on VBUS, not GND). Decide jumper vs merge vs soft-tie.
- [ ] **Further bus-interface transient/ESD protection (whole 5-way bus, not just the audio taps).**
      The exposed terminal feeds straight into the SSR FETs (K1/K2/K3, ~60 V Voff) and the opto LEDs;
      the only bus-side clamps today are small-signal 1N4148W (D1 coil flyback, D8/D9 opto reverse) —
      **no primary TVS**. SAFE-1 (MUST) wants surge/ESD tolerance on the terminals. Investigate a
      per-line TVS to P1/common at the connector: **bidirectional** (miswire/ESD both polarities),
      standoff above the working level but below the SSR Voff — **~15–16 V** (clears the ~12 V pedestal
      + gong + talk DC, clamps ~24 V; must sit **above +12 V** or it kills the handshake). Size the
      standoff off the *real* peak bus voltage — pull it from the `osci/` ring/door captures before
      picking a part. Low-speed bus ⇒ capacitance is a non-issue, so one robust TVS covers ESD +
      surge (no separate low-cap array). Subsumes the "SAFE-7 protection on the P2/P3 taps" item above.

## WF26 replica refdes cleanup (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [x] **Rename the `WF26_*` reference designators to standard KiCad refdes — DONE.** Their embedded
      digits + `_` broke JLCPCB's designator parser, so `WF26_K1/S1/S2/R1/C1 → K5/SW3/SW4/R29/C19` —
      both the refdes and the nets that embed them (`/WF26_K1_COM → /K5_COM`, …) — across the sch, pcb,
      sim, docs and firmware. The `wf26/` reverse-engineered original handset keeps its own names (its
      K1/S1 are the real device's). Bus lines P3/P4/P5 are J3 pins (no `P`-class refdes). ERC 0 errors.

## D5 refdes — `D` prefix on a powered IC (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **Reconsider D5's `D` reference designator.** D5 is a **TPD2S017** — a powered (VCC), 6-pin
      USB ESD-protection IC (CH1/CH2 in/out + VCC + GND), not a 2-terminal diode. By convention a
      powered multi-pin IC is **`U`**, not `D`; the `D` prefix makes refdes-keyed tooling (BOM class,
      the sim's component classifier) treat it as a plain diode. Re-annotate to `U` in its own number
      band if agreed; keep ERC/DRC clean and update any DESIGN.md / ORDERING.md references.

## V4 main board — mechanical / enclosure fit (`kicad/doorbell.kicad_pcb`)

Board widened to 64 mm to match the WF26 PCB; zones re-poured. JLCPCB tooling holes and the M3
mounting holes (H1/H2) are placed, each with a keepout. **No open enclosure-fit items remain.**

## Docs sweep — drop stale WROOM-1 / PCB-antenna references (DESIGN.md, ORDERING.md)

U1 is the ESP32-C6-MINI-1/U (u.FL external antenna) in the schematic, PCB, and firmware (parity
clean) — the module swap itself is complete. The docs still describe the old WROOM-1 (PCB-antenna)
module.

- [ ] **Update or delete every WROOM-1 / PCB-antenna reference left in the docs** — the schematic +
      firmware are the authoritative pin map, so the docs shouldn't restate it. A u.FL module has no
      PCB antenna, so the antenna-keepout / RF-transparent / antenna-edge notes are moot, not just stale.
      - **DESIGN.md — ✓ done:** MCU row (→ MINI-1U-H4 / C20627095), GPIO/pad table renumbered to the
        MINI-1U pads, and the PCB-antenna notes (now a u.FL external antenna, no keepout).
      - **ORDERING.md** — U1 part/LCSC (C6-WROOM-1 C5366877 → MINI-1U-H4 C20627095), the U1
        placement-check row, and the antenna-edge depanel/keepout gates.
      Where a reference merely duplicates the schematic/firmware, delete it rather than re-sync.

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Record a real test call (full speech session) — do this before trusting the sim's talk /
      RX-TX model.** The existing captures cover the ring + door-open (`osci/ring-20260617-195221.md`)
      but not a **call with audio**. Drive the genuine sequence: **pulse line 4 (P4) to initiate**,
      with **P2 held at +12 V for the whole call (at least)**, then talk/listen. Capture via
      `osci/capture.py` (DHO804 isolated, grounds on **P1**, 3 ch — P4, P2, P3) and write the
      usual `*.md` timeline. Use it to ground-truth (a) the real line levels during a call (P2 held at
      12 V, the line-4 session level, P3 in talk) and (b) the **mic-bleed-during-TX** question the sim
      raised: the handset (LS1→C1→K3(NC)→P4) couples onto transmit line 3 through K1's 2.2 kΩ (R28)
      handshake whenever **K3 is idle** — sim shows ~1.5 Vpp on P3 *and* in the codec's own ADC (louder
      than the codec's own ~0.9 Vpp TX), and it vanishes with K3 energised. Confirm whether a real call
      holds K3 and what the actual bleed is **before** encoding "codec TX needs K3 energised for handset
      isolation" as a sim regression test or in DESIGN.md.
- [ ] **Line-4 hold level (mostly settled):** line 4 *must* hold through the session (else the WF26
      relay drops and the handset goes dead), and V3 senses it fine — so it holds. Just confirm the
      hold level keeps **OC1 above its detection threshold edge-to-edge** (relay hold V < pull-in V),
      so OC1 is a clean session gate. Measure mid-talk-window P4→P1.
- [x] **K5 session *timeout* mechanism — confirm on the genuine handset.** **Session model (P2
      seal-in; door-open path bench-confirmed in `ring4`):** the TV20/S supply is on **P2**; it pulses
      **line 4** high for ~1 s to pull K5 in, after which the **handset holds line 4 hot itself**,
      sealed in from P2 (`P2 → S1 NC → K1_COM → the closed NO contact → line 4 → coil`) — so line 4 sits
      ~0.16 V below P2 (pulled up from it), and **dropping line 4 does NOT release it**. A **door-open**
      ends it: S1's break-before-make transfer opens P2↔K1_COM ~6 ms before bridging P2↔P3, so the coil
      drops (line 4 falls, P2 *rises* as the coil load comes off it — `ring4`). The sim confirms the
      hold (drop line 4 → stays in), the P2-low (timeout) release, **and** the S1 break-before-make
      release (`SW3` press drops the latch — the reference test). **Timeout confirmed = P2-low pulse (`ring-no-answer`):** a ~58.5 s session that ended on
      the timeout (no door-open) shows the TV20/S **sinking P2** — line 4 tracks 0.18 V under it (tied
      through the seal-in contact) then releases to 0 as K5 drops. The tell: **P2 holds ~2.8 V for ~18
      ms after line 4 has separated and fallen**, then snaps back — a *driven* low, not an unload. P3
      stays cold (no door-open). (Immaterial to the board anyway — OC1 sees line 4 fall either way.)
      DESIGN.md ("Bell signals" / "WF26 internal circuit") describes the model.
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
- [x] **DOOR-4: door-open releases the latch (mirror S1) — DONE in hardware.** **K4** (GAQY412EH NC SSR)
      in series in the `P2→K1_COM` seal-in (`SW3.6 ↔ K5.3`) drops K5 on a door-open;
      **Q1 (2N7002) + R17 (22 kΩ) + C18 (1 µF)** delay K2's make ~20 ms behind K4's break for a hardware
      break-before-make, all off the one `DOOR_DRV` gate. Sim updated: `SW3-release reference` and
      `DOOR-4: a board door-open releases K5` both pass; the gap tripwire is deleted. See DESIGN.md
      "Door-open mirrors S1".
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
      not line 4 — check the line-3 drive level with that load present. *(DESIGN.md: "TX-out reach")*
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

- [ ] **Drop the opto reverse clamps.** V3 runs both channels with no reverse diode and detects
      fine: **D8 (OC1 / line 4, DC) is droppable** outright; **D9 (OC2 / line 5, AC tone) is
      optional** — the tone does reverse-bias the LED, so D9 is the only one with a real (if
      V3-survivable) job. *(DESIGN.md: "Bell / session sense front-end")*
- [ ] **(Future) fold session-sense into the K5 latch, drop OC1.** Make K5 a **12 V DPDT,
      coil on P4↔P1**, with a spare pole = 3V3→GPIO + pull-down for a galvanically-isolated
      session/ring signal — replaces OC1 (+ its limiter, D8). **Not adopted** — OC1 works; keep it for
      now. *(DESIGN.md: "On-board passive WF26 core")*

## Relays → SSR — RESOLVED (done)

K1/K2/K3 are now **PhotoMOS SSRs**: K1/K2 = **GAQY212GS** (1-Form-A NO, bidirectional; the open-at-idle
fail-safe is carried by the passive S2/S1), K3 = **GAQY412EH** (1-Form-B **NC**, so the gong rings
unpowered). **K5 stays an electromechanical relay** — it's bus-self-latched and must work
board-dead, which an SSR can't do. The per-channel relay-driver sheet is retired (the SSR drive is just
LED + 300 Ω). See DESIGN.md "Switches (PhotoMOS SSRs)".

## Done (for reference)

- **V4 codec re-tapped to the speech pair (K1-steered)** — T1's bus winding moved off P5 onto a new
  net `/T1_BUS` = T1.4 ↔ K1.6 (pole-B COM); K1 pole B steers it: NC (K1.7) = P2 (line 2, RX at rest),
  NO (K1.5) = P3 (line 3, TX when energised). Pole A's R16 strap (IN_P4↔P3) still provides the talk
  handshake. TX injects on **line 3**, not line 4, because a WF26's C1 + 16 Ω speaker always shunts
  line 4 (~20–30 Ω). One transformer, no new relay/GPIO; codec-side wiring (SEC_A/B, R24–R27, C14–C17,
  ES8311) unchanged; DAC+ADC share the one winding (sidetone harmless for half-duplex PTT). Mounting
  symbols H1/H2 added in parallel. ERC clean. DESIGN.md updated. (Bench: "TX-out reach".)
- **V4 opto polarity switches (SW4/SW5) removed** — bus taken to drive active lines positive
  w.r.t. P1, so polarity is hardwired (LED anode → bus line: IN_P4 for OC1, P5 for OC2; cathode →
  R_lim → P1). Clamps (D8/D9), limiters (R1/R2), pull-ups (R22/R23) retained. Schematic + PCB
  updated; ERC 0 errors (pin_to_pin warnings 51→39), DRC clean. Confirm per-channel polarity on
  the bench by ringing each bell. Docs (DESIGN.md, ORDERING.md) updated to drop the switches.
- **V4 session-sense opto removed** — the third bell-sense channel (its opto + limiter + reverse
  clamp + polarity switch) deleted from `kicad/doorbell.kicad_sch` + `.kicad_pcb`; **U1 GPIO23 (pad
  21) freed**. ERC 0 errors, DRC clean (1 benign isolated-copper warning).
- **V4 opto rename + firmware cleanup** — bell-sense optos renamed **OK2→OC1** (house/Türruf, GPIO3)
  and **OK3→OC2** (apartment/Etagenruf, GPIO2); DESIGN.md + firmware comments remapped. The dead
  `intercom_session_active` sensor and its mask references were removed from the firmware (K3 gate +
  cross-talk masks are now PTT-only); `esphome config` valid.
- **V4 firmware — K3 held off during PTT/session** so line 4 stays continuous during talk
  (`doorbell_sound_state` returns true whenever PTT or a session is active → K3 off). Removes the
  firmware-side block on autonomous TX; dropped the obsolete `switch.turn_off: intercom_ptt`
  release-guard from `on_press`. (End-to-end TX audio still pending the outgoing-path bench check.)
- **V4 K3↔K1 hardware interlock removed** — K3's pole-B contact pulled out of Q1's gate drive; Q1
  driven straight from its GPIO. K3 pins 5/6/7 now unconnected; `GATE1` = Q1.1/R6.2/R9.1; the
  `GATE1_PRE` net is gone. K1/K2/K3 are now independent, like the genuine handset.
- **V4 U1 pad 18↔19 swap** — K1 (PTT) is now **GPIO20** (pad 18), K2 (door buzzer) **GPIO21** (pad
  19); K3 stays GPIO22 (pad 20). Firmware `output:` pins + header/inline comments updated to match.
- **V4 K2 door-opener — R_ot removed, K2 = direct P2↔P3 short** (matches genuine S1). Applied in
  `kicad/doorbell.kicad_sch` + `.kicad_pcb`: net `/P3` = J2.3, K2.3 (no OT_BRIDGE).
- **V4 K1 talk strap — 2.2 kΩ added as R16** (net `/TALK_BRIDGE`: K1.3→R16→P3, K1.4=IN_P4), so
  talk = IN_P4↔P3 through 2.2 kΩ (matches genuine R1). Routed at 0.5 mm; DRC clean (1 benign
  isolated-copper thieving-zone warning only).
- WF26 schematic: net swap → canonical Pₙ = line n; J1 pin reorder; **S1 = door release / S2 =
  talk** (re-annotated); `OT_BRIDGE` → `R1_BRIDGE`; internal notes rewritten; ERC 0/0.
- `wf26/wf26.kicad_pcb`: net swap applied (DRC 0/0).
- `wf26/wf26-schematic.md`: neutral readout in sync with the schematic.
- `DESIGN.md`: rewritten to the corrected model + the derived audio path; V4 R_ot / session-sense
  implications flagged.
- Removed the stale WF26 generator scripts (`wire_wf26.py`, `make_wf26.py`) — the KiCad files
  are authoritative.
