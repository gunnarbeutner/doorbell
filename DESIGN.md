# Doorbell controller (Klingel V4) — design reference

**What the board must do is in [`REQUIREMENTS.md`](REQUIREMENTS.md); this doc is *how* it does it.**
When the design changes in a way that affects behaviour, update REQUIREMENTS.md too.

**V4 source of truth: the KiCad files** (`kicad/doorbell.kicad_sch` / `kicad/doorbell.kicad_pcb`),
edited directly in KiCad. `./build.sh all-route` verifies them — the checks KiCad's own DRC/ERC
can't express (connectivity + the copper-thieving sliver limit in `route.py`, placement in
`check_pcb.py`) — and exports the fab outputs; it does not generate the board.
`kicad/doorbell_design.py` is the reference-data module the checks and BOM/CPL export import.
V4 firmware: `firmware/doorbell-v4.yaml`. LCSC part numbers: `kicad/doorbell_design.py` (`LCSC` dict for
parts whose symbol carries none or a stand-in's; the JLCPCB library symbols supply the rest) —
embedded in the schematic as hidden `LCSC`/`Description`/`MPN`/`Datasheet` fields and reused by
`kicad/jlcpcb_files.py` for the BOM.
Ordering: `ORDERING.md`. Reverse-engineered handset: `wf26/wf26.kicad_sch`.
Intercom system reference: `docs/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`;
central-unit photo: `reference/tv20s-board.jpg`.

V3 — the board currently deployed in the wall — is documented in its own section below
(sources: `docs/KlingelV4.fzz` Fritzing schematic, `firmware/doorbell-v3.yaml`, netlist via
`reference/extract_netlist.py` → `reference/netlist.txt`).

---

## System context

This is an interface board between an **STR TV20/S intercom system** and Home Assistant
(via ESPHome on an ESP32). The TV20/S is a 5-wire intercom bus powered by an NTR201
transformer (230 V → 12 VAC). The **WF26/G** is the apartment handset; this board **replaces** one,
carrying an on-board passive WF26 core so it still works with the board unpowered.

```
[NTR201 transformer]──12VAC──[TV20/S central unit]──5-wire bus──[WF26 handset(s) / this board]
                                      │
                                      └──8-12VAC, 1A max──[Türöffner / door opener]
```

The board taps the 5-wire bus (P1–P5) to:
1. **Sense** when bells are rung (lines 4 and 5 carry ~12 VDC bell signals)
2. **Trigger the door opener** by simulating the ÖT button press (bridge P2↔P3)
3. **Suppress the front-door (Türruf) chime** by opening the gong's coupling cap C1 (line 4 → speaker)
   — *without* breaking line 4 or the session, and *without* touching the apartment-door (Etagenruf)
   gong, which stays audible in every state
4. **Half-duplex audio**: an ES8311 codec taps the bus **speech pair** — RX a differential sense of
   line 2 (P2↔P1), TX driving line 3 (P3) through a DC-block + 2.2 kΩ gated by K1. No isolation
   transformer; **P1 is bonded to board GND** (analog component values bench-gated)

The board never touches the 8–12 VAC door-opener current — switched entirely inside the TV20/S. The
bus carries only low-voltage signalling (≤12 VDC, mA-level): the three ESP-driven switches (talk,
door, chime-mute) are **PhotoMOS SSRs**; the one electromechanical part is the **passive WF26 latch
relay**, which the bus drives itself (so it works with the board dead).

---

## WF26 connector — J2 (2-way) + J3 (3-way) terminal blocks (DG350-3.5, 3.5 mm)

**Connector:** the **5-way (P1–P5)** WF26 bus across two **DG350-3.5** 3.5 mm **pluggable screw
terminals** — **J2** (2-way: P1, P2) and **J3** (3-way: P3, P4, P5) — assembled by JLCPCB. The WF26
bus wires are fine, flimsy stranded (~26–28 AWG flat cable), below the rated minimum of Wago
picoMAX/221 push-in connectors (0.2 mm² ≈ 24 AWG); a screw terminal clamps thin stranded reliably
(tin/fold the ends) and matches what the WF26 uses internally. Pluggable so the board unplugs from
the bus for service. **Line 4 is one net (P4)** — there is no IN_P4/P4 split, because chime-suppress
no longer breaks line 4 (it opens C1; see "Relays" / "Audio path").

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| Line | TV20/S role | Role in our circuit |
|------|-------------|---------------------|
| **P1** (= board GND) | Common reference (all bell/speech ref to line 1) | Bonded to board GND; opto LED returns (each via 5.1 kΩ to P1); the codec RX/TX reference |
| **P2** | Listen leg; ÖT pair with line 3 | **K2** door bridge (to P3); **RX tap** (P2 → C16 → codec ADC); WF26_S1; the **P2 supply** that seals the WF26 latch in |
| **P3** | Talk leg; ÖT pair with line 2 | **K2** door bridge (from P2); **TX inject** (codec DAC → C14 → R28 2.2 kΩ → P3); WF26 talk/door switches |
| **P4** | Türruf — ~12 VDC front-door gong + tone | **OC1** sense; **K1** talk-handshake gate (TALK_BRIDGE↔P4); **K3** chime-mute (P4↔C1); WF26_K1 coil + flyback **D1**; WF26_R1 |
| **P5** | Etagenruf — apartment/floor call (tone) | **OC2** sense; **LS1** speaker (P5↔GND); WF26_C1 (the gong cap, P4↔P5) |

**Door opener (K2, SSR).** Energising K2 bridges **P2↔P3 directly** (a dead short, no series R) →
the TV20/S reads the ÖT and fires the opener. **Chime suppress (K3, NC SSR).** K3 sits in the gong's
**audio path** — between line 4 and the coupling cap C1 (K3: P4↔CHIME_C1, then C1: CHIME_C1↔P5). At
rest (de-energised) it is closed, so the Türruf gong reaches the speaker and OC1 senses line 4;
energised it opens, muting the gong **without touching line 4, the latch, or the Etagenruf** (which
reaches LS1 directly on line 5, bypassing C1).

> **DOOR-4 gap (to fix in hardware).** REQUIREMENTS.md **DOOR-4 / MODE-3** now require the door
> actuator to **mirror S1** — break the **P2→K1_COM seal-in** so the latch drops and the session ends
> as the door fires (a break-before-make transfer). The single-pole K2 as built **cannot** do that; it
> is a plain parallel short, and the ~1.75 s firmware delay below is only an **interim mitigation** of
> the gong-onto-line-3 symptom, *not* a substitute for the transfer. The fix needs a second SSR (or a
> DPDT SSR) that opens the `WF26_S1.NC2 → K1_COM` seal-in path when the door fires — see TODO.

**Door-open must wait out the gong (firmware timing — interim, see the DOOR-4 gap above).** K2 bridges
P2↔P3 as a *parallel* short, which — unlike the handset's own button — does **not** break the listen
path. During a
ring WF26_K1 is energised (K1_COM↔P4) with the handset's S1 released (P2 parked on K1_COM), so
**P2↔P4**: line 2 carries the live Türruf. Closing K2 then completes
**P4 → WF26_K1 → P2 → K2 → P3**, injecting the ring (12 V DC + gong AC) onto line 3 — the
up-audio / talk line back to the TV20/S. The handset never does this because its door button
**S1 is a DPDT *transfer*** that lifts P2 off K1_COM the instant it bridges P2↔P3; K2 is a plain
parallel short with no such break. So the firmware **delays the door-open ~1.75 s after the house
ring** (`house_doorbell` → `delay: 1.75s` → `front_door_buzzer`), long enough for the gong (the
AC burst at the ring onset) to finish — K2 then bridges only the residual DC pedestal, not the
tone. WF26_K1 stays pulled in for the full ~60 s call window, so the delay waits out the *gong*,
not the whole window.

> **Line 4 carries the Türruf** (PCB net **P4** — one net, no IN_P4/P4 split). Inside the handset core
> it is the junction of C1, R1, the WF26_K1 coil and its NO contact: the ring's **DC energises the
> coil** (coil = P1↔P4 = common↔Türruf — a ~1 s TV20/S pulse, then sealed in from P2), and its **AC
> tone reaches the speaker via C1** (P4↔P5 → LS1 = the gong). **Talk** is a 2.2 kΩ bridge of **line
> 4↔line 3** (S2 + R1); **listen** routes line 2 → WF26_K1 → P4 → C1 → speaker. **Chime suppression
> opens C1** (K3, NC, in the P4↔C1 path) so the Türruf tone never reaches the speaker — line 4, the
> latch and the Etagenruf are untouched. There is no local tone generator (no ICs); the chime *is*
> the audio on line 4. See "WF26 internal circuit" below.

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | J2 pin |
|--------|----------|
| Orange | P1 (J2) |
| Green | P2 (J2) |
| Blue/white stripe | P3 (J3) |
| Blue | P4 (line 4, Türruf — J3) |
| Black | P5 (J3) |

> All five WF26 bus wires land directly — P1/P2 on **J2**, P3/P4/P5 on **J3** — with **no jumper**,
> since line 4 is a single net now (chime-suppress no longer breaks it; see "WF26 connector").

---

## TV20/S reference facts (confirmed from the STR PDF)

From `docs/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` (*Verdrahtungsplan* + *Fehlersuchhilfe*):

- **Power:** NTR201 transformer, 230 V~ → **12 VAC**; feeds the TV20/S control unit.
- **Door opener (Türöffner Tö):** **8–12 VAC, 1 A max** (~5–15 Ω), switched by the TV20/S
  on its terminals **8/9** — our board never carries this current. The central unit
  (`reference/tv20s-board.jpg`, a discrete relay/analog board) carries a **1–12 + earth +
  `8V~`** screw-terminal strip; the opener is fed from a **separate ~8 V/1 A bell transformer
  (Klingeltrafo)** wired to that `8V~` terminal — a third AC domain, distinct from the
  NTR201 12 VAC that supplies the bus and bell-sense voltages, and one the board never taps.
  The bus we tap (lines 1–5 at the WF26) and the bell-sense voltage (~12 VDC) stay on the
  NTR201 domain, so the opener's 8 V supply does **not** affect the opto sense-current sizing.
- **Bell signals:** Türruf (house door) ≈ **12 VDC nominal across terminals 4 & 1** (measured
  ~10 V at the bus); Etagenruf (floor call) measured across **5 & 1**. Line **1 is the common**
  reference. A door press **starts a ~60 s session window** on line 4 — *press duration is
  irrelevant* (a short tap and a long hold both start it) — line 4 stays "hot" until the session ends.
  The TV20/S only **pulses line 4 high for ~1 s** to pull the WF26 relay (listen) in; the **handset
  then holds line 4 hot itself**, sealing it in from the **P2 supply** (`P2 → S1 NC → K1_COM → the
  closed NO contact → line 4 → coil`). So the supply is on **line 2** — the central unit's job is just the
  ~1 s trigger, and line 4 is then held up *from P2 through the latched contact*, not by the central unit
  (no handset to seal in → P4 floats and the ~1 s kick just dies → no session). This is why, at the
  bench, line 4 sits ~0.16 V *below* P2 through the session — pulled up from P2 across the coil/contact
  drop, with the coil load on P2. **Dropping line 4 does *not* release it** —
  P2 holds the seal-in. The session ends via **line 2 (P2)**: a **door-open** (bench-confirmed,
  `ring4`) presses the genuine handset's **break-before-make DPDT S1**, which opens **P2↔K1_COM** (the
  seal-in) ~6 ms *before* it closes the P2↔P3 bridge — so the coil drops (line 4 falls and P2 *rises*
  ~9.4→11 V as the ~29 mA coil load comes off it, then both settle ~9 V at the bridge); the **~60 s
  timeout** (after the last talk activity, or the initial Türruf with no talk) ends it by an
  **unconfirmed** mechanism — *likely* a brief **P2-low** pulse that forces WF26_K1 to drop (see TODO).
