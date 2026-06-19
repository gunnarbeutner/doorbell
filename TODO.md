# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

All planned board changes are now in the KiCad files: K2 is a direct P2↔P3 short, the 2.2 kΩ (R16)
is on the K1 talk strap, the K3↔K1 interlock is gone (K1/K2/K3 independent), and the third
(session-sense) opto is gone — the two remaining bell-sense optos are **OC1** = house/Türruf and
**OC2** = apartment/Etagenruf. All matching the handset. **No open schematic/layout items remain**;
what's left is firmware + bench validation (below). ERC 0 errors; DRC clean (1 benign isolated-
copper thieving-zone warning).

## Audio refactor — SSR LED-drive resistors (`kicad/doorbell.kicad_sch`)

- [ ] **Verify the SSR LED-drive resistors R4/R5/R6 (300 Ω).** 300 Ω gives ~7 mA from the 3.3 V
      GPIO — confirmed adequate for **K3 / GAQY412EH** (recommended I_F 7 mA, operate ≤3 mA, per
      `docs/GAQY412E_EH_datasheet.pdf`). **Not yet confirmed for K1/K2 / GAQY212GS** (currently
      U4/U5): we only have the JLCPCB "30 mA" figure and don't know if that's the recommended forward
      current or an absolute max. Pull the GAQY212GS datasheet; if it wants more than ~7 mA, lower
      R4/R5 (or add a 2N7002 buffer per part). Pull-downs R7/R8/R9 (10 k, SAFE-6) are fine as-is.

## Audio refactor — session-independent TX (`kicad/doorbell.kicad_sch`)

- [ ] **Evaluate whether the board can TX without an active session.** K1.4 is tied to **P4**, so the
      talk handshake (`P4 → K1 → 2.2 kΩ → P3`) is only live while the WF26 latch holds a Türruf
      session — faithful to the handset and fine for the welcome-chime-before-auto-open case, but it
      blocks autonomous announcements (TTS, "leave it next door", etc.). Bench-test the TV20/S: when
      talk is asserted with **no session active**, does it forward the line-3 audio (and not
      misbehave / ring other stations)? If yes and we want it, the change is to source the handshake
      from the always-on **P2** instead (`K1.4 → P2` — a strict superset, same ~5 mA load). Ties into
      the TX-out-reach open item (REQUIREMENTS "Open questions" / AUDIO_REFACTOR bench item 3).

## Audio refactor — analog front-end (RX/TX) finalization (`kicad/doorbell.kicad_sch`)

Transformer-less codec path (Phase 5). Bus-side topology wired (TX: `OUTP→C14→TALK_BRIDGE`; RX:
`P2→C16→MIC1P`, `P1→C17→MIC1N`; `P1↔GND` bonded). Component-level choices still open:

- [ ] **RX: direct ES8311 differential input vs external in-amp.** Confirm the mic input is high-Z /
      differential enough to tap P2↔P1 directly; add an instrumentation amp / buffer if not (bench 5).
- [ ] **Mic-input bias network.** Bias MIC1P/MIC1N to `ES_VMID`; repurpose R24–R27 (currently on the
      dead `SEC_A`/`SEC_B` nets); set values per the ES8311 line-in reference design.
- [ ] **TX level + OUTN handling.** Match the WF26 mic-through-2.2 k drive (codec digital volume; do
      not overdrive the TV20/S amp); decide OUTP-only vs terminating OUTN; add a buffer/atten if needed.
- [ ] **SAFE-7 protection on the P2/P3 taps.** Series R + TVS clamp (> +12 V); DC-block cap ratings
      ≥ 25–50 V. Values/placement TBD.
- [ ] **Hum check** with the P1↔GND bond once RX is live (bench 6).

## WF26 replica refdes cleanup (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

