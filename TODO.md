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

## V4 main board — mechanical / enclosure fit (`kicad/doorbell.kicad_pcb`)

Board widened to 64 mm to match the WF26 PCB; zones re-poured. Remaining enclosure-fit work:

- [ ] **Add tooling holes.** Pre-place 1.152 mm tooling holes (JLCPCB's SMT-fixture size, through a
      ~1.55 mm pad on both outer layers) at controlled positions, so JLCPCB's CAM doesn't drill its
      own where they'd foul the antenna edge or a part keepout. On the V3 proto JLCPCB added holes
      near the antenna and west of T1 — see DESIGN.md "Known minor items (accepted)".

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Line-4 hold level (mostly settled):** line 4 *must* hold through the session (else the WF26
      relay drops and the handset goes dead), and V3 senses it fine — so it holds. Just confirm the
      hold level keeps **OC1 above its detection threshold edge-to-edge** (relay hold V < pull-in V),
      so OC1 is a clean session gate. Measure mid-talk-window P4→P1.
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

## Audio path — investigate (settle TX/RX routing before trusting the half-duplex path)

Direction: re-tap the codec off the speaker pair (P1/P5) and onto the **speech pair — RX P1↔P2,
TX P1↔P3 (ref line 1)** — speech is on 1/2/3, line 4 is only the gong — so the smart RX/TX become
independent of line 4 / K3 and keep working with the gong muted. **Gated on OC1** (session = Türruf
held; OC1 stays high, no timer), direction by PTT; **K1 retained for the talk handshake**. (The
station handset's own audio still rides line 4 and goes quiet when muted — fine, nobody uses the
handset then.) Half-duplex, so one isolation transformer switched between line 2 (RX) and line 3
(TX) by a relay pole, or two; re-route the existing coupling caps + series Rs.

- [ ] **Outgoing (TX) — drive line 3 directly + confirm the talk handshake.** Bench: in a talk
      window, does driving **line 3** (vs P1) get audio to the door station, and **how is the TV20/S
      told to switch to talk** (the 2.2 kΩ line-3 bridge, or something else)? Settles whether the
      R16/K1 strap is needed for TX or whether driving line 3 + the handshake suffices.
      *(DESIGN.md: "TX-out reach")*
- [ ] **Incoming (RX) — tap line 2, not the speaker pair.** The listen voice is on **line 2** (ref
      line 1), independent of line 4 / K3. Re-tap the codec from P1/P5 to line 2 so RX survives gong-
      suppress (the P1/P5 tap dies when K3 breaks line 4). Bench-check level/impedance on line 2↔P1
      during a call. *(DESIGN.md: "TX-out reach")*
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