- **Tones:** Türruf = **3-Klang-Gong** (3-chime) — the gong is an **AC tone superimposed on the
  line-4 DC pedestal at the *start*** of the window; once the chime finishes, line 4 holds
  **steady DC** for the remainder. Etagenruf = **Dauerton** (continuous).
- **Bus is a shared party line; line 4 is per-apartment.** Line 4 (Türruf) is **address-selective**
  — it only goes hot for *this* apartment's own door button; another apartment's ring leaves our
  line 4 cold, so **OC1 (on line 4) senses only our own ring**. Line 2, by contrast, is **shared
  across apartments**: a neighbour's call audio — gong included — appears on our line 2, put there
  by the *ringing* handset's K1 listen-bridge (P2↔P4). So anything tapping line 2 hears every
  apartment's call. (Observed: a neighbour's ring showed the gong on our P2 with our line 4 cold;
  the gong's source is line 4, reaching the shared line 2 only through a latched K1.)
- **ÖT door-opener trigger (authoritative):** the troubleshooting test says
  *"Zum Test, Klemmen 2 u. 3 brücken"* — **bridge terminals 2 & 3** → opener voltage
  appears at 8/9. This is exactly what relay **K2** does (COM=P2, NO→P3, a direct short).
- **ET (Etagenruftaster) vs ÖT:** the **ÖT** (door-opener) button momentarily bridges **2↔3**
  across the bus as a **direct short** (the handset's S1). The **ET** (Etagenruf / floor-call) sits **in line 5**, between the WF26's terminal
  5 and the onward bus conductor — so **P5 does not run directly to the TV20/S**; line 5 reaches
  the central unit through the ET button (**not** among the WF26's captured internals).
  **Each handset's P5 is gated by that apartment's door button** (confirmed), making line 5 a
  per-handset line — relevant to the Etagenruf, but *not* to the relay coil, which is across
  **P1↔P4** (common↔Türruf) and is driven by the ring's own DC (see "WF26 internal circuit").
- **Speech:** only enabled *after* a bell; ~25 s talk window, auto-off after ~60 s. The bus
  speech pair is **lines 2/3** (STR Fehlersuchhilfe: *Sprechverkehr* on 1/2/3, door side 6/7) —
  up-audio on line 3 (S2's 2.2 kΩ talk bridge), down-audio on line 2 (via the relay). At the
  WF26 the transducer couples to line 4 via **C1 (P5↔P4)**. The door-opener also momentarily
  shorts **2↔3**, so that pair is shared between speech and the ÖT trigger — **not** opener-only.

### TV20/S audio behaviour

Half-duplex speech through the TV20/S amp, enabled only after a bell (~25 s window, auto-off
~60 s). The bus speech pair is **lines 2/3** (STR Fehlersuchhilfe: *Sprechverkehr* on 1/2/3,
door side 6/7), electrically continuous WF26↔TV20/S. The sole transducer **LS1 (P1↔P5)** does
both directions; the internal routing is traced under "WF26 internal circuit" below:

- **Up (talk):** LS1-as-mic → C1 → P4 → R1 → **line 3**, asserted by S2 (a 2.2 kΩ bridge of
  line 4 to line 3).
- **Down (listen):** **line 2** → S1 (released) → relay → P4 → C1 → LS1 — gated by the relay
  being pulled in, which the **Türruf DC does directly** (coil across P1↔P4).
- **Etagenruf** drives the speaker directly on line 5; the **Türruf gong** rides line 4 → C1.

So 2/3 carries the speech (up on 3, down on 2) plus the momentary ÖT door bridge; the bell
triggers (line 4 Türruf, line 5 Etagenruf) are separate conductors.

- **Bell required first** — TV20/S only enables speech *after* a bell button press.
- **Talk** — resident presses the Sprechen button (S2); LS1 acts as the mic, the TV20/S
  amplifies it out to the door station.
- **Listen** — releasing reverses direction; door-station mic → WF26 speaker for ~25 s.
- **Auto-disconnect** — WF26 drops the circuit after ~60 s.

Implications: the V4 audio path taps the bus **speech pair** — RX on P1↔P2, TX on P1↔P3 — gated by
the session (see "Audio path").

### TV20/S central unit — from the board photo

`reference/tv20s-board.jpg` (component side) shows the speech path built on dedicated audio power
amplifiers — an **LM380N** (2.5 W) and a **TAA861A** — plausibly one per direction (half-duplex) —
alongside several **V23100 / V23154** signal relays and small-signal transistors. The amp types
are read directly from the parts; the points below are inferred from them, not traced from a netlist:

- **The bus speech audio is AC-coupled at the TV20/S.** The LM380 needs an output coupling cap and
  its inputs are cap-coupled (as is that class of AF amp), so the amplifiers respond to the **AC on
  lines 2/3, not the DC bias** on them. The speech path does not care about the speech-line DC level.
- **The DC on the speech pair is a separate signalling layer**, not part of the audio — session
  start / talk-detect / hold, handled by the **relays + transistors**. So the talk handshake (the
  line-3 DC the WF26 asserts through R1) most likely drives a relay/transistor talk-detect that flips
  the half-duplex direction — but the **exact trigger (DC level vs current vs edge) is unconfirmed**
  from a photo and needs a bench probe (this is the open TX-out-reach question, see REQUIREMENTS.md).
- The separate **8 VAC / 1 A bell transformer** for the door opener is visible on its `8V~` terminal
  (consistent with "Power" above).

---

## WF26 internal circuit (reverse-engineered)

The apartment handset (Sprechstelle **WF26/G**, PCB silk "…WF26") has **no MCU and no ICs**
(1970s THT): a single transducer, one signal relay, an RC pair and two DPDT switches. The full
internals are captured in **`wf26/wf26.kicad_sch`** (standalone, ERC-clean; neutral connectivity
readout in `wf26/wf26-schematic.md`; teardown photos `IMG_5082.jpg` /
`reference/intercom-teardown-collage.png`). Parts: LS1 (16 Ω speaker/mic),
**S1 (Türöffner / door release, DPDT)**, **S2 (Sprechen/Hören / talk, DPDT)**, R1 (2.2 kΩ,
colour bands red-red-red-gold), C1 (22 µF/50 V), WF26_K1 (6-pin DIL SPDT signal relay,
HJR-4102-N-12V), J1 (5-way bus = P1–P5).

**The numbering is canonical: Pₙ = bus line n** (J1 pin n → Pₙ), confirmed by measurement — the
door-opener bridges **P2↔P3** (= the ÖT pair, lines 2/3) and the speaker sits across **P1↔P5**
(common + Etagenruf), leaving **P4 = line 4 (Türruf)**.

| Net | Pins |
|-----|------|
| P1 *(line 1, common)* | J1.1, LS1.1, WF26_K1.8 (coil) |
| P2 *(line 2)* | J1.2, S1.2, S1.5, S1.6 |
| P3 *(line 3)* | J1.3, S1.3, S1.4, S2.3, S2.4 |
| P4 *(line 4, Türruf)* | J1.4, C1.1(+), R1.1, WF26_K1.5 (coil), WF26_K1.6 (NO) |
| P5 *(line 5, Etagenruf)* | J1.5, C1.2(−), LS1.2 |
| K1_COM | WF26_K1.1, WF26_K1.12, S1.1 |
| R1_BRIDGE | R1.2, S2.2, S2.5 |
| n/c | S2.1, S2.6, WF26_K1.7 (NC) |

Topology: LS1 across **P1↔P5**; C1 across **P5↔P4** (**+ toward P4**, the Türruf +12 V DC side);
the relay coil across **P1↔P4**; R1 from **P4** to R1_BRIDGE (the talk-switch common).

Key facts:

- **Door release = direct P2↔P3 (no resistor).** S1 (Türöffner) *pressed* shorts **P2↔P3**
  directly — the ÖT bridge, exactly the TV20/S test *"Klemmen 2 u. 3 brücken."* *Released*, S1
  parks P2 on K1_COM. **R1 (2.2 kΩ) is *not* in the door path** — it lives on the talk switch.
- **Talk = P4↔P3 through R1 (2.2 kΩ).** S2 (Sprechen) *pressed* ties R1_BRIDGE↔P3, putting R1
  across **P4↔P3**; *released* it parks on the unused NC (open). The talk handshake the TV20/S
  sees is a **2.2 kΩ bridge of line 4 to line 3**.
- **Why the talk bridge is resistive, not a short.** During a held session WF26_K1 ties **P2↔P4**
  (the listen path), so the talk bridge **P4↔P3** is electrically **P2↔P3** — the *door-opener*
  pattern. The 2.2 kΩ keeps it below the opener's fire threshold (a dead short fires; 2.2 kΩ does
  not), so talking can't pop the door; it also limits the load on the line-4 session hold.
- **The relay coil is across P1↔P4 = common ↔ Türruf, so the house ring energises it directly.**
  The TV20/S **pulses line 4 high for ~1 s** — ~12 V/320 Ω ≈ 37 mA through the coil to common — and
  pulls WF26_K1 in. After that the TV20/S lets go of line 4; **P2 seals the latch in** (`S1 NC →
  K1_COM → the closed NO contact → line 4 → coil`), so the **handset holds line 4 hot from the P2
  supply** for the session — the TV20/S is not driving line 4. **Dropping line 4 does *not* release it** — P2
  holds it; the session ends via **P2**: at a door-open S1's **break-before-make** transfer opens
  P2↔K1_COM ~6 ms *before* bridging P2↔P3, dropping the coil (line 4 falls, P2 *rises* as it unloads —
  **bench-confirmed, `ring4`**); or the ~60 s inactivity timeout ends it by an **unconfirmed** mechanism
  (likely the TV20/S briefly pulls P2 low; see TODO). **WF26_K1:**
  6-pin DIL SPDT (1 Form C), HJR-4102-N-12V, coil 5/8 (~320 Ω), common
  1+12 = K1_COM, **NO pin 6 = P4**, NC pin 7 = open. Energised → K1_COM↔P4.
- **Single transducer:** LS1 (16 Ω) is the **only** transducer (no separate mic), across
  **P1↔P5**, reused as speaker and mic for tone output and both speech directions. Everything
  the handset reproduces or picks up is at P1/P5 (its single transducer).
- **C1 (P5↔P4) is the audio crossover.** It couples the speaker-hot node (P5) to the Türruf
  line (P4) — passing audio (AC), blocking DC — the single component straddling the transducer
  and the signalling side.

**Audio path — fully derivable now:**

- **Etagenruf (apartment call):** a tone on **line 5 → straight across LS1** (P5 hot, P1 common).
  Loud, unshaped — no cap, no relay. (Line 5 reaches the bus only through the external ET button.)
- **Türruf gong (house call):** the ring on line 4 splits — **DC → coil → common** (pulls K1 in);
  **AC tone → C1 → P5 → LS1** (you hear the gong). **C1 blocks the DC off the speaker, so the
  holding current returns through the *coil*, not the voice coil → no cone offset.** Pulling P4
  kills both (observed). The gong is not made in the handset (no ICs) — the TV20/S sends it as
  AC on line 4.
- **Talk (up-audio):** LS1 as mic → **P5 → C1 → P4 → R1 → P3** (line 3) out to the door station.
- **Listen (down-audio):** during a session (relay in), **S1 released** ties **line 2 (P2) →
  K1_COM → NO → P4 → C1 → P5 → LS1**. Down-speech arrives on **line 2**, routed by the
  door-release switch + the energised relay onto the same C1→speaker path.

> Takeaway: nothing in the WF26 is "smart." The house ring's own DC works the relay; C1 is the
> single audio crossover; the two switches are a **direct 2↔3 door bridge (S1)** and a
> **2.2 kΩ 4↔3 talk bridge (S2)**. No firmware handshake exists.

**Open / inferred (verify on the bench):**
- C1 polarity: the board sets **+ toward P4** (the Türruf +12 V DC side; see above). The
  reverse-engineered handset drawing shows + toward P5 — the source of the old assumption — but
  P4 is the +12 V line, so the board's orientation is the electrically-correct one (VERIFICATION.md
  Finding 2). Bench-confirm against the genuine unit (the only thing still open).
- **Does line 4 hold ~12 V through the talk window, not just the ring?** Listen needs the relay
  to stay pulled in for the session, so the Türruf DC must persist past the chime. Re-measure
  P4→P1 idle / ringing / mid-talk-window.

**Interfacing takeaways (audio tap / virtual PTT):**
- Record/monitor: a high-Z tap on **P1/P5** (the transducer) captures gong, Etagenruf and both
  speech directions regardless of bus line — *but* it rides the relay/C1 path, so it dies when the
  gong is suppressed (C1 opened). The board instead taps the **speech pair** (RX P1↔P2, TX
  P1↔P3), which is independent of line 4 / suppress — see "Audio path."
- Virtual talk from the bus: bridge **line 4 ↔ line 3 through ~2.2 kΩ** (mimic S2). Virtual
  door-open: short **line 2 ↔ line 3** directly (mimic S1).
- Injecting TX audio on P1/P5 makes LS1 replay it (quiet at mic level); lift one LS1 lead to
  silence it (1-wire board mod).

---

## V3 — the deployed board (perfboard)

The system currently in the wall: an ESP32 DevKit + relay module on hand-wired perfboard,
running `firmware/doorbell-v3.yaml` (`board: esp32dev`). Its sense/relay topology is what V4 carries
over.

| Ref | Part | Role |
|-----|------|------|
| U1 | LuaNode32 / ESP32 DevKit (ESP-WROOM-32, 30-pin), socketed | MCU |
| U2 | 2-ch relay module (SONGLE SRD-05VDC-SL-C), separate board | K2 + K3 (active-LOW inputs) |
| OC2, OC3 | PC817 optocouplers | House / apartment bell sense |
| R2 | 5.1 kΩ (2010 SMD) | Opto LED series limiter (shared, in cathode→P1 return) |
| R1 | 1 kΩ (2010 SMD) | Opto phototransistor emitter resistor (shared, to GND) |
| J4–J9 | Camdenboss CTB0158 screw terminals | Wiring breakout |

| GPIO (V3) | ESPHome entity | Direction | Hardware | V4 (C6) pin |
|------|---------------|-----------|----------|----|
| 32 | `"Apartment Doorbell"` — binary sensor, pullup, inverted | Input | OC3 collector (P5 / Etagenruf) | IO2 |
| 33 | `"House Doorbell"` — binary sensor, pullup, inverted | Input | OC2 collector (IN-P4 / Türruf) | IO3 |
| 26 | `front_door_buzzer_bin` — output, inverted | Output | Relay K2 (ÖT bridge) | IO21 |
| 25 | `suppress_doorbell_sound_bin` — output, inverted | Output | Relay K3 (chime suppress) | IO22 |

V3 netlist verified against `reference/netlist.txt` (nets `WF26-P4`/`WF26-P5`, `N9`–`N12`;
V3's `WF26-IN-P4` mapped to what was V4's `IN_P4` — now merged into the single `P4` net, since V4's
chime-suppress moved off line 4 onto C1).

**Reliability problem (the reason for V4):** Dupont jumper headers between perfboard and
relay module work loose over months. The redesign eliminates all inter-board jumpers by
integrating everything onto one PCB.

---

## V4 — integrated single board

**Design philosophy: carry the proven V3 sense path over; modernise the rest.** The bell-sense
front-end is reproduced — per-opto LED limiters (a shared limiter would let a ringing channel
reverse-bias the idle opto's LED past its 6 V VR), anti-parallel reverse-clamp diodes on each opto
(polarity hardwired anode-to-bus-line) — as is the direct ÖT bridge (K2, P2↔P3). The three ESP-driven
actuators are now **PhotoMOS SSRs** (K1 talk gate, K2 door, K3 chime-mute), the audio path is
**transformer-less** (codec on the speech pair, P1↔GND bonded), and a passive **WF26 core** makes the
board a drop-in handset when unpowered. Line 4 carries the Türruf as a ~12 V DC level with the 3-Klang
tone riding on it: the opto (on P4↔P1, **ahead of C1**) sees the DC-dominated level — so it is debounced
in firmware (`delayed_on`/`delayed_off`), not rectified — while C1 (K3-gated) blocks that DC and passes
only the AC tone on to LS1. Same line, two views: DC at the opto, audio at the speaker.

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C6-MINI-1U-H4** (u.FL external antenna; LCSC C20627095) | ESPHome-supported, native USB, enough GPIO for the audio path (I²S + I²C + 3 SSR gates + 2 opto inputs) |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT), Economic PCBA where eligible | J2 is through-hole (as are J1's shell stakes) but assembled by JLCPCB — nothing hand-soldered. Part eligibility/stock checks at order time: see `ORDERING.md` |
| Switches K1/K2/K3 | **PhotoMOS SSRs** — K1/K2 = **GAQY212GS** (1-Form-A NO, AC/DC, 0.24 Ω Ron, 60 V; LCSC C7435107); K3 = **GAQY412EH** (1-Form-B **NC**, AC/DC, ~1 Ω Ron, 60 V; C7435135) | All three switch only ≤12 V mA-class bus signals → PhotoMOS territory: no coil power/heat, no acoustic click, no bounce/wear, an optical GPIO↔bus barrier. K1 (talk) and K2 (door) idle **open** (1-Form-A; unpowered talk/door covered by the passive core's S2/S1); K3 (chime-mute) must idle **closed** = **1-Form-B NC**, so an unpowered/booting board still rings the gong (GONG-3/SAFE-6). Ron is swamped by series R (K1: R28 2.2 kΩ) or negligible vs the 16 Ω speaker (K3: ~−0.5 dB). The passive WF26 latch stays electromechanical — it's bus-self-latched and must work board-dead |
| SSR LED drive | **GPIO → 10 k pull-down → 300 Ω → SSR LED** (no transistor, no flyback) | Each SSR "driver" is just its LED + a series R: ~7 mA from the 3V3 GPIO through R4/R5/R6 (300 Ω); R7/R8/R9 (10 k) pull-downs ⇒ SSRs default **off** at boot (SAFE-6). No coil ⇒ no flyback; the one surviving flyback (D1) is on the passive WF26 latch coil. (Retired the old per-channel relay-driver sheet.) |
| Opto polarity | **Fixed: LED anode → bus line, cathode → R_lim → P1** + **anti-parallel 1N4148W clamp** across each LED | Bus is taken to drive active lines **positive w.r.t. common (P1)**, so polarity is hardwired (no switch) — bench-confirm per channel by ringing each bell. The clamp limits reverse V to ~0.7 V (< the LED's 6 V VR) on the AC tone content |
| WF26 connector | **DG350-3.5 pluggable terminals — J2 (2-way) + J3 (3-way), 5-way total (P1–P5)** | See "WF26 connector". 5-way (not 6): line 4 is one net now — chime-suppress moved off line 4 onto C1, so the IN_P4/P4 split is gone |
| USB-C connector | **GCT USB4105-GF-A-060** (single-row SMD + THT shell stakes, C3025063) | ~⅓ the cost of a THT USB4085 and better stocked; the THT shell stakes keep cable-insertion strength, and the single-row SMD escape is workable on 4 layers |
| Layers | **4-layer** | the USB Type-C single-row escape needs the extra layers + a solid plane reference; see "PCB — layout constraints & rationale" |
| Power | **USB-C 5 V** → SS14 reverse-protection Schottky → **SGM2212-3.3** low-dropout LDO (C3294699) | The ~0.45 V Schottky drop still leaves ~1 V LDO headroom (an AMS1117's 1.3 V dropout would brown out under WiFi TX) |
| Audio | **Transformer-less half-duplex**: ES8311 mono codec on the bus speech pair — **RX** a differential sense of line 2 (P2→C16→ADC, P1→C17→ADC), **TX** the codec DAC → C14 (DC-block) → R28 (2.2 kΩ) → line 3, **K1** gating the talk handshake (TALK_BRIDGE↔P4); session-gated on **OC1**. Needs the **hard P1↔GND bond**; analog values bench-gated | Half-duplex by design (single LS1 transducer) ⇒ no echo cancellation. The TV20/S speech path is AC-coupled and P1 sits ~0.5 V from earth, so bonding P1↔GND is benign and lets active AC-coupled front-ends replace the transformer (smaller, fixes the talk-handshake load, no core saturation). Trade: SAFE-3 isolation → *not met*; containment is per-tap protection + F1 (SAFE-7) |
| Form factor | **Single PCB**, no daughter boards | Eliminates inter-board jumpers (the V3 failure mode) |

### ESP32-C6 GPIO map (matches `firmware/doorbell-v4.yaml` and the schematic)

| GPIO | U1 pad | Signal | Dir | Notes |
|------|--------|--------|-----|-------|
| IO20 | 26 | K1 gate — **TX talk handshake** (K1 gates TALK_BRIDGE↔P4; codec → C14 → R28 2.2 kΩ → line 3) | out | GATE1_DRV → R4 (300 Ω) → SSR LED; R7 10 k pull-down ⇒ off at boot |
| IO21 | 27 | K2 gate — front-door buzzer / ÖT (bridge P2↔P3 direct) | out | GATE2_DRV → R5 (300 Ω) → SSR LED; R8 10 k pull-down ⇒ off at boot |
| IO22 | 28 | K3 gate — chime suppress (open C1: P4↔CHIME_C1) | out | GATE3_DRV → R6 (300 Ω) → SSR LED; R9 10 k pull-down ⇒ off (NC SSR ⇒ off = gong rings) |
| IO3  | 6 | OC1 collector — house bell (Türruf, line 4 / P4) | in | held high by **R22** (10 k → +3V3); firmware sets `mode: input` (no internal pull-up) |
| IO2  | 5 | OC2 collector — apartment bell (Etagenruf, P5) | in | held high by **R23** (10 k → +3V3); firmware sets `mode: input` (no internal pull-up) |
| IO19 / IO23 | 25 / 29 | **spare** — unused GPIO, pad free | — | available for reuse |
| IO12 / IO13 | 17 / 18 | USB D− / D+ | — | native USB-Serial-JTAG: flashing + logs |
| IO18 / IO15 | 24 / 20 | I²C SDA / SCL (10 k pull-ups R18/R19) | — | ES8311 control, addr 0x18; IO15 is a JTAG-source strap — the SCL pull-up holds it high at reset (= USB-Serial-JTAG, the wanted state) |
| IO14 / IO7 / IO1 | 19 / 16 / 13 | I²S MCLK / BCLK / WS(LRCK) | out | ES8311 |
| IO6 / IO0 | 15 / 12 | I²S DIN(ASDOUT) / DOUT(DSDIN) | in / out | ES8311; GPIOs ordered so U1's codec-facing edge fans to U3 in pin order, no crossings |
| IO9 | 23 | BOOT strap | — | 10 kΩ pull-up + button to GND |
| EN | 8 | Reset | — | 10 kΩ pull-up + 1 µF to GND (Espressif EN-RC spec) + button |
| IO8 | 22 | strap | — | 3.3 kΩ pull-up (R12, per C6 datasheet / DevKitC-1 R6) |
| IO4 / IO5 | 9 / 10 | spare | — | No-Connect |
| IO16 / IO17 | 31 / 30 | U0TXD / U0RXD | — | No-Connect |

### Bell / session sense front-end

Two identical channels (OC1 = house bell on P4↔P1, OC2 = apartment bell on P5↔P1):

```
bus line (active, +) ──► opto LED anode ── LED ── cathode ──┬── R_lim (5.1k) ── P1 (common)
                          ▲ 1N4148W clamp, ANTI-parallel ───┘
opto collector ──► GPIO (internal pull-up)   opto emitters ──┬── R_em (1k, shared) ──► GND
```

- **Fixed polarity (no switch):** the bus is taken to drive active lines **positive** w.r.t.
  common, so each LED is hardwired **anode → bus line** (P4 for OC1, P5 for OC2),
  **cathode → R_lim → P1** — it conducts on the active (positive) half. **Bring-up check (per
  channel):** ring the real bell and confirm detection, or look for the ~10.7 V drop across R_lim
  (≈2 mA) when active. If a channel never detects (near-0 V across R_lim, ~0.7 V across the LED),
  that line's polarity is the other way — swap the LED's two bus connections. The wrong guess is a
  silent non-detect, not damage: the clamp (D8/D9) holds the reverse-biased LED to ~0.7 V.
- **Reverse clamps (D8–D9, 1N4148W):** anti-parallel across each opto LED — clamp anode on
  the LED-cathode net, clamp cathode on the LED-anode net — so the clamp conducts only on
  the reverse half-wave and limits the LED's reverse voltage to ~0.7 V (< its 6 V VR).
  **Lib convention: 1N4148W pin 1 = cathode, pin 2 = anode** (CDFER JLCPCB lib, same as the
  WF26_K1 coil flyback D1 and Schottky D4 — pin 1 toward +5V there).
  V3 ran both channels with **no reverse clamp** and detects fine, so **D8 (OC1 / line 4, DC) is
  droppable** (one polarity, nothing to clamp) and **D9 (OC2 / line 5) is optional** — line 5 is an
  AC tone that does reverse-bias the LED, so D9 is the only one with a real (if V3-survivable) job.
- **Per-opto limiters (R_lim1–2, 5.1 kΩ):** one per channel; a shared limiter would let a
  ringing channel lift the common node and reverse-bias the idle LED. R_em (1 kΩ emitter,
  shared) carries only µA and is not part of any reverse path.
- Bell present → LED conducts → phototransistor pulls the GPIO low → ESPHome
  `inverted: true` ⇒ "on". GPIO LOW level ≈ 0.12–0.27 V.
- **Sense margin (by analysis):** at IF ≈ 1.7–2.1 mA (10–12 V line) the collector sits at
  ≈ 0.14 V — far below the ESP32 V_IL (~0.825 V) — and stays there across CTR 0.5→2.6,
  because the weak ~45 kΩ internal pull-up demands only ~56 µA while the opto can sink
  ~0.85 mA even at abused-low CTR. Result is insensitive to opto part variation; the
  shared 1 kΩ R_em is immaterial at these currents.
- **Cross-talk masking** (`firmware/doorbell-v4.yaml`, lambda filters ahead of the debounce):
  - **House Doorbell (OC1)** is masked while PTT is engaged, as a **precaution**: K1 closed
    ties P4↔P3 via R28 (2.2 kΩ), so P3's resting bias (and the codec's AC drive through C14)
    could couple onto line 4 and report a phantom ring — which can pulse the door buzzer via
    auto-open. **Bench-unconfirmed, and possibly negligible:** the WF26_K1 coil (~1.3 kΩ across
    P4↔P1) clamps P4 toward common (P4 ≈ 0.32·V_P3 through the R28/coil divider — needs P3 idling
    ≳ 8 V to reach OC1's threshold), and OC1's 50 ms debounce already rejects the codec's
    audio-rate AC. The mask's cost is that it also blanks a *genuine* ring landing during the
    board's own PTT window (a real ring drives P4 ~10 V and is distinguishable). Measure P3's idle
    bias and whether PTT alone trips OC1 before relying on or dropping it (see TODO).
  - **Apartment Doorbell (OC2)** taps the speaker pair, so it pulses on *any* loud
    speaker audio — Etagenruf tone, Türruf gong and session speech alike. It is forced
    off while House Doorbell / PTT are active; what remains is a genuine floor
    call.
  - All masked interferers are AC, so the raw input keeps toggling and the masks
    re-evaluate continuously while active. The masks must never gate a *steady-DC*
    signal that outlives the mask window — the lambda only re-runs on raw-input edges.
- **OC2 tone detection** (`firmware/doorbell-v4.yaml`): the opto conducts only on positive
  half-cycles above the LED threshold, so OC2's raw input toggles at audio rate
  (~1 ms low / ~1.4 ms high) and a plain `delayed_on` would never latch. The filter
  chain stretches the conduction pulses into a level first (`delayed_off: 50ms`), then
  requires it to persist (`delayed_on: 150ms` — also outlasts House Doorbell's 50 ms
  latch so a gong starting together with a house ring cannot beat the mask), then holds
  the result (`delayed_off: 2s`). OC1 senses a **DC-dominated** level (line 4's Türruf is a
  ~12 V bias with the chime tone riding on it), so a plain `delayed_on`-first filter latches
  where it never would on chatter — OC1 keeps the plain `delayed_on: 50ms` debounce, which
  doubles as AC-interference reject (no audio-rate pulsing can hold it low for 50 ms). The chime *tone* is still on line 4 — it
  reaches LS1 via C1, which strips the DC the opto rides on — so OC1's `delayed_off: 2s` also
  bridges the gaps between the three Klang so one ring = one event.

### Switches (K1/K2/K3 — PhotoMOS SSRs)

```
K1 (talk gate,   GAQY212GS NO): TALK_BRIDGE ↔ P4  — energise to tie the codec TX node to line 4 (talk handshake)
K2 (door opener, GAQY212GS NO): P2 ↔ P3           — energise to bridge P2↔P3 (the ÖT direct short)
K3 (chime mute,  GAQY412EH NC): P4 ↔ CHIME_C1     — at rest CLOSED (gong → C1 → speaker); energise to OPEN = mute
LED drive (all): GATEn_DRV → Rn(300Ω) → LED → GND ; pins 3/4 = switched contact, pins 1/2 = LED
```

- **PhotoMOS, single-pole, bidirectional.** Pins 3/4 are the AC/DC contact (back-to-back MOSFETs),
  pins 1/2 the LED. K1/K2 are **1-Form-A (NO)** = open at idle; K3 is **1-Form-B (NC)** = closed at
  idle. Off-state default is fail-safe: K1/K2 open ⇒ no talk/door at boot (the passive core's S2/S1
  cover those unpowered); K3 closed ⇒ the gong rings at boot/unpowered (GONG-3/SAFE-6).
- **K1 — talk handshake (session-gated).** The codec TX path is `DAC → C14 (DC-block) → TALK_BRIDGE
  → R28 (2.2 kΩ) → line 3` — the same 2.2 kΩ line-3 strap the handset's S2 asserts, i.e. how the
  TV20/S is told "talk". K1 gates **TALK_BRIDGE ↔ line 4**, so closing it lets the held Türruf DC on
  line 4 pull line 3 DC-hot (the handshake) — but **only while a session holds line 4** (K1.4 → P4;
  no session ⇒ line 4 cold ⇒ no handshake). *As-built caveat:* the intended design put K1 **in** the
  audio path (high-Z at idle, BUS-1); the schematic gates only the handshake, so the codec sits on
  line 3 through R28 whenever it's driving — a BUS-1 deviation tracked in TODO (see "Audio path").
- **Why TX drives line 3, not line 4.** A WF26 hangs **C1 (22 µF) + the 16 Ω speaker across line 4**
  = a ~20–30 Ω near-short to common across the voice band; injecting there would dump the drive into
  it. Line 3 is light (the TV20/S amp input ∥ R28's 2.2 kΩ), so the codec drives **line 3** while K1
  supplies the line-4 handshake.
- **K2 — door opener.** Energise to bridge **P2↔P3** directly (dead short) — the ÖT the TV20/S reads
  as "open".
- **K3 — chime mute.** In the gong's audio path (`P4 ↔ CHIME_C1 ↔ C1 ↔ P5 → LS1`). NC ⇒ de-energised
  = closed = gong rings (and OC1, on line 4, still senses — K3 doesn't touch line 4); energise = open
  = gong muted, with **line 4, the latch and the Etagenruf all untouched** (Etagenruf reaches LS1
  directly on line 5, bypassing C1 — structurally non-suppressible, GONG-4).
- K1/K2/K3 are independent (no interlock). Firmware holds **K3 de-energised whenever a ring should be
  heard**. Whether the TV20/S forwards the line-3 audio to the door station once it sees the R28
  handshake bridge is the open **TX-out reach** question (see "Audio path").

### SSR LED drive (per channel)

```
GPIO ── R4/R5/R6 (300Ω) ── SSR LED anode │ LED │ cathode ── GND
GPIO ── R7/R8/R9 (10kΩ) ── GND   (pull-down: SSR off while the GPIO floats at boot)
```
Each SSR "driver" is just its LED + a 300 Ω series R (~7 mA from the 3V3 GPIO — within the
GAQY412EH's 5–30 mA range; confirm the GAQY212GS forward current, see TODO). The 10 kΩ
pull-down holds each SSR **off** while the GPIO floats during boot — so the door opener can't
pulse and the chime can't be silenced by a booting/dead board (SAFE-6). No coil ⇒ no flyback;
the one surviving flyback (D1) is on the passive WF26 latch coil.

### Power tree

```
USB-C VBUS (5V) ── F1 1A fast fuse ── SS14 (series reverse-protect) ── +5V ── SGM2212-3.3 ── +3V3 ── ESP32-C6 + codec + SSR LEDs
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3: 10µF (C_out) + 10µF + 100nF decoupling
USB D±  ── IO12/IO13 (native USB)             SGM2212: 10µF in (C_in) / 10µF out (C_out)
USB D± ESD: TPD2S017 flow-through clamp (D5), VCC biased from fused VBUS; VBUS_F TVS: SMF5.0A (D10)
VBUS fuse: F1 (0466001.NRHF, 1A fast) ahead of all protection — a clamping D10 blows it (fail-safe)
```
> No bulk electrolytic: the local LDO actively regulates the ~350 mA WiFi-TX burst
> (modeled droop ≈ 90 mV across 20 µF of ceramic on +3V3), so a bulk cap buys nothing.
> VBUS cable-sag is a dropout-headroom question, covered by the low-dropout SGM2212.

### Bus ↔ logic coupling (SAFE-3 deviation)

There is **no galvanic barrier** between the bus and the logic: **P1 is bonded to board GND**. The
transformer-less audio needs a low-Z return to drive line 3 relative to P1, and the bench measured P1
~0.5 V from apartment earth, so the bond is benign here — but it means **SAFE-3 isolation is *not
met*** (a deliberate, measurement-justified SHOULD deviation). The sense optos still give an
LED→phototransistor barrier on the *detection* path and the SSRs an LED→MOSFET barrier on the
*actuator* path, but the **codec RX/TX taps and the P1↔GND bond couple the bus straight to logic
ground**. Fault containment (SAFE-7) therefore rests on **per-tap protection** (series R + clamp +
DC-block caps) and the board being **sacrificial** behind **F1**, which fuses it off the USB supply
before a fault can back-feed. (Voltages are low — 12 V bus — so this is fault-energy containment and
hum/ground-loops, not shock.)

### BOM

Part values/footprints/LCSC numbers are maintained **directly in the authoritative KiCad files**
(`kicad/doorbell.kicad_sch` / `.kicad_pcb` — the generator scripts are gone). `./build.sh all-route`
**exports** the order files from them (`kicad/fab/doorbell-bom-jlcpcb.csv` + `doorbell-cpl.csv`). See
`ORDERING.md` for the stock/eligibility checks at order time.

> J1/J2/J3 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered.

### PCB — layout constraints & rationale

Physical layout — traces, vias, copper zones, component positions, the 4-layer stack — lives in the
authoritative `kicad/doorbell.kicad_pcb`; this section keeps only the decisions and rules behind it.
The board is **4-layer**, ~**64 × 60 mm**, all parts on the top side, and **100 % hand-routed in
KiCad**; `./build.sh all-route` refills the inner copper-fill planes and fails if any net is unrouted.

- **Why 4-layer.** J1 (USB4105) is a single-row SMD Type-C: D+/D−/CC/VBUS all escape from one
  fine-pitch interleaved pad row, which needs the extra layers — a plane reference for the USB pair
  and room to fan the rest out. A 2-layer board can't escape it cleanly.
- **Bus↔logic coupling is a layout constraint** (see "Bus↔logic coupling"): there is no galvanic
  barrier — **P1 is bonded to board GND** — but keep bus-side nets to their own copper, crossing to
  logic only at the optos, the SSRs, and the deliberate codec/P1 taps, to contain fault energy and hum.
- **No vias in exposed pads** (solder-wicking avoidance): U1's and U3's EPADs carry no vias; they
  bond to the planes through adjacent copper. General V4 rule: vias must not overlap SMD pads.
- **Fine-pitch clearance.** The ES8311's 0.40 mm pitch won't take the default net-class clearance, so
  routing clearance is set globally to JLCPCB's published 0.127 mm capability (hole-to-copper 0.2 mm),
  pinned in `kicad/doorbell.kicad_dru`. Trade-off: the board routes at the fab limit, not with margin.
- **Bus-width policy.** Nets at WF26-bus potential (P1–P5, TALK_BRIDGE, CHIME_C1) and +5V are routed
  wider than signal nets — the bus carries the Türruf and the door currents, +5V feeds the LDO and the
  ESP32's WiFi-TX peak (via +3V3). KiCad's DRC does not enforce this; it's a routing rule.
- **Pin assignment exploits the C6 GPIO matrix** (plus an I²C/I²S swap) so U1's and U3's escape fans
  route without crossings — see the GPIO map.
- **Copper thieving:** both outer layers carry fill zones; the build refills and checks them, and any
  oversized floating island is grounded with a hand-placed GND stitching via in KiCad (vias are never
  auto-generated).
- **Fiducials:** three `Fiducial_1mm_Mask2mm` marks in an asymmetric triangle so the pick-and-place
  camera resolves orientation; excluded from the BOM and CPL.

### Build / test notes

- **Antenna:** U1 (MINI-1U) has a **u.FL connector** for an external antenna — route the lead out of
  the housing; there is no PCB-antenna keepout to honour (unlike the old WROOM-1).
- **Programming/bring-up:** flash + view logs over USB-C (native USB-Serial-JTAG); BOOT +
  EN buttons fitted for recovery.
- **Bench validation against the real TV20/S** (door pulse, chime suppress, session sense,
  PTT) before it goes in the wall. Probe via the commissioning test points (TP1 = GND
  scope anchor, TP2 = +5V, TP3 = +3V3), J2's screws, and component pads. The board has
  **H1/H2 mounting holes** (NPTH 3.2 mm) on the enclosure bosses.

---

## Audio path (half-duplex; analog values + TX-out reach bench-gated)

**The bus is half-duplex by design.** Speech is on the **1/2/3 group** (the STR *Sprechverkehr*):
**listen on line 2, talk on line 3, ref line 1 (common)**. The board taps that pair with an **ES8311
codec, transformer-less** — P1 is bonded to board GND, so the codec senses/drives line 2/3 relative to
that shared common (the SAFE-3 trade; see "Bus↔logic coupling"):

- **RX (listen):** a **differential sense of line 2** — `P2 → C16 (1 µF) → MIC1P`, `P1/GND → C17 →
  MIC1N` — AC-coupled and high-Z (no DC bus load, BUS-1); the differential tap rejects hum and the
  ~0.5 V common-mode.
- **TX (talk):** the codec DAC drives line 3 — `OUTP → C14 (DC-block) → TALK_BRIDGE → R28 (2.2 kΩ) →
  P3` — the same 2.2 kΩ line-3 strap the handset's S2 asserts. **K1** gates `TALK_BRIDGE ↔ line 4`,
  asserting the **DC talk handshake** off the held Türruf (so TX is session-gated). ⚠ Whether the
  TV20/S forwards line-3 audio to the door once it sees that bridge is bench-gated — see "TX-out reach".

Tapping 1/2/3 (not the WF26 *speaker* pair P1/P5) keeps the smart audio **independent of line 4 / K3 /
the gong-suppress**, so it works with the gong muted.

Consequences:
- **No acoustic echo cancellation.** Both directions are never streamed at once, so AEC is moot —
  full-duplex is physically impossible on this bus regardless of MCU, and the half-duplex path the
  bus supports is within the C6's reach (I²S codec + ESPHome half-duplex).
- **Sequencing, not mixing:** assert direction → settle → stream → release → stream the other
  (walkie-talkie cadence).

**"Can we send?" — session sense.** The Türruf DC (line 4) holds for the **whole session** (the handset
seals the latch in from P2 — see "Bell signals"), so **OC1, which senses line 4, stays asserted edge
to edge**. So "session active" = **OC1 high**, gated directly: no talk-window timer needed (just
debounce). Audio is gated on the session, direction by K1:

| Session (OC1) | K1 | State |
|---|---|---|
| inactive | – | no session — neither RX nor TX |
| active | open | listen → **capture (RX)** |
| active | closed | talk → **send (TX)** — line 3 asserted via the K1 handshake |

⇒ "can I send right now?" = **OC1 high AND K1 closed.**

**Codec + front-end (committed to the netlist; analog values provisional):**

- **U3 = ES8311** (mono codec, WQFN-20 3×3, 0.4 mm pitch; LCSC C962342) — mono fits half-duplex.
  Pinout per datasheet: CCLK=1, MCLK=2, PVDD/DVDD=3/4, DGND=5, SCLK=6, ASDOUT=7, LRCK=8, DSDIN=9,
  AGND=10, AVDD=11, OUTP/N=12/13, DACVREF/ADCVREF/VMID=14/15/16, MIC1N/P=17/18, CDATA=19, CE=20
  (pull-down → addr 0x18), EP=GND.
- **TX front-end:** `OUTP → C14 (1 µF DC-block) → TALK_BRIDGE → R28 (2.2 kΩ) → P3`, with **K1** gating
  `TALK_BRIDGE ↔ P4` (the handshake). The DAC drives **single-ended** off OUTP; OUTN → C15 → /OUTN is
  parked (terminating OUTN vs OUTP-only is a bench decision).
- **RX front-end:** `P2 → C16 (1 µF) → MIC1P`, `GND → C17 → MIC1N` — fed **differentially** to the
  ADC. The old divider resistors **R24–R27** (on the now-dead SEC_A/SEC_B nets) are to be
  **repurposed** as the MIC-bias network (bias MIC1P/N to VMID) and any TX attenuation — values per
  the ES8311 line-in reference design (bench-gated).
- **Support net:** PVDD/DVDD/AVDD → +3V3 with decoupling; DACVREF/ADCVREF/VMID reservoir caps;
  CE/DGND/AGND/EP → GND. Symbols/footprints imported with `easyeda2kicad` into `kicad/lib_audio/`.
- **EP grounding (no vias):** the QFN-20 centre EP carries no thermal vias — paste over open vias
  wicks solder away, and the codec dissipates milliwatts. EP (and pin 10/AGND, tied to it) bonds to
  GND through adjacent copper.

**As-built caveat — line 3 not high-Z at idle (BUS-1).** The transformer-less plan gated the audio with
K1 so line 3 is high-Z when not talking (`… → R16 → K1 → P3`). As built, K1 gates only the **handshake**
(TALK_BRIDGE↔P4); the codec→C14→R28→line 3 path is **always** connected, so the codec sits ~2.2 kΩ on
the shared talk line whenever it drives, and keeping it quiet is firmware discipline (mute the DAC
unless talking). A real BUS-1 deviation — tracked in TODO (move K1 into the R28→P3 path if the bench
shows the idle load/leak matters).

**Bench-gated / open (analog front-end):**
- **RX — direct ES8311 differential input vs an external in-amp.** Confirm the mic input is high-Z /
  differential enough to tap P2↔P1 directly; add a buffer/in-amp if not.
- **MIC bias + TX level.** Bias MIC1P/N to VMID (repurpose R24–R27); set the codec digital volume to
  the handset's mic-through-2.2 kΩ level, don't overdrive the TV20/S amp (AUDIO-6).
- **SAFE-7 protection on the P2/P3 taps** — series R + TVS clamp (above +12 V); DC-block ratings
  ≥ 25–50 V (and the broader bus-TVS question, see TODO / "Protection").
- **Hum** with the P1↔GND bond once RX is live.
- **⚠ TX-out reach (bench-gated).** Not yet confirmed on hardware: that the TV20/S **forwards the
  line-3 audio out to the door station** once it sees the R28 2.2 kΩ line-4↔line-3 handshake bridge,
  and that the line-3 drive level reaches the door cleanly. (The handset's own audio rides its
  internal line-4 path and goes quiet under gong-suppress — acceptable; nobody uses the handset while
  it's muted.)

---

## On-board passive WF26 core (the unpowered fallback)

The board **replaces** a WF26 — replacement-only, there is no parallel mode. So it carries a
**hardwired passive WF26 core** (the handset's own circuit, reproduced on-board), and the smart layer
(ESP32, codec, sense optos, K1/K2/K3) is strictly **additive** on top of it.

**Fail-safe principle.** With **no board power** the board must behave like a plain WF26. So the
passive core (transducer, C1, the Türruf-driven latch relay, R1, the talk/door switches) is a
**self-contained circuit needing no board power**, and the smart layer defaults to
inactive/transparent when unpowered (SSRs off, optos passive, codec quiet).

### The passive WF26 core (the `WF26_*` parts)
These reproduce the handset (see "WF26 internal circuit") and run with zero board power:
- **LS1** — 16 Ω speaker/mic across **P1↔P5** (doubles as the mic for talk).
- **WF26_C1** — 22 µF across **P5↔P4** (the gong audio crossover; the `CHIME_C1` node sits between K3
  and this cap).
- **WF26_K1** — the **latch relay** (G6K-2F-Y), coil across **P1↔P4**, pulled in by the ring's own
  ~12 V Türruf DC pulse and then **sealed in from P2** (see "Bell signals"); its NO contact routes
  listen **line 2 → S1 → K1_COM → P4 → C1 → speaker**. **Bus-energised, not GPIO-driven** — that's
  what makes listen work unpowered. A **flyback diode (D1)** clamps its coil (the stock handset lets
  the speaker across the coil damp the kick; K3-in-series-with-C1 breaks that path, so the board adds
  its own clamp).
  - *Future option — fold the session-sense into this relay and drop OC1 (NOT adopted; OC1 kept for
    now, the opto sense works):* make it a **12 V DPDT** with the **coil on P4↔P1**; pole A = K1_COM↔P4
    (listen); pole B = **3V3 → GPIO + pull-down** = a galvanically-isolated, non-inverted **session/ring
    signal** (energised = HIGH) replacing OC1's opto sense (+ its limiter and clamp D8).
- **WF26_R1** — 2.2 kΩ talk resistor (`P4 → R1 → R1_BRIDGE`).
- **WF26_S1 (door, DPDT) and WF26_S2 (talk, DPDT)** — SPPJ322300 slide switches wired as in the
  handset, so a person can open the door / talk by hand with the board dead.

### Smart layer defaults (additive, off at rest)
- **K3** (NC SSR) is closed de-energised → the gong rings unpowered / at boot; chime-suppress acts
  only when the ESP energises it.
- **K1/K2** (NO SSRs) default open (gate pull-downs) → they parallel the passive S2/S1 paths; powered
  they add app talk/door, unpowered they vanish.
- **OC1/OC2** sense and the **codec speech-pair tap** (lines 2/3) are high-Z, AC-coupled, and
  independent of the gong-suppress — so the smart RX/TX path works with the gong muted, and the board
  adds only negligible load beyond a stock WF26 (BUS-1).

### Enclosure reuse (the existing WF26 housing)
The replacement variant drops into the **existing WF26 enclosure**, so outline, mounting and
placement are set by the housing, not by the part count — it's a mechanically-driven re-floorplan,
not a tweak of the current board:
- **Outline + mounting holes** match the WF26's own PCB: **64 mm (W) × 59 mm (H)**. The board is at
  that size, with **H1/H2 (NPTH 3.2 mm)** on the enclosure's existing bosses — **25 mm up from the
  bottom edge, at the left/right edges** (confirm the exact boss positions against the real WF26
  with calipers).
- **Placement is pinned to the enclosure's openings**, not optimised for routing: the transducer
  behind the **speaker grille**, S1/S2 under the existing **button apertures**, and J2/J3 (the 5-wire
  bus) at the housing's **wire entry**. The switch **plunger tips** must land where the enclosure
  buttons press them — given **relative to the board edges**, so they survive an outline move:
  - **S1 (top button, door release):** **17 mm from the top edge, 20 mm from the right edge**.
  - **S2 (bottom button, talk):** **5 mm from the bottom edge, 20 mm from the left edge**.
  Marked as crosshairs on **Dwgs.User** in the PCB; the edge-relative figures here are the source of
  truth — re-derive the absolute marker coordinates from the current Edge.Cuts if the outline shifts.
- **Power entry:** the WF26 has no USB/power opening, so the 5 V feed needs a route in (cable gland,
  an existing aperture, or an added hole) — the bus can't supply it.
- **Antenna:** U1 (MINI-1U) uses a **u.FL external antenna** — route the antenna lead out of the
  housing; no RF-transparent PCB-antenna region is needed (unlike the old WROOM-1).
- **Z-height:** **TBD** — measure the cavity depth; USB-C, the relays, the screw terminal and the
  transducer must fit it.
- Outline is **64 × 59 mm** (above); still take the **mounting pattern** and the
  **speaker / button / wire-entry positions** from the **real WF26** (and `wf26/wf26.kicad_pcb`
  where it captures them).

### Still to resolve
- **S1 is a DPDT, not just a door button** — at rest it routes P2→K1_COM (enabling listen); pressed
  it shorts P2↔P3 *and* lifts P2 off K1_COM. Reproduce that switching; don't hardwire P2→K1_COM.
  K2 only parallels the door-short half.
- **Power feed** for the smart layer (USB-C / local 5 V): the WF26 needs none, so replacement mode
  must degrade gracefully to passive when the feed is absent.
- **Small non-identical loads** vs a stock WF26: each opto still pulls ~2 mA off a ringing line, and
  the codec RX tap adds a small AC load on line 2 — negligible, but not zero (BUS-1).

---

## Verification status

Automated gates (run by `./build.sh all-route`): **ERC 0 errors, DRC 0/0, routes
0 unrouted, `check_pcb.py` PASS** — these verify the authoritative KiCad files; the
gerbers/BOM/CPL in `kicad/fab/` are exported from them. The firmware config passes `esphome config firmware/doorbell-v4.yaml`
(ESPHome 2026.5.3; needs a `secrets.yaml` with `wifi_ssid`/`wifi_password` alongside).

An independent blind review (no DESIGN.md / generator scripts; netlist extracted from the
current schematic, every pinout re-checked against manufacturer datasheets, intercom logic
cross-checked against the TV20/S PDF + `wf26/wf26.kicad_sch`) is recorded in `VERIFICATION.md`
— it found **0 polarity / pin-mapping / pin-usability errors** (ERC 0/17) and converged with
this document on all system-level conclusions, including the corrected WF26 seal-in model.

**Cross-checked against the WF26** (netlist extracted from `wf26/wf26.kicad_sch` with `kicad-cli`):
the bus pin map; the door/talk split — **K2 = a direct P2↔P3 short** (genuine S1), the 2.2 kΩ (R28) on
the K1 talk strap (genuine R1); K3's chime-mute sits in the **C1 audio path** (P4↔C1), not line 4, so
it can't touch the latch or the Etagenruf; the WF26_K1 coil is across **P1↔P4** (ring-driven, then
sealed in from P2 — see "Bell signals"); and K1/K2/K3 are independent (no interlock, like the handset).
**Session state = OC1 high**, gated directly (line 4 holds through the session), no timer.
**The end-to-end TX-out reach is the remaining open investigation** — the codec taps the speech pair
(RX ← line 2 differential, TX → line 3 via K1's handshake, gong-suppress-independent); what's
bench-gated is whether the TV20/S forwards the line-3 audio to the door once it sees the R28 talk
bridge (see `TODO.md`, "TX-out reach"). See Switches / Audio path / Bell-sense.

**Datasheet-verified:** GAQY212GS / GAQY412EH PhotoMOS pinout + Ron/Voff/LED drive (K3 = 1-Form-B
**NC** confirmed); WF26_K1 (G6K-2F-Y) latch pinout; SGM2212 SOT-223 pinout + ~1 V dropout headroom;
1N4148W pin 1 = cathode (CDFER lib); LTV-217 pinout; USB front-end (D+/D− not swapped; TPD2S017
pinout/V_CC bias, CC 5.1 kΩ Rd); bell-sense GPIO LOW levels; ES8311 full pinout; every U1 pad↔GPIO assignment against the
**ESP32-C6-MINI-1U-H4** pinout (the GPIO map's pad numbers are the MINI-1U pads, from the schematic).

**Known minor items (accepted):**
- One 0.388 mm bus↔logic clearance spot (<0.5 mm aspiration; fine for 12 V).
- A benign plane-stitch warning on U1's EPAD.
- No board fiducials (generator support exists, disabled): JLCPCB's CAM added two marks
  on the V4 proto, and the production drill file shows they are **drilled 1.152 mm
  positioning holes** (JLCPCB's standard SMT tooling size) through a 1.55 mm pad on both
  outer layers — mechanical fixture-registration holes, not flat optical fiducials. One
  sits at ~(2.1, 68.25), just west of (outside) the antenna copper-clear zone (estimated
  impact < 0.3 dB — accepted for proto); the other at (36.0, 64.5) west of U3 (the codec). Because
  they register the assembly fixture, optical fiducials alone may not prevent them —
  V4.1: re-enable our own fiducials **and** pre-place 1.152 mm tooling holes at
  controlled positions (or carry an order remark keeping CAM-added holes away from the
  antenna edge).
- **Mounting holes H1/H2** (NPTH 3.2 mm) on the enclosure bosses; three commissioning test points: TP1 = GND at (37.5, 62.5) (= P1, the bus common — now bonded to board GND — the scope-ground anchor), TP2 = +5V at (46.3, 21.1), TP3 = +3V3 at (28.6, 39.152). Bare 1.5 mm pads, excluded from BOM/CPL.
- Bench-confirm the relay-coil voltage under WiFi TX with a long USB cable if paranoid.