- [ ] **Rename the `WF26_*` reference designators to standard KiCad refdes.** The embedded dumb-core
      WF26 handset replica uses prefixed, non-standard designators — `WF26_C1, WF26_K1, WF26_P4,
      WF26_P5, WF26_R1, WF26_S1, WF26_S2` — instead of the plain `<class><number>` form KiCad's
      annotator and the BOM/CPL exports expect. Re-annotate to unique standard refdes in their own
      number band so they don't collide with the board's own C/K/R/S parts, and give the P4/P5 bus
      pads a proper class (e.g. J or TP, not `P`). Update any DESIGN.md references; keep ERC/DRC clean.

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
      - **DESIGN.md** — the MCU row (`ESP32-C6-WROOM-1-N8` / C5366877 → MINI-1U-H4 / C20627095), the
        remaining WROOM-era pad numbers in the GPIO/pad table, and the PCB-antenna notes (RF-transparent
        region, copper keepout, antenna-edge fiducial under "Known minor items").
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
      `osci/capture.py` (DHO804 isolated, grounds on **P1**, 3 ch — IN_P4/P4, P2, P3) and write the
      usual `*.md` timeline. Use it to ground-truth (a) the real line levels during a call (P2 held at
      12 V, the line-4 session level, P3 in talk) and (b) the **mic-bleed-during-TX** question the sim
      raised: the handset (LS1→C1→P4→IN_P4) couples onto transmit line 3 through K1 pole-A's 2.2 kΩ
      handshake whenever **K3 is idle** — sim shows ~1.5 Vpp on P3 *and* in the codec's own ADC (louder
      than the codec's own ~0.9 Vpp TX), and it vanishes with K3 energised. Confirm whether a real call
      holds K3 and what the actual bleed is **before** encoding "codec TX needs K3 energised for handset
      isolation" as a sim regression test or in DESIGN.md.
- [ ] **Line-4 hold level (mostly settled):** line 4 *must* hold through the session (else the WF26
      relay drops and the handset goes dead), and V3 senses it fine — so it holds. Just confirm the
      hold level keeps **OC1 above its detection threshold edge-to-edge** (relay hold V < pull-in V),
      so OC1 is a clean session gate. Measure mid-talk-window P4→P1.
