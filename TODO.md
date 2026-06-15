# TODO

Open work, mostly fallout from re-deriving the WF26 handset model (canonical numbering Pₙ = line
n; door release = direct P2↔P3; talk = P4↔P3 via R1; relay coil = P1↔P4, ring-driven). See
`DESIGN.md` ("WF26 internal circuit") and `wf26/wf26-schematic.md` for the corrected model.

## V4 main board — schematic / layout changes (`kicad/doorbell.kicad_sch` + `.kicad_pcb`)

Two design premises were wrong; both flagged ⚠ throughout `DESIGN.md`.

- [ ] **K2 door-opener — drop `R_ot` toward a near-short.** The genuine door release (S1) is a
      **direct P2↔P3 short** (the same dead short the TV20/S test uses); `R_ot` (2.2 kΩ) is an
      *added* resistance, not a replica, and may not reliably fire the opener.
      **First** bench-confirm K2 fires the opener through 2.2 kΩ → if marginal/no, replace `R_ot`
      with ~0 Ω (jumper / DNP). *(DESIGN.md: Relays, "K2 door bridge")*
- [ ] **OC1 — drop or re-purpose (it's mis-targeted).** OC1 taps **P5↔P2** expecting the relay
      coil, but the coil is on **P1↔P4** — so OC1 senses Etagenruf↔listen-leg, not the session,
      and gives no clean "session active" signal. Coil-energised ≡ Türruf-present, so the session
      indicator is already **OC2 + a timer**; a dedicated coil sense is redundant.
      → On V4.1 remove the OC1 channel (opto + `R_lim3` + polarity switch SW5 + its clamp), or
      re-purpose it. *(DESIGN.md: Bell / session sense front-end)*
- [ ] **(Low-priority) K1 talk strap — the 2.2 kΩ actually belongs here.** Genuine talk is a
      **2.2 kΩ bridge of line 4↔line 3** (S2 + R1); K1 asserts a *direct* strap. A direct strap
      is likely benign (stronger talk assertion), but the faithful fix is to move the resistor
      from K2 (door) to K1 (talk): ~2.2 kΩ in series with K1's IN_P4↔P3 leg. Accept-or-add.
- [ ] **⚠ Autonomous remote-talk (TX) delivers no audio — re-architect (V4.1).** The board
      injects/captures only on **P1/P5** (T1 across P1↔P5), relying on the WF26's **C1** to couple
      the transducer to the bus. The old design assumed C1 = P1↔P2 (→ line 2, always live); the
      corrected model has **C1 = P5↔P4** (→ line 4). During virtual-PTT the **K3 interlock breaks
      line 4**, stranding the handset's P4 — so the injected audio (P5→C1→P4) never reaches the
      TV20/S (and with line 4 broken the coil drops, killing the line-2-via-relay path too). K1
      asserts the talk *handshake* (IN_P4↔P3) but no audio follows. ⇒ **RX (record/monitor) works;
      autonomous TX is broken.** *Manual* talk still works (resident holds the handset Sprechen
      button → P5→C1→P4→R1→S2→line 3). Likely fix: **stop breaking line 4 during talk** — drop the
      K3↔K1 interlock so K1's IN_P4↔P3 acts as **P4↔P3 at the handset** (line 4 continuous), letting
      the C1-coupled audio reach line 3; fold in the ~2.2 kΩ talk-strap (above); re-examine the
      door-opener-short safety the interlock gave. Bench-validate. *(DESIGN.md: Audio path / Relays)*
- [ ] **Virtual-PTT erratum (already-fabbed boards).** The fabricated V4 boards have K1 un-swapped
      → K1 ties **line 4↔line 2** (the wrong line — not the talk handshake line 4↔line 3). The
      bodge (cut K1 pad 4 off P2, jumper K1.4 → J2.3 = P3) fixes the *handshake line* — but per the
      TX item above, that alone still won't get audio out autonomously (the board stays
      **receive-only** until the line-4/interlock re-architecture). The swapped layout fixes the
      handshake line on the next fab. *(DESIGN.md: Relays, "Virtual-PTT erratum")*

## Bench measurements (settle the remaining open questions)

Use the DHO804 **isolated** — check its adapter is 2-prong, or run a battery/power-bank handheld;
ground clip on **line 1 (P1)** only, use **CH_A − CH_B math** for across-the-coil reads, and don't
tether it to a mains-earthed PC. Pair with a DMM.

- [ ] **Line-4 hold-time:** does **P4 → P1** hold ~12 V through the *talk window*, not just the
      ring? Listen needs the relay to stay pulled in. Measure idle / ringing / mid-talk-window.
- [ ] **Confirm K2 + R_ot fires the door opener** (gates the R_ot change above).
- [ ] **ET button gating:** which physical terminal gates line 5 (Etagenruf) on this unit.
- [ ] **C1 polarity** (+ assumed toward P5).
- [ ] **(Nice-to-have) confirm the audio model** end-to-end: Etagenruf direct on line 5; gong
      DC→coil / AC→C1→speaker (expect **no** cone offset); talk mic→C1→P4→R1→line 3; listen
      line 2→relay→P4→C1→speaker.

## Firmware (`firmware/doorbell-v4.yaml`)

- [ ] **Session-active:** derive from the **Türruf (OC2) event + ~25 s talk-window timer**, not
      OC1 (mis-targeted).
- [ ] Update / remove the cross-talk masking that referenced OC1.

## Housekeeping

- [ ] **(Optional) Normalize `wf26/wf26.kicad_pcb`** — it's a script-generated, non-standard
      name-only-net format; opening + saving once in the KiCad PCB editor rewrites it as a proper
      numbered-net board. Or leave as-is.

## Done (for reference)

- WF26 schematic: net swap → canonical Pₙ = line n; J1 pin reorder; **S1 = door release / S2 =
  talk** (re-annotated); `OT_BRIDGE` → `R1_BRIDGE`; internal notes rewritten; ERC 0/0.
- `wf26/wf26.kicad_pcb`: net swap applied (DRC 0/0).
- `wf26/wf26-schematic.md`: neutral readout in sync with the schematic.
- `DESIGN.md`: rewritten to the corrected model + the derived audio path; V4 R_ot / OC1
  implications flagged.
- Removed the stale WF26 generator scripts (`wire_wf26.py`, `make_wf26.py`) — the KiCad files
  are authoritative.
