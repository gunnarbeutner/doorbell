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

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Line-4 hold-time:** does **P4 → P1** hold ~12 V through the *talk window*, not just the
      ring? Listen needs the relay to stay pulled in. Measure idle / ringing / mid-talk-window.
- [ ] **Door-opener firing threshold** — the linchpin test. Bridge P2↔P3 with (a) a **dead
      short** and (b) **2.2 kΩ**; does each fire the TV20/S opener? Expected (per the genuine
      handset): short fires, 2.2 kΩ does *not*. This confirms the choices already in the design —
      **R_ot→0** (K2 door needs a short, done) and **2.2 kΩ-on-K1** (R16; talk's incidental bridge
      must *not* fire, done).
- [ ] **ET button gating:** which physical terminal gates line 5 (Etagenruf) on this unit.
- [ ] **C1 polarity** (+ assumed toward P5).
- [ ] **(Nice-to-have) confirm the audio model** end-to-end: Etagenruf direct on line 5; gong
      DC→coil / AC→C1→speaker (expect **no** cone offset); talk mic→C1→P4→R1→line 3; listen
      line 2→relay→P4→C1→speaker.

## Firmware (`firmware/doorbell-v4.yaml`)

- [ ] **Session-active rework:** derive "session active" from the **Türruf (OC1) event + ~25 s
      talk-window timer**, then re-add it as a second arm of the K3 gate and the cross-talk masks
      (both are PTT-only now that the hardware session-sense is gone). Idle line 4 = 0 V confirmed
      there's no session voltage to sense, so a timer off the OC1 ring event is the way.

## Audio path — investigate (settle TX/RX routing before trusting the half-duplex path)

- [ ] **Outgoing (TX) audio path — confirm how/where injected audio reaches the door station.**
      The board injects on P1/P5 → C1 (P5↔P4) → line 4; K1 also asserts the talk strap IN_P4↔P3 via
      R16. With K3 now held off during PTT (line 4 continuous), bench-trace whether the door station
      actually hears it, and by which route: does it ride **line 4 to the central unit**, or only the
      **R16 strap to line 3** (the genuine S2/R1 path)? Inject a tone with PTT engaged and probe
      lines 3 and 4 (vs P1). Settles whether the R16 talk strap is even needed for TX, or whether
      keeping line 4 whole suffices. *(DESIGN.md: "TX-out reach")*
- [ ] **Incoming (RX) audio — investigate tapping P1↔IN_P4 instead of P1/P5.** Today RX captures on
      P1/P5 via T1, relying on the WF26's C1 to couple line-4 audio onto the speaker pair — so
      breaking line 4 (K3 suppress) also kills RX, making **gong-suppress and RX mutually exclusive**.
      A tap on **P1↔IN_P4** (the TV20/S-incoming side, *ahead* of K3) would see the incoming audio
      directly and **independently of K3**, letting the board capture while the handset gong is
      silenced. Bench-check the signal level/impedance on IN_P4↔P1 during a call vs the P1/P5 tap; if
      better, plan a re-tap (T1 / codec front-end) on the next board spin. *(DESIGN.md: "TX-out reach")*

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