- [x] **WF26_K1 latch / session model — RESOLVED** (`osci/ring-20260617-195221.md`). Line 4 is the
      session: **station-driven and held** (~9.2 V, gong on the front), but only while the station
      senses the handset answering (the coil load) — floating P4 → brief ~0.4–1 s kick, no session.
      The **door-open terminates it**: the station senses the ÖT short on P2↔P3, fires the opener, and
      **drops line 4** (line 4 → 0 while P2 only sags to ~7 V, above the coil release — so it's the
      station's drive removed, *not* a P2 seal-in). DESIGN.md ("Bell signals" / "WF26 internal
      circuit") updated to match.
- [ ] **Suppress mid-session — teardown / RX-TX-during-suppress test (still open, now sharper).**
      With a call up, **energise K3** (break IN_P4↔P4) and watch whether the call survives (probe
      IN_P4 + P2 + P3). Since the session is **station-driven and presence-gated on the handset load**,
      breaking IN_P4↔P4 mid-call removes the load the station is holding on — so it may **drop the
      call**, i.e. **RX/TX would NOT survive gong-suppress**. DESIGN.md's "RX/TX survive gong-suppress"
      currently *assumes* they do — confirm or kill it. If suppress drops the call, the replacement
      board must keep its own load on IN_P4 (the dual-mode Türruf coil) to hold the session while
      muting the gong.
- [ ] **Door-opener firing threshold** — the linchpin test. Bridge P2↔P3 with (a) a **dead
      short** and (b) **2.2 kΩ**; does each fire the TV20/S opener? Expected (per the genuine
      handset): short fires, 2.2 kΩ does *not*. This confirms the choices already in the design —
      **R_ot→0** (K2 door needs a short, done) and **2.2 kΩ-on-K1** (R16; talk's incidental bridge
      must *not* fire, done).
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

## Audio path — bench-verify (the routing is wired; confirm it on hardware)

The codec is **re-tapped to the speech pair** in the schematic: one isolation transformer (T1), its
bus winding **steered by K1 pole B** — line 2 at rest (RX), line 3 when K1 is energised (TX), ref
line 1. Pole A still asserts the R16 2.2 kΩ line-4↔line-3 talk handshake. Independent of line 4 / K3,
so RX/TX survive gong-suppress. **Gated on OC1** (session = Türruf held; OC1 stays high, no timer),
direction by PTT. Coupling caps + series Rs unchanged; DAC and ADC share the one codec-side winding
(firmware mutes the idle direction). What remains is hardware confirmation:

- [ ] **Outgoing (TX) — confirm line-3 drive reaches the door + the handshake.** Bench: in a talk
      window, does T1 driving **line 3** get audio out to the door station, and is the **R16 2.2 kΩ
      line-4↔line-3 bridge** (K1 pole A) the only thing the TV20/S needs to switch to talk — or
      something more? A WF26's C1 + 16 Ω speaker always loads line 4, which is why TX drives line 3,
      not line 4 — check the line-3 drive level with that load present. *(DESIGN.md: "TX-out reach")*
- [ ] **Incoming (RX) — confirm the line-2 tap level/impedance.** RX is on **line 2** (ref line 1),
      independent of line 4 / K3. Bench-check the received level and source impedance on line 2↔P1
      during a call, and that the R26/R27 divider lands the codec input in range.
      *(DESIGN.md: "TX-out reach")*
- [ ] **Validate the handset mic (LS1) never bleeds into the RX/TX path by accident.** LS1-as-mic
      must reach the line *only* when intended (deliberate handset talk via S2) — never leak into the
      codec's transmit (line 3) or receive (the codec ADC) on its own. The sim found one accidental
      path: with K1 in **talk** and **K3 idle**, the mic rides `LS1→C1→WF26_P4→J3→P4→K3(NC)→IN_P4` and
      onto P3 through **K1 pole-A's 2.2 kΩ handshake** (~1.5 Vpp on P3 *and* in the codec's own ADC,
      louder than the codec's ~0.9 Vpp TX); energising K3 kills it (the only hop to P3 is gated by K1
      pole-A, so with K1 idle there's no bleed at all). Sweep mic injection at LS1 across
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
- [ ] **(Future, replacement variant) fold session-sense into the Türruf relay, drop OC1.** Make
      the dumb-intercom relay a **12 V DPDT, coil on IN_P4↔P1**, with a spare pole = 3V3→GPIO +
      pull-down for a galvanically-isolated session/ring signal — replaces OC1 (+ its limiter, D8).
      **Not adopted** — OC1 works; keep it for now. Bench caveat: parallel-mode coil draws ~15 mA
      alongside the external WF26's. *(DESIGN.md: "Dual-mode variant — Add: the passive WF26 core")*

## Relays → SSR (investigate)

- [ ] **Determine which relays (K1 talk, K2 door-short, K3 chime-suppress; possibly the dumb-core
      WF26_K1) could be replaced with SSRs.** Per relay, check:
      - **Signal is bidirectional** — audio on lines 2/3 (K1) is AC, and the bus/door pulse (K2) and
        line-4 gong DC+tone (K3) can swing either way, so only a **bidirectional MOSFET-output
        PhotoMOS** (e.g. AQY21x / TLP24x) qualifies — **not** an AC-only triac/SCR SSR (those latch
        on DC and can't switch line 4 or the door short).
      - **Pole count** — confirm how many poles each relay actually uses (K2 looks like a single
        P2↔P3 short; K3 a single series break in line 4; K1 the talk strap). A 1-pole use maps to one
        PhotoMOS; any DPDT function that switches two things at once needs two devices or a topology
        change.
      - **Voltage / current / Ron** — the door-opener current through K2 and the 12 V bus must stay
        within the device rating, and on-resistance must not degrade the audio level or the door pulse.
      - **Isolation** — must preserve the bus↔logic galvanic barrier the relays currently provide.
      Trade-off: SSRs are silent, contactless (no wear), need no coil/flyback, and are smaller — but
      are single-pole, have higher Ron and some leakage, and cost more per pole. (WF26_K1 is passively
      ring-driven and fail-safe when unpowered; only swap it if an SSR keeps that property.)
- **Unpowered default state is the deciding axis** (reinforced by "S1/S2 + the unit must work with the
  ESP dead"): an SSR is normally-**open**, so it only suits a relay whose de-energised state is open.
  **K1/K2** are open-when-idle and their unpowered function is carried by the parallel manual switches
  (S2 talk, S1 door) → SSR-friendly. **K3** must *pass* line 4 when unpowered (relay **NC**) or the
  gong/station goes dead with no power → a plain SSR breaks fail-safe; K3 stays a relay.
  *(DESIGN.md's relay-table row already reached this — K3 needs the NC contact, K2's land can refit to
  a dead-bugged SOP-4 PhotoMOS. Its "no second board spin is planned" premise no longer holds, so the
  question is genuinely reopened for the WF26-replacement board.)*

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
