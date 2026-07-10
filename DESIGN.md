# Doorbell controller (Klingel V4) — design reference

**What the board must do is in [`REQUIREMENTS.md`](REQUIREMENTS.md); this doc is *how* it does it.**
When the design changes in a way that affects behaviour, update REQUIREMENTS.md too.

**V4 source of truth: the KiCad files** (`kicad/doorbell.kicad_sch` / `kicad/doorbell.kicad_pcb`),
edited directly in KiCad. `./build.sh all-route` verifies them — the checks KiCad's own DRC/ERC
can't express (connectivity + the copper-thieving sliver limit in `route.py`, placement in
`check_pcb.py`) — and exports the fab outputs; it does not generate the board.
`tools/doorbell_design.py` holds the placement constants `check_pcb.py` verifies (connector edge
fit, mounting-hole MLCC keep-out); the KiCad files are authoritative for everything else.
V4 firmware: `firmware/doorbell-v4.yaml`. LCSC part numbers live in the schematic symbols as hidden
`LCSC`/`Description`/`MPN`/`Datasheet` fields (the JLCPCB library symbols carry most; the rest are
set by hand) and `tools/jlcpcb_files.py` reads them from the schematic for the BOM.
Ordering: `ORDERING.md`. Reverse-engineered handset: `wf26/wf26.kicad_sch`.
Intercom system reference: `docs/design/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`;
central-unit photo: `docs/design/tv20s-board.jpg`.

V3 — the retired perfboard predecessor, replaced in the wall by the V4 — is documented in its
own section below (source: `docs/design/KlingelV4.fzz` Fritzing schematic).

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
   line 2 (P2↔P1), TX driving line 3 (P3) through a DC-block + 2.2 kΩ gated by K1, with the talk
   handshake sourced from P2 through a gong-stripping RC low-pass. No isolation
   transformer; **P1 is bonded to board GND** (analog component values bench-gated)

The board never touches the 8–12 VAC door-opener current — switched entirely inside the TV20/S. The
bus carries only low-voltage signalling (≤12 VDC, mA-level): the three ESP-driven switches (talk,
door, chime-mute) are **PhotoMOS SSRs**; the one electromechanical part is the **passive WF26 latch
relay**, which the bus drives itself (so it works with the board dead).

---

## WF26 connector — J2, a 5-way DB125-3.5-5P terminal block (3.5 mm)

**Connector:** the **5-way (P1–P5)** WF26 bus on a single **DB125-3.5-5P** (DORABO, LCSC C3646874)
3.5 mm **screw terminal** — **J2**, pins 1–5 = P1–P5 — assembled by JLCPCB. The WF26
bus wires are fine, flimsy stranded (~26–28 AWG flat cable), below the rated minimum of Wago
picoMAX/221 push-in connectors (0.2 mm² ≈ 24 AWG); a screw terminal clamps thin stranded reliably
(tin/fold the ends) and matches what the WF26 uses internally. One 5-pole block spans the whole bus on
a continuous 3.5 mm pitch (no inter-block gap). **Line 4 is one net (P4)** — there is no IN_P4/P4 split,
because chime-suppress no longer breaks line 4 (it opens C1; see "Relays" / "Audio path").

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| Line | TV20/S role | Role in our circuit |
|------|-------------|---------------------|
| **P1** (= board GND) | Common reference (all bell/speech ref to line 1) | Bonded to board GND; opto LED returns (each via 5.1 kΩ to P1); the codec RX/TX reference |
| **P2** | Listen leg; ÖT pair with line 3 | **K2** door bridge (to P3); **RX tap** (P2 → C16 → codec ADC); SW3; the **P2 supply** that seals the WF26 latch in. **Idles at +12 V vs P1** — a continuous standing bus rail (`captures/runs/`: 12.06–12.11 V at rest), sagging to ~9.4 V under the seal-in load during a session and momentarily to ~2.6 V at session-end before snapping back |
| **P3** | Talk leg; ÖT pair with line 2 | **K2** door bridge (from P2); **TX inject** (codec DAC → R26 2.2 kΩ → C14 → TX_OUT → K1-ch2 → P3, plus the gong-filtered Ra/Cf/Rb handshake leg onto TX_OUT); WF26 talk/door switches |
| **P4** | Türruf — ~12 VDC front-door gong + tone | **OC1** sense; **K3** chime-mute (P4↔C1); K5 coil + flyback **D1**; R29 |
| **P5** | Etagenruf — apartment/floor call (tone) | **OC2** sense; **LS1** speaker (P5↔GND); C19 (the gong cap, P4↔P5) |

**Door opener (K2, SSR).** Energising K2 bridges **P2↔P3 directly** (a dead short, no series R) →
the TV20/S reads the ÖT and fires the opener. **Chime suppress (K3, NC SSR).** K3 sits in the gong's
**audio path** — between line 4 and the coupling cap C1 (K3: P4↔CHIME_C1, then C1: CHIME_C1↔P5). At
rest (de-energised) it is closed, so the Türruf gong reaches the speaker and OC1 senses line 4;
energised it opens, muting the gong **without touching line 4, the latch, or the Etagenruf** (which
reaches LS1 directly on line 5, bypassing C1).

**Door-open mirrors S1 — break-before-make in hardware (DOOR-4 / MODE-3 / BUS-2 c).** A door-open must end the
session exactly as the handset button does: drop the K5 latch. The handset's **S1 is a DPDT
*transfer*** — it lifts P2 off K1_COM (breaking the seal-in) just *before* it bridges P2↔P3, so the
latch drops as the opener fires and the live Türruf on line 4 never reaches line 3. K2 alone (a plain
P2↔P3 short) can't do that — it would leave the latch sealed and bridge `P4 → K5 → P2 → K2 → P3`,
injecting the ring (12 V DC + gong AC) onto the talk line. **Bus-confirmed both ways:** a *handset*
door-open ends the call within ~1.5 s (`captures/runs/neighbour-ring-door-open`), whereas a bare P2↔P3 relay
short (the V3 controller, API-triggered during a live session) leaves the latch **sealed for ~51 s**
(`captures/runs/door-open-call-held`) — exactly the "K2-alone leaves it sealed" case this transfer exists to avoid.
So the board reproduces S1's transfer with
two extra parts, both on the **DOOR_DRV** gate:

- **K4** (GAQY412EH, NC SSR) sits **in series in the seal-in** (`SW3.6 → K4 → K5.3`, in the
  `P2 → K1_COM` path). Energised it **opens** → the seal-in breaks → K5 drops. At rest it's closed,
  so the passive/unpowered latch is untouched (MODE-1 / SAFE-4).
- **The break leads the make.** K4's LED is driven straight off DOOR_DRV (opens immediately), while K2's
  LED returns to ground through **Q3** (an **AO3400A** logic-level N-FET) whose gate (DELAY_GATE) ramps on
  **R17 (100 kΩ) · C18 (1 µF) ≈ 38 ms** — so K2 closes ~38 ms *after* K4 (≥~14 ms at the fast Vgs(th)/cap corner), well past the ~6 ms latch drop.
  One gate (DOOR_DRV), hardware-timed break-before-make; the firmware just pulses the door line.

With the seal-in broken before P2↔P3 closes, the held Türruf is never bridged onto line 3 — so this
**supersedes the old ~1.75 s "wait out the gong" firmware delay** (there's nothing left to wait out; the
delay is retirable — see TODO). Boot/idle: DOOR_DRV low ⇒ Q3 off (K2 open) and K4 LED off (K4
closed) ⇒ fail-safe (SAFE-6). The latch otherwise stays pulled in for the ~60 s call window (a door-open
is now the deliberate way to end it early).

**Door-open max-on-time watchdog (DOOR-5) — Q4 + R25 · C20 · D11.** A firmware hang that left
DOOR_DRV latched high would hold the opener "pressed" indefinitely — the TV20/S is passive and does not
time-limit it. A hardware one-shot bounds it: DOOR_DRV charges **C20 (2.2 µF)** through **R25 (10 MΩ)** (τ ≈ 22 s), and once that node (WD_GATE) crosses the FET threshold **Q4** pulls DELAY_GATE low — turning off Q3, so **K2 opens and the P2↔P3 bridge releases** even with DOOR_DRV still asserted (**~8.4 s** typ; ~5–18 s across the AO3400A's Vgs(th) 0.65–1.45 V spread). R25 is set to **10 MΩ** so the **worst-fast corner** — min Vgs(th) 0.65 V, R -1 %, and the 16 V X5R cap derated to ~1.45 µF by tolerance + temperature — still trips at **~3.1 s**, comfortably past the 1.75 s firmware pulse. The logic-level FET also makes the watchdog **provable at the guaranteed-slow corner**: even holding the AO3400A's full ±100 nA IGSS (a 12 V spec, far smaller at ≤3.3 V) across the 10 MΩ costs 1.0 V of plateau, and the remaining ~1.6 V at the worst-case GPIO VOH floor still clears Vth,max 1.45 V — the 2N7002's 2.5 V Vth,max could not make that claim. Only the lower bound matters for a backstop, so the wide upper bound is fine; a 74LVC1G17 Schmitt + C0G is the route to a *tight* window if one is ever wanted. **D11 (1N4148W)** dumps C20 the instant DOOR_DRV drops, re-arming for the next pulse. The 1.75 s firmware pulse ends long before the timeout, so a real open is never cut. It
releases **K2 only**: K4 stays energised in the fault (it merely holds the seal-in broken, harmless),
and a reset/brownout still drops everything through the gate pull-downs — so this is defense-in-depth
over the ESPHome task watchdog (which also reboots a hung MCU). Q3 (break-before-make) and Q4
(this watchdog) are separate **AO3400A** SOT-23 logic-level N-FETs — chosen (over the 2N7002) so the
worst-case GPIO plateau clears Vth,max with margin; the R17/R25 RCs are sized for its 0.65–1.45 V
Vgs(th) window. Verified in `sim/test` (still bridged at the 1.75 s pulse; releases within the timeout).

> **Line 4 carries the Türruf** (PCB net **P4** — one net, no IN_P4/P4 split). Inside the handset core
> it is the junction of C1, R1, the K5 coil and its NO contact: the ring's **DC energises the
> coil** (coil = P1↔P4 = common↔Türruf — a ~1 s TV20/S pulse, then sealed in from P2), and its **AC
> tone reaches the speaker via C1** (P4↔P5 → LS1 = the gong). **Talk** is a 2.2 kΩ bridge of **line
> 4↔line 3** (S2 + R1); **listen** routes line 2 → K5 → P4 → C1 → speaker. **Chime suppression
> opens C1** (K3, NC, in the P4↔C1 path) so the Türruf tone never reaches the speaker — line 4, the
> latch and the Etagenruf are untouched. There is no local tone generator (no ICs); the chime *is*
> the audio on line 4. See "WF26 internal circuit" below.

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | J2 pin |
|--------|----------|
| Orange | P1 — J2.1 |
| Green | P2 — J2.2 |
| Blue/white stripe | P3 — J2.3 |
| Blue | P4 (line 4, Türruf) — J2.4 |
| Black | P5 — J2.5 |

> All five WF26 bus wires land directly on the one 5-way **J2** (P1–P5 = pins 1–5), with **no jumper**,
> since line 4 is a single net now (chime-suppress no longer breaks it; see "WF26 connector").

---

## TV20/S reference facts (confirmed from the STR PDF)

From `docs/design/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` (*Verdrahtungsplan* + *Fehlersuchhilfe*):

- **Power:** NTR201 transformer, 230 V~ → **12 VAC**; feeds the TV20/S control unit.
- **Door opener (Türöffner Tö):** **8–12 VAC, 1 A max** (~5–15 Ω), switched by the TV20/S
  on its terminals **8/9** — our board never carries this current. The central unit
  (`docs/design/tv20s-board.jpg`, a discrete relay/analog board) carries a **1–12 + earth +
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
  `our-ring-after-neighbour`) presses the genuine handset's **break-before-make DPDT S1**, which opens **P2↔K1_COM** (the
  seal-in) ~6 ms *before* it closes the P2↔P3 bridge — so the coil drops (line 4 falls and P2 *rises*
  ~9.4→11 V as the ~29 mA coil load comes off it, then both settle ~9 V at the bridge); the **~60 s
  timeout** (after the last talk activity, or the initial Türruf with no talk) ends it by a brief **P2-low pulse** — **bench-confirmed, `our-ring-no-door`** (a ~58.5 s hold that
  released with **no door-open**): the TV20/S **sinks P2**, line 4 tracking 0.18 V under it through the
  closed seal-in contact (both fall ~9.3 → 2.5 V), so the K5 coil loses its supply and drops, line 4
  following then releasing to 0. The tell that it's P2 driven (not line 4): **P2 holds a ~2.8 V plateau
  for ~18 ms *after* line 4 has separated and fallen to ~0**, then snaps back to 12 V — a *held* low,
  not an unload (which would recover the instant K5 releases); P2 also leads line 4 at the fall onset
  by ~60–100 µs. P3 stays cold throughout. (Which line is pulled is **immaterial to the board** anyway
  — we sense line 4 via OC1, which falls either way.)
- **Tones:** Türruf = **3-Klang-Gong** (3-chime) — the gong is an **AC tone superimposed on the
  line-4 DC pedestal at the *start*** of the window; once the chime finishes, line 4 holds
  **steady DC** for the remainder. Spectral model (fitted from the 50 kSa/s `our-ring-no-door`
  capture): three strikes ~0.78 s apart, fundamentals **1010 → 840 → 672 Hz** (≈ 6:5:4 over the
  672 Hz root — a descending major triad: fifth, third, root), each an odd-harmonic series
  (3f, 5f, 7f…) with partial decay constants τ ≈ 1.1–1.9 s; audible ~3.9 s total (full partial
  table in `captures/runs/our-ring-no-door/notes.md`). Etagenruf = **Dauerton** (continuous).
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

`docs/design/tv20s-board.jpg` (component side) shows the speech path built on dedicated audio power
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
`docs/design/intercom-teardown-collage.png`). Parts: LS1 (16 Ω speaker/mic),
**S1 (Türöffner / door release, DPDT)**, **S2 (Sprechen/Hören / talk, DPDT)**, R1 (2.2 kΩ,
colour bands red-red-red-gold), C1 (22 µF/50 V), K5 (6-pin DIL SPDT signal relay,
HJR-4102-N-12V), J1 (5-way bus = P1–P5).

**The numbering is canonical: Pₙ = bus line n** (J1 pin n → Pₙ), confirmed by measurement — the
door-opener bridges **P2↔P3** (= the ÖT pair, lines 2/3) and the speaker sits across **P1↔P5**
(common + Etagenruf), leaving **P4 = line 4 (Türruf)**.

| Net | Pins |
|-----|------|
| P1 *(line 1, common)* | J1.1, LS1.1, K5.8 (coil) |
| P2 *(line 2)* | J1.2, S1.2, S1.5, S1.6 |
| P3 *(line 3)* | J1.3, S1.3, S1.4, S2.3, S2.4 |
| P4 *(line 4, Türruf)* | J1.4, C1.1(+), R1.1, K5.5 (coil), K5.6 (NO) |
| P5 *(line 5, Etagenruf)* | J1.5, C1.2(−), LS1.2 |
| K1_COM | K5.1, K5.12, S1.1 |
| R1_BRIDGE | R1.2, S2.2, S2.5 |
| n/c | S2.1, S2.6, K5.7 (NC) |

Topology: LS1 across **P1↔P5**; C1 across **P5↔P4** (**+ toward P4**, the Türruf +12 V DC side);
the relay coil across **P1↔P4**; R1 from **P4** to R1_BRIDGE (the talk-switch common).

Key facts:

- **Door release = direct P2↔P3 (no resistor).** S1 (Türöffner) *pressed* shorts **P2↔P3**
  directly — the ÖT bridge, exactly the TV20/S test *"Klemmen 2 u. 3 brücken."* *Released*, S1
  parks P2 on K1_COM. **R1 (2.2 kΩ) is *not* in the door path** — it lives on the talk switch.
- **Talk = P4↔P3 through R1 (2.2 kΩ).** S2 (Sprechen) *pressed* ties R1_BRIDGE↔P3, putting R1
  across **P4↔P3**; *released* it parks on the unused NC (open). The talk handshake the TV20/S
  sees is a **2.2 kΩ bridge of line 4 to line 3**.
- **Why the talk bridge is resistive, not a short.** During a held session K5 ties **P2↔P4**
  (the listen path), so the talk bridge **P4↔P3** is electrically **P2↔P3** — the *door-opener*
  pattern. The 2.2 kΩ keeps it below the opener's fire threshold (a dead short fires; 2.2 kΩ does
  not), so talking can't pop the door; it also limits the load on the line-4 session hold.
- **The relay coil is across P1↔P4 = common ↔ Türruf, so the house ring energises it directly.**
  The TV20/S **pulses line 4 high for ~1 s** — ~12 V/320 Ω ≈ 37 mA through the coil to common — and
  pulls K5 in. After that the TV20/S lets go of line 4; **P2 seals the latch in** (`S1 NC →
  K1_COM → the closed NO contact → line 4 → coil`), so the **handset holds line 4 hot from the P2
  supply** for the session — the TV20/S is not driving line 4. **Dropping line 4 does *not* release it** — P2
  holds it; the session ends via **P2**: at a door-open S1's **break-before-make** transfer opens
  P2↔K1_COM ~6 ms *before* bridging P2↔P3, dropping the coil (line 4 falls, P2 *rises* as it unloads —
  **bench-confirmed, `our-ring-after-neighbour`**); or the ~60 s inactivity timeout ends it by a brief **P2-low pulse** (**bench-confirmed,
  `our-ring-no-door`**): the TV20/S sinks P2 — **held ~2.8 V for ~18 ms *after* line 4 has separated and
  fallen to 0**, so it's P2 *driven* low (line 4 merely follows) — dropping the K5 coil. P3 stays cold
  (no door-open). Which line is pulled is immaterial to the board anyway (OC1 sees line 4 fall either
  way). **K5:**
  6-pin DIL SPDT (1 Form C), HJR-4102-N-12V, coil 5/8 (~320 Ω), common
  1+12 = K1_COM, **NO pin 6 = P4**, NC pin 7 = open. Energised → K1_COM↔P4.
- **Single transducer:** LS1 (16 Ω) is the **only** transducer (no separate mic), across
  **P1↔P5**, reused as speaker and mic for tone output and both speech directions. Everything
  the handset reproduces or picks up is at P1/P5 (its single transducer).
- **C1 (P5↔P4) is the audio crossover.** It couples the speaker-hot node (P5) to the Türruf
  line (P4) — passing audio (AC), blocking DC — the single component straddling the transducer
  and the signalling side. **Polarity: + toward P4 (the +12 V Türruf side), − toward P5 —
  bench-confirmed on the genuine WF26** (its + lead traces to line 4). All three agree: the
  genuine unit, the wf26 reverse-engineered schematic (C1.1+ → P4), and the V4 board (C19/1+ →
  P4 via K3) — only an early +→P5 hand-assumption was wrong.

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

## V3 — the retired predecessor (perfboard)

An ESP32 DevKit + relay module on hand-wired perfboard, replaced in the wall by the V4. Its
sense/relay topology is what V4 carries over.

| Ref | Part | Role |
|-----|------|------|
| U1 | LuaNode32 / ESP32 DevKit (ESP-WROOM-32, 30-pin), socketed | MCU |
| U2 | 2-ch relay module (SONGLE SRD-05VDC-SL-C), separate board | K2 + K3 (active-LOW inputs) |
| OC2, OC3 | PC817 optocouplers | House / apartment bell sense |
| R2 | 5.1 kΩ (2010 SMD) | Opto LED series limiter (shared, in cathode→P1 return) |
| R1 | 1 kΩ (2010 SMD) | Opto phototransistor emitter resistor (shared, to GND) |
| J4–J9 | Camdenboss CTB0158 screw terminals | Wiring breakout |

| GPIO (V3) | ESPHome entity | Direction | Hardware | V4 (S3) GPIO |
|------|---------------|-----------|----------|----|
| 32 | `"Apartment Doorbell"` — binary sensor, pullup, inverted | Input | OC3 collector (P5 / Etagenruf) | GPIO13 |
| 33 | `"House Doorbell"` — binary sensor, pullup, inverted | Input | OC2 collector (IN-P4 / Türruf) | GPIO12 |
| 26 | `front_door_buzzer_bin` — output, inverted | Output | Relay K2 (ÖT bridge) | GPIO10 |
| 25 | `suppress_doorbell_sound_bin` — output, inverted | Output | Relay K3 (chime suppress) | GPIO11 |

V3 netlist verified against `docs/design/KlingelV4.fzz` (nets `WF26-P4`/`WF26-P5`, `N9`–`N12`;
V3's `WF26-IN-P4` mapped to what was V4's `IN_P4` — now merged into the single `P4` net, since V4's
chime-suppress moved off line 4 onto C1).

**Reliability problem (the reason for V4):** Dupont jumper headers between perfboard and
relay module work loose over months. The redesign eliminates all inter-board jumpers by
integrating everything onto one PCB.

**Field failure — the Etagenruf sense is dead.** On the deployed V3 board the apartment
(Etagenruf, line 5) sense no longer fires while the house (Türruf, line 4) sense works. Root cause:
the **shared opto limiter** (one 5.1 kΩ in the common cathode return). A Türruf drives line 4 to
~12 V, lifting the shared cathode node to ~10.8 V and reverse-biasing the *idle* Etagenruf LED past
its 6 V V_R — and that reverse current returns through line 5's 16 Ω speaker, **bypassing the
5.1 kΩ**, so it is limited only by the line-4 source impedance (tens of mA, sustained for the ~60 s
session, on the *frequent* house ring). That cooked the Etagenruf opto's LED; the Türruf opto,
seeing only the milder/brief AC self-reverse, survived. **V4 fixes this with per-opto limiters**
(each idle cathode sits at ~0 V — no shared node to lift, no reverse path to cook), and D9 is
retained. Bench evidence: `captures/runs/floor-call-p5`.

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
| MCU | **ESP32-S3-WROOM-1U-N16R8** (u.FL external antenna; **16 MB** flash + **8 MB PSRAM**) | ESPHome-supported (esp-idf), **native USB-Serial-JTAG** so flashing + logs need no USB-UART bridge or auto-program circuit, and ample GPIO for the audio path (I²S + I²C + 3 SSR gates + 2 opto inputs). **Dual-core LX7 + PSRAM** give the headroom sustained audio-over-WiFi needs: audio buffers live in PSRAM (off the 512 KB internal SRAM) and the WiFi/TLS stack and the audio pipeline run on separate cores — a single-core, no-PSRAM part starves its WiFi RX under audio load and stalls the stream. The GPIO matrix lets any function land on any pad, so the codec bus and the USB escape are placed for clean fan-out (see the GPIO map). Central placement forces the u.FL external antenna (no clean board edge for a PCB antenna). The S3 is **Wi-Fi 4 + BLE 5** (no Wi-Fi 6 / Thread / Zigbee) — irrelevant for a WiFi/ESPHome doorbell |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT), Standard PCBA — the BOM is not Economic-eligible | J2 is through-hole (as are J1's shell stakes) but assembled by JLCPCB — nothing hand-soldered. Part eligibility/stock checks at order time: see `ORDERING.md` |
| Switches K1–K4 + door lead | **PhotoMOS SSRs** — K1 = **GAQW212GS** (dual 1-Form-A NO, SOP-8, 60 V; LCSC C7435123) — talk handshake + TX gate; K2 = **GAQY212GS** (1-Form-A NO, AC/DC, 0.24 Ω Ron, 60 V; C7435107); K3/K4 = **GAQY412EH** (1-Form-B **NC**, AC/DC, ~1 Ω Ron, 60 V; C7435135). Door lead: two **AO3400A** SOT-23 logic-level N-FETs (LCSC C20917) — **Q3** (delay) + R17 (100 kΩ) · C18 (1 µF), **Q4** (watchdog) + R25 (10 MΩ) · C20 (2.2 µF) · D11 | All switch only ≤12 V mA-class bus signals → PhotoMOS territory: no coil power/heat, no acoustic click, no bounce/wear, an optical GPIO↔bus barrier. K1 (talk) and K2 (door) idle **open** (1-Form-A; unpowered talk/door covered by the passive core's S2/S1); K3 (chime-mute) and **K4 (seal-in break)** idle **closed** (1-Form-B NC), so an unpowered/booting board still rings the gong (GONG-3) and keeps the latch sealed (DOOR-4 fail-safe). **K4** sits in the `P2→K1_COM` seal-in and drops the latch on a door-open; the **Q3 · R17·C18** RC delays K2's make ~38 ms behind K4's break, so the board mirrors S1's **break-before-make** (DOOR-4 / MODE-3 — see "Door-open mirrors S1"); a second one-shot (**Q4 + R25·C20·D11**) releases K2 ~8.4 s typ after assertion, so a hung DOOR_DRV cannot hold the opener (DOOR-5). Ron is swamped by series R (K1: the 2.2 kΩ Ra+Rb handshake leg) or negligible vs the 16 Ω speaker (K3: ~−0.5 dB). The passive WF26 latch stays electromechanical — bus-self-latched, must work board-dead |
| SSR LED drive | **GPIO → 10 k pull-down → 220 Ω → SSR LED** (no transistor, no flyback) | Each SSR "driver" is just its LED + a series R: ~9.5 mA from the 3V3 GPIO through R4/R5/R6 (220 Ω — sized so the guaranteed-VOH corner still clears the 5 mA recommended floor); R7/R8/R9 (10 k) pull-downs ⇒ SSRs default **off** at boot (SAFE-6). No coil ⇒ no flyback; the one surviving flyback (D1) is on the passive WF26 latch coil. (Retired the old per-channel relay-driver sheet.) |
| Opto polarity | **Fixed: LED anode → bus line, cathode → R_lim → P1** + **anti-parallel 1N4148W clamp** across each LED | Bus is taken to drive active lines **positive w.r.t. common (P1)**, so polarity is hardwired (no switch) — bench-confirm per channel by ringing each bell. The clamp limits reverse V to ~0.7 V (< the LED's 6 V VR) on the AC tone content |
| WF26 connector | **DB125-3.5-5P screw terminal — J2, 5-way (P1–P5 = pins 1–5)** (LCSC C3646874) | See "WF26 connector". 5-way (not 6): line 4 is one net now — chime-suppress moved off line 4 onto C1, so the IN_P4/P4 split is gone |
| USB-C connector | **GCT USB4105-GF-A-060** (single-row SMD + THT shell stakes, C3025063) | ~⅓ the cost of a THT USB4085 and better stocked; the THT shell stakes keep cable-insertion strength, and the single-row SMD escape is workable on 4 layers |
| Layers | **4-layer** | the USB Type-C single-row escape needs the extra layers + a solid plane reference; see "PCB — layout constraints & rationale" |
| Power | **Two 5 V inlets diode-OR'd** — J1 USB-C and J3 wall feed each through a series SS14 Schottky (D4 / D15) → merged **VBUS** → F1 fuse → **+5V** → **SGM2212-3.3** low-dropout LDO (C3294699) | The per-inlet Schottkys isolate the two sources (neither back-feeds the other) and block a reversed J3 feed; the ~0.45 V drop still leaves ~1 V LDO headroom (an AMS1117's 1.3 V dropout would brown out under WiFi TX) |
| Audio | **Transformer-less half-duplex**: ES8311 mono codec on the bus speech pair — **RX** a differential sense of line 2 (P2→C16→ADC, P1→C17→ADC), **TX** the codec DAC → R26 (2.2 kΩ) → C14 (DC-block) → TX_OUT → line 3, plus the **gong-stripped talk handshake** — P2 → Ra (1.2 kΩ) → Cf (2×22 µF, returned via JP1) → Rb (1 kΩ) → TX_OUT, a 2.2 kΩ bridge whose AC dies in the low-pass — the **dual K1** (GAQW212GS) gating both legs onto line 3 (high-Z at idle, BUS-1). Needs the **hard P1↔GND bond**; analog values bench-gated | Half-duplex by design (single LS1 transducer) ⇒ no echo cancellation. The TV20/S speech path is AC-coupled and P1 sits ~0.5 V from earth, so bonding P1↔GND is benign and lets active AC-coupled front-ends replace the transformer (smaller, fixes the talk-handshake load, no core saturation). Trade: SAFE-3 isolation → *not met*; containment is per-tap protection + F1 (SAFE-7) |
| Form factor | **Single PCB**, no daughter boards | Eliminates inter-board jumpers (the V3 failure mode) |

### ESP32-S3 GPIO map

The authoritative pin assignment lives in `firmware/doorbell-v4.yaml` and the schematic
(`kicad/doorbell.kicad_sch`, U1); it is not duplicated here. **Placement rationale:** U1 sits so the
native-USB pins (IO19/IO20) reach the USB-C connector (J1) / the D5 ESD clamp, and the ES8311 I²C/I²S
bus is assigned **ascending by module pad** (SDA, SCL, MCLK, BCLK, DIN on GPIO38–42, then WS, DOUT on
GPIO2/GPIO1) so it fans out toward U3 in U3's pin order with no crossings. The S3's GPIO matrix makes
this purely a placement choice: any function routes to any pad.

**Boot-state rationale (the part that isn't just a pin list):**
- **SSR gates idle off through boot (SAFE-6).** The three DRV pins are plain GPIO that power up as
  floating inputs; the 10 k pull-downs keep the SSR LEDs dark until firmware drives them. DOOR_DRV
  sits on a pin with no boot-time drive, so the opener can't pulse on reset.
- **Strapping pins parked safe:** the S3 straps on IO0/IO3/IO45/IO46. Only **IO0** is wired — it is the
  boot strap, held high by R11 (10 k to +3V3) for normal SPI-flash boot, with SW1 pulling it to GND for
  download mode. IO3 (JTAG-source), IO45 (VDD_SPI) and IO46 (ROM-log) are left unconnected at their
  module defaults (the WROOM sets its own internal-flash voltage, so IO45/IO46 must float). The I²C/I²S
  bus deliberately lands SCL/MCLK/BCLK/DIN on IO39–42 = the MTCK/MTDO/MTDI/MTMS JTAG group — none of
  those are S3 strapping pins, so it only forgoes pin-JTAG (debug runs over USB-Serial-JTAG) with no
  boot-time effect. EN has the 10 k (R10) + 1 µF (C5) RC + SW2 (Espressif EN-RC spec).
- **No USB-UART bridge:** flashing + logs run over the native USB-Serial-JTAG (IO19/IO20 → D5 → J1).
### Bell / session sense front-end

Two identical channels (OC1 = house bell on P4↔P1, OC2 = apartment bell on P5↔P1):

```
bus line (active, +) ──► opto LED anode ── LED ── cathode ──┬── R_lim (5.1k) ── P1 (common)
                          ▲ 1N4148W clamp, ANTI-parallel ───┘
opto collector ──► GPIO (internal pull-up)   opto emitter ──► GND  (per channel, direct)
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
  K5 coil flyback D1 and Schottky D4 — pin 1 toward +5V there).
  **Both D8 and D9 are kept** — line 4 is *not* pure DC: the Türruf gong's 3-Klang tone (and the
  session-end snap-back) swings P4 to **~−8.5 V** in the measured envelope, reverse-biasing the OC1 LED;
  line 5's Etagenruf reverse-biases the OC2 LED to ~−5 V. The deployed V3 board's Etagenruf opto **died
  of reverse stress** (shared-limiter cross-channel reverse-bias; see "V3"), so this LED avalanches low
  and reverse-bias is its fatal mode — each clamp is cheap insurance against its line's negative swing.
- **Per-opto limiters (R_lim1–2, 5.1 kΩ):** one per channel; a shared limiter lets a ringing
  channel lift the common node and reverse-bias the idle LED — **field-confirmed: this killed V3's
  Etagenruf opto** (see "V3"). With per-opto limiters each idle cathode sits at ~0 V, so there is no
  shared node to lift. Each opto emitter returns **directly to GND** (per channel): the emitter
  current is only µA, so no series resistor is needed, and a per-channel return leaves no shared
  emitter node to couple one channel into another.
- Bell present → LED conducts → phototransistor pulls the GPIO low → ESPHome
  `inverted: true` ⇒ "on". GPIO LOW level ≈ 0.12–0.27 V.
- **Sense margin (by analysis):** at IF ≈ 1.7–2.1 mA (10–12 V line) the collector sits at
  ≈ 0.14 V — far below the ESP32 V_IL (~0.825 V) — and stays there across CTR 0.5→2.6,
  because the weak ~45 kΩ internal pull-up demands only ~56 µA while the opto can sink
  ~0.85 mA even at abused-low CTR. Result is insensitive to opto part variation; with each
  emitter tied straight to GND the GPIO LOW is just V_CE(sat) ≈ 0.1 V.
- **Cross-talk masking** (`firmware/doorbell-v4.yaml`, lambda filters ahead of the debounce):
  - **House Doorbell (OC1)** is masked while PTT is engaged, as a **precaution**: K1 closed
    ties P4↔P3 via the 2.2 kΩ Ra+Rb handshake leg, so P3's resting bias could couple onto
    line 4 and report a phantom ring — which can pulse the door buzzer via
    auto-open. **Bench-unconfirmed, and possibly negligible:** the K5 coil (~1.3 kΩ across
    P4↔P1) clamps P4 toward common (P4 ≈ 0.32·V_P3 through the 2.2 kΩ/coil divider — needs P3 idling
    ≳ 8 V to reach OC1's threshold), OC1's 50 ms debounce already rejects audio-rate AC, and the
    Cf shunt at HS_FILT strips the codec's AC from this path entirely. The mask's cost is that it also blanks a *genuine* ring landing during the
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

### Switches (K1/K2/K3/K4 — PhotoMOS SSRs)

```
K1 (talk+TX gate,  GAQW212GS 2×NO): ch1 P2↔TALK_BRIDGE (→ Ra/Cf/Rb LPF → TX_OUT), ch2 TX_OUT↔P3 — energise: gong-stripped handshake from P2 + codec TX onto line 3
K2 (door opener,   GAQY212GS NO): P2 ↔ P3                  — energise to bridge P2↔P3 (the ÖT direct short)
K3 (chime mute,    GAQY412EH NC): P4 ↔ CHIME_C1            — at rest CLOSED (gong → C1 → speaker); energise to OPEN = mute
K4 (seal-in break, GAQY412EH NC): SW3.6 ↔ K5.3    — in the P2→K1_COM seal-in; energise to OPEN = drop the latch
LED drive: PTT_DRV → R4 (K1 ch1 LED) + R24 (K1 ch2 LED); MUTE_DRV → R6; DOOR_DRV → R5→K2 LED (via Q3 delay) + R21→K4 LED (each Rn = 220 Ω)
```

- **PhotoMOS, bidirectional.** K2/K3/K4 are single-pole (pins 3/4 the AC/DC contact of back-to-back
  MOSFETs, 1/2 the LED); **K1 is the dual GAQW212GS** — two independent 1-Form-A poles in one SOP-8.
  K1/K2 are **1-Form-A (NO)** = open at idle; K3/K4 are **1-Form-B (NC)** = closed at idle. Off-state
  default is fail-safe: K1/K2 open ⇒ no talk/door at boot (the passive core's S2/S1 cover those
  unpowered); K3 closed ⇒ the gong rings at boot/unpowered (GONG-3/SAFE-6).
- **K1 — talk handshake + TX gate (BUS-1).** Two legs meet at **TX_OUT**, both behind the dual K1 on
  **PTT_DRV**: (a) the **handshake leg** — ch1 ties **P2 ↔ TALK_BRIDGE**, feeding `R34 "Ra" (1.2 kΩ) →
  HS_FILT → R35 "Rb" (1 kΩ) → TX_OUT`, with **Cf (C25+C26, 2×22 µF/25 V X5R) shunting `HS_FILT →
  CF_RET → JP1 → GND`** — Ra+Rb = the same 2.2 kΩ line-3 strap the handset's S2 asserts (how the
  TV20/S is told "talk"), but low-passed: the Türruf gong riding P2 during a latched session dies in
  the filter (see "Gong ↔ TX handshake" under "Audio path") while the DC pedestal passes, asserting in
  ~3τ ≈ 75–160 ms instead of a step (whether the talk-detect accepts a ramp is part of the live-bus
  gate, TODO); (b) the **codec leg** — `OUTP → R26 (2.2 kΩ) → C14 (DC-block) → TX_OUT`, joining
  downstream of the filter so Cf never shunts the greeting (the ~90 Ω bus dominates the Rb+Cf load,
  ~1 dB). ch2 ties **TX_OUT ↔ line 3** (the output gate): at idle it lifts line 3 off both legs ⇒
  **line 3 is high-Z (BUS-1 met)**. **JP1 (bridged solder jumper) is the on-board fallback** — cut,
  the leg degenerates to the exact 2.2 kΩ strap (V4.1's step assert, no filter); blob to re-enable.
  **Ra/Rb are 1206/250 mW**, rated for the sustained cracked-short-Cf fault (rail across Ra during PTT
  ≈ 122 mW, across Rb during a concurrent door press ≈ 146 mW; drift-to-open = fail-safe). The
  handshake sources from the **always-on P2** — the session-independent superset, so the board can
  assert talk without an incoming session —
  *pending the bench check that the TV20/S forwards line-3 audio with no session active* (TODO: TX-out-reach).
- **Why TX drives line 3, not line 4.** A WF26 hangs **C1 (22 µF) + the 16 Ω speaker across line 4**
  = a ~20–30 Ω near-short to common across the voice band; injecting there would dump the drive into
  it. Line 3 is light (the TV20/S amp input ∥ the handshake leg's 2.2 kΩ), so the codec drives
  **line 3**, and K1's ch1 supplies the DC handshake from P2.
- **K2 — door opener.** Energise to bridge **P2↔P3** directly (dead short) — the ÖT the TV20/S reads
  as "open". Paired with **K4 + the Q3 delay lead** to mirror S1's break-before-make — see "Door-open
  mirrors S1".
- **K3 — chime mute.** In the gong's audio path (`P4 ↔ CHIME_C1 ↔ C1 ↔ P5 → LS1`). NC ⇒ de-energised
  = closed = gong rings (and OC1, on line 4, still senses — K3 doesn't touch line 4); energise = open
  = gong muted, with **line 4, the latch and the Etagenruf all untouched** (Etagenruf reaches LS1
  directly on line 5, bypassing C1 — structurally non-suppressible, GONG-4).
- **K4 — seal-in break (DOOR-4).** NC SSR in series in the `P2 → K1_COM` seal-in (`SW3.6 ↔
  K5.3`). De-energised = closed (seal-in intact, the passive latch works unpowered); energised
  (off DOOR_DRV, immediate) = open = K5 drops. With K2's make delayed ~38 ms (Q3 · R17·C18) the
  break leads the make — S1's transfer reproduced in hardware. See "Door-open mirrors S1".
- K1/K2/K3 are independent (no interlock); **K4 is ganged with K2 on DOOR_DRV** — the break-before-make
  door pair. Firmware holds **K3 de-energised whenever a ring should be heard**. Whether the TV20/S
  forwards the line-3 audio to the door station once it sees the Ra+Rb handshake bridge is the open
  **TX-out reach** question (see "Audio path").

### SSR LED drive (per channel)

```
GPIO ── R4/R5/R6 (220Ω) ── SSR LED anode │ LED │ cathode ── GND
GPIO ── R7/R8/R9 (10kΩ) ── GND   (pull-down: SSR off while the GPIO floats at boot)
```
Each SSR "driver" is just its LED + a 220 Ω series R (~9.5 mA from the 3V3 GPIO — within the **5–30 mA
recommended range** shared by all three parts (GAQW212GS / GAQY212GS / GAQY412EH; datasheets in
`docs/`), well above their ≤2–3 mA operate current and far under the 50 mA abs-max). 220 Ω (not 300 Ω)
so that even at the **guaranteed VOH floor** (0.8·VDD with a worst-case rail, VF at max) every LED still
draws ≥~5.6 mA — at or above the 5 mA the SUPSiC datasheets attach to "proper device operation and
resetting". The two **dual-load pins** (IO9/PTT_DRV → both K1 LEDs; IO10/DOOR_DRV → K2 + K4) each source ~17 mA, drooping VOH so those LEDs run ~8–9 mA — still comfortably above the floor, but only with the pad **drive strength left at its ≥20 mA default** (the 5/10 mA settings would starve them; FW-3); per-pad ≤~18 mA of 40 mA and the ~37 mA all-asserted aggregate stay within the ESP32-S3 I/O budget. The 10 kΩ
pull-down holds each SSR **off** while the GPIO floats during boot — so the door opener can't
pulse and the chime can't be silenced by a booting/dead board (SAFE-6). No coil ⇒ no flyback;
the one surviving flyback (D1) is on the passive WF26 latch coil.

### Power tree

```
J1 USB-C 5V ──[D4 SS14]──┐
                          ├─ VBUS ── F1 1A fast fuse ── +5V ─┬─ SGM2212-3.3 ── +3V3 ── ESP32-S3 + ES8311 DVDD/PVDD + SSR LEDs
J3 wall 5V  ──[D15 SS14]──┘                                  └─ LP5907-3.3 (U4) ── AU_3V3 ── FB1 600Ω ── AVDD (ES8311 analog)
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3:    10µF + 10µF + 100nF decoupling      AU_3V3: 1µF out (C24)
USB D±  ── IO19/IO20 (native USB)             SGM2212: 10µF in (C_in) / 10µF out (C_out)   U4: 1µF in (C23); EN→+3V3 (seq.)
Two 5V inlets diode-OR'd at VBUS: per-inlet SS14 (D4 = J1, D15 = J3) isolates the sources (no back-feed) and blocks a reversed J3 feed
USB D± ESD: TPD2S017 flow-through clamp (D5), VCC biased from +5V (post-fuse); +5V TVS: SMF5.0A (D10)
VBUS fuse: F1 (0466001.NRHF, 1A fast) after the OR-merge, ahead of all downstream protection — a clamping D10 blows it, isolating both inlets (fail-safe)
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

**Supply-earthing assumption.** The "P1 ≈ earth, so the bond is benign" justification holds only while
nothing *else* ties board GND to earth — it assumes the 5 V feed is a galvanically-isolated,
**floating-output Class II (2-prong) USB supply**, as a normal wall-wart is. The board adds no
isolation of its own, so an **earthed** source (a 3-prong PD brick, or a laptop's earthed PSU while
flashing) pulls bus common (P1) off its natural float to mains earth and closes a ground loop.
**Deploy on a Class II adapter.** The loop is low-energy at 12 V (sub-mA-class, set by the
bus-common-to-earth impedance) and contained the usual way — but note **F1 sits in VBUS, not GND**, so
an attached host shares the *unfused* common; prefer a battery-powered flashing host (see "Build /
test notes").

### BOM

Part values/footprints/LCSC numbers are maintained **directly in the authoritative KiCad files**
(`kicad/doorbell.kicad_sch` / `.kicad_pcb` — the generator scripts are gone). `./build.sh all-route`
**exports** the order files from them (`fab/doorbell-bom-jlcpcb.csv` + `doorbell-cpl.csv`). See
`ORDERING.md` for the stock/eligibility checks at order time.

> J1/J2 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered.

### PCB — layout constraints & rationale

Physical layout — traces, vias, copper zones, component positions, the 4-layer stack — lives in the
authoritative `kicad/doorbell.kicad_pcb`; this section keeps only the decisions and rules behind it.
The board is **4-layer**, ~**64 × 59 mm**, all parts on the top side, and **100 % hand-routed in
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
- **Bus-width policy.** Nets at WF26-bus potential (P1–P5, TALK_BRIDGE, HS_FILT, CF_RET, TX_OUT, CHIME_C1) and +5V are routed
  wider than signal nets — the bus carries the Türruf and the door currents, +5V feeds the LDO and the
  ESP32's WiFi-TX peak (via +3V3). KiCad's DRC does not enforce this; it's a routing rule.
- **Pin assignment exploits the S3 GPIO matrix** (any function routes to any pad) so U1's and U3's escape fans
  route without crossings — see the GPIO map.
- **Copper thieving:** both outer layers carry fill zones; the build refills and checks them. An
  oversized floating island fails the check only if a GND stitching via actually fits inside it (via
  pad + float clearance on each side); it's then grounded with a hand-placed via in KiCad (vias are
  never auto-generated). Pockets too narrow for a via are unavoidable slivers and are accepted.
- **Fiducials:** three `Fiducial_1mm_Mask2mm` marks in an asymmetric triangle so the pick-and-place
  camera resolves orientation; excluded from the BOM and CPL.

### Build / test notes

- **Antenna:** U1 (WROOM-1U) has a **u.FL connector** for an external antenna — route the lead out of
  the housing; there is no PCB-antenna keepout to honour (unlike the old WROOM-1).
- **Programming/bring-up:** flash + view logs over the native USB-Serial-JTAG; BOOT + EN buttons
  fitted for recovery. Two USB entries share the same D±: **J1 (USB-C)** is a bench-only
  convenience for initial bring-up (board off the bus), and **J3 (the JST wall feed)** is both the
  deployed power inlet and the in-field flash port (cable wiring:
  `docs/design/usb-jst-j3-wiring.svg`). Their **VBUS rails are diode-OR'd** (D4 for J1, D15 for J3),
  so both inlets may be powered at once without back-feeding each other — no one-source-at-a-time
  rule. **Field re-flash (OTA failed):** pull the wall-wart plug off J3's far-end cable and plug
  *that same cable* into a laptop. The smart layer reboots, but the doorbell keeps working throughout — the
  passive WF26 core is bus-powered, not USB-powered (MODE-1) — so only HA/notifications drop for the
  minute it takes. **Flash with the laptop on battery** so the host doesn't earth board GND
  (= P1 = bus common); see "Bus↔logic coupling".
- **Bench validation against the real TV20/S** (door pulse, chime suppress, session sense,
  PTT) before it goes in the wall. Wall wire-up map + line-identification signatures:
  `docs/design/wall-wiring-v4.svg`. Probe via the commissioning test points (TP1 = GND
  scope anchor, TP2 = +3V3, TP3–TP8 = watchdog gate + codec taps — net per test point in
  the schematic), J2's screws, and component pads. The board has
  **H1/H2 mounting holes** (NPTH 3.2 mm) on the enclosure bosses; no pre-placed assembly-tooling
  holes (JLCPCB's CAM adds its own panel registration — see "Known minor items" — and the WROOM-1U's
  external u.FL antenna leaves no PCB-antenna keepout for a CAM hole to disturb).
- **3D / fit-test model:** `./build.sh step` exports `fab/doorbell.step` (also run by
  `all-route`). Footprints carrying a truthy custom field **`STEP_Exclude`** are omitted from the
  model — flag SW3/SW4 (set the field in KiCad's Footprint Properties) so the real panel switches
  can be fit-tested against the print. `kicad-cli`'s `--component-filter` is include-only, so
  `tools/step_exclude.py` emits the complement. The *same* flag drives `tools/step_fit_holes.py`,
  which enlarges those parts' THT drills (+0.5 mm) on a throwaway copy so the real switch drops into
  the printed hole — committed board and every fab output keep the as-fab drills. For 3D printing,
  `tools/step_solder.py` then injects
  small **'fake solder' anchor blocks** at every SMD pad (authored directly as AP214 box solids in
  the board's global frame and spliced into the top assembly representation — no CAD kernel needed),
  bridging the board's top face up into each part's leads so components like the K5 relay don't snap
  off the thin printed leads.
- **Printable bare-board model:** `./build.sh step-board` exports `fab/doorbell-board.step` —
  the substrate only (no component bodies), with the mounting holes and THT pad drills cut
  through (`--board-only --no-extra-pad-thickness`). The 80 routing vias (all 0.3 mm, sub-printable
  on a 0.4 mm nozzle) are deliberately *not* cut — they aren't needed for the SW3/SW4 fit-test, and
  the switch + mounting holes are THT pad drills that `--board-only` keeps regardless. It's meant to
  be 3D-printed
  (0.4 mm-nozzle FDM) and the real switches pushed into it to check fit, so the shared
  `tools/step_fit_holes.py` enlarges the **`STEP_Exclude`**-flagged footprints' THT drills by
  +0.5 mm (SW3/SW4: 0.9→1.4 mm signal, 1.35→1.85 mm peg) on a throwaway copy to compensate for FDM
  undersizing — the committed board and every fab output keep the as-fab holes. Standalone; not part
  of `all-route`. The board's **top face
  is flat**; its bottom carries a ~0.035 mm copper annular ring around every plated hole/via (the
  bare board's real copper — board-only has no flag to omit it). For a clean first layer, **print the
  top face down** (holes are through, so flipping doesn't affect the fit-test) or sink the model
  ~0.05 mm into the build plate.

---

## Audio path (half-duplex; analog values + TX-out reach bench-gated)

**The bus is half-duplex by design.** Speech is on the **1/2/3 group** (the STR *Sprechverkehr*):
**listen on line 2, talk on line 3, ref line 1 (common)**. The board taps that pair with an **ES8311
codec, transformer-less** — P1 is bonded to board GND, so the codec senses/drives line 2/3 relative to
that shared common (the SAFE-3 trade; see "Bus↔logic coupling"):

- **RX (listen):** a **differential sense of line 2** — `P2 → C16 → R30 → MIC1P`, `P1/GND → C17 → R31
  → MIC1N`, each codec pin biased to VMID through a 3.3 kΩ shunt (see RX front-end below). AC-coupled
  and high-Z (no DC bus load, BUS-1); the differential tap rejects hum and the ~0.5 V common-mode, and
  the series-R/VMID divider keeps the loud line-2 gong inside the codec's input range.
- **TX (talk):** the codec DAC drives line 3 — `OUTP → R26 (2.2 kΩ) → C14 (DC-block) → TX_OUT → P3` —
  while the **talk handshake** (the 2.2 kΩ line-3 strap the handset's S2 asserts) runs from P2 through
  the gong-stripping low-pass `P2 → Ra (1.2 kΩ) → HS_FILT [Cf 2×22 µF → JP1 → GND] → Rb (1 kΩ) →
  TX_OUT`. The **dual K1** gates both:
  ch1 sources the **DC handshake from the always-on P2** (`P2 ↔ TALK_BRIDGE`) and ch2 gates the output
  (`TX_OUT ↔ P3`) so line 3 is high-Z at idle (BUS-1). ⚠ Whether the TV20/S forwards line-3 audio to
  the door once it sees that bridge is bench-gated — see "TX-out reach".

Tapping 1/2/3 (not the WF26 *speaker* pair P1/P5) keeps the smart audio **independent of line 4 / K3 /
the gong-suppress**, so it works with the gong muted.

Consequences:
- **No acoustic echo cancellation.** Both directions are never streamed at once, so AEC is moot —
  full-duplex is physically impossible on this bus regardless of MCU, and the half-duplex path the
  bus supports is within the S3's reach (I²S codec + ESPHome half-duplex).
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

**Codec + front-end (committed to the netlist; analog values bench-gated for final trim):**

- **U3 = ES8311** (mono codec, WQFN-20 3×3, 0.4 mm pitch; LCSC C962342) — mono fits half-duplex.
  Pinout per datasheet: CCLK=1, MCLK=2, PVDD/DVDD=3/4, DGND=5, SCLK=6, ASDOUT=7, LRCK=8, DSDIN=9,
  AGND=10, AVDD=11, OUTP/N=12/13, DACVREF/ADCVREF/VMID=14/15/16, MIC1N/P=17/18, CDATA=19, CE=20
  (pull-down → addr 0x18), EP=GND.
- **TX front-end:** the codec leg is `OUTP → R26 (2.2 kΩ) → C14 (1 µF DC-block) → TX_OUT → P3`; the
  handshake leg is `P2 → K1-ch1 → R34 "Ra" (1.2 kΩ) → HS_FILT → R35 "Rb" (1 kΩ) → TX_OUT`, with
  **Cf (C25+C26, 2×22 µF/25 V X5R) shunting `HS_FILT → CF_RET → JP1 → GND`**; K1-ch2 gates TX_OUT onto
  P3. The DAC drives **single-ended** off OUTP; OUTN is parked through its own
  `R16 (2.2 kΩ) → C15 → GND` termination (OUTN sees no bus path, so it needs no clamp).
  **R26 + D13 form the OUTP abs-max guard** (the sim's **B1** invariant): C14's bus side lives on
  TX_OUT, and whatever steps that node — chiefly a door bridge yanking P3 to the rail while PTT holds
  ch2 closed — couples through C14 back toward OUTP. **D13 (BAT54S, dual-series
  Schottky — COM → OUTP, anode → GND, cathode → +3V3)** clamps OUTP into the ES8311 analog abs-max
  [AGND−0.3, AVDD+0.3], and **R26 limits the current** into the clamp. The clamp idles in normal use
  (OUTP swings [0, AVDD]); it gives OUTP a **rated** (200 mA) external path instead of leaning on the
  codec's *internal* output ESD diode, which has no published DC rating. The case with teeth is the
  **single-fault C14-short** (MLCC short mode): a door-bridged line 3 then pushes a sustained ~5.5 mA
  through R26 into
  OUTP — D13 sinks it to +3V3 rather than the codec's internal clamp. The order is **series R at the pin,
  cap toward the source** — the convention every codec analog leg follows (OUTP/R26, OUTN/R16, MIC1P/R30,
  MIC1N/R31) — and R26 also isolates the DAC output from the C14 load. R26's series drop on the TX level
  is gain-recoverable (codec digital volume), and the 2.2 kΩ source impedance into
  line 3 **doesn't matter for level**: the WF26's own talk is a **passive 16 Ω transducer-as-mic** (mV-class), and the codec's ~0.9 Vrms full-scale **overpowers it by ~40–50 dB** (the door station's high-gain speech amp is built for that tiny mic signal). So the codec runs *low* on its digital volume to match and the source-Z divider loss vanishes against that headroom — **no buffer/op-amp needed**; a passive analog divider would only spare DAC bits if the digital cut runs very deep. **The handshake bridge is Ra+Rb = 2.2 kΩ exactly** — the WF26's R29/R1 mirrored, so it reads as *talk*, not the near-short that fires the door — and **Cf only shunts**, so the P2↔P3 through-resistance never drops below 2.2 kΩ in any state (charge transient, cut JP1, cracked cap) — BUS-2 (b)'s door-fire floor. The gong riding P2 dies in the Ra-vs-Cf divider (~÷240–360 at the measured 673–1009 Hz Klang lines, more after the Rb-vs-bus divide ⇒ sub-mVpp residual at P3 into a ~90 Ω bus — capture-gated, `our-ring-no-door`) while the pedestal asserts in ~3τ (τ ≈ 25 ms against a ~90 Ω bus, ~55 ms unloaded). **JP1 (bridged solder jumper) is the on-board fallback:** cut, the leg degenerates to the exact 2.2 kΩ strap (V4.1's step assert, no filter); blob to re-enable. **Ra/Rb are 1206/250 mW** — rated for the sustained cracked-short-Cf fault with drift-to-open as the fail-safe direction. *(V3 bench: an accidental P4→P3 bridge — the effect the K4/Q3 break-before-make now prevents — audibly drove the door-station speaker, confirming the door end responds at bus-bridge levels.)*
- **RX front-end:** a balanced attenuating tap fed **differentially** to the ADC —
  `P2 → C16 (1 µF) → R30 (22 kΩ) → MIC1P` and `GND → C17 (1 µF) → R31 (22 kΩ) → MIC1N`, with
  **R33 / R32 (3.3 kΩ)** shunting MIC1P / MIC1N to **VMID**. Each leg is a 22 k/3.3 k divider (≈ −18 dB):
  it drops the bench-measured ±8.8 V line-2 Türruf gong to ~1.1 V — inside the ES8311 mic abs-max
  (AVDD + 0.3 ≈ 3.6 V), so the input ESD clamps never conduct on a ring — while the 22 kΩ also
  current-limits any clamp conduction and is the BUS-1 high-Z line-2 load. **R30 + D14 are the mic-side
  twin of the R26/D13 guard:** with the board *unpowered* (AVDD = 0, so the abs-max window collapses to
  ±0.3 V) every bus step still couples through C16/R30 into MIC1P — the board's one non-isolated bus
  path in its headline passive-fallback mode. **D14 (BAT54SW, dual-series Schottky, SOT-323 — COM →
  MIC1P/ES_MICP, anode → GND, cathode → +3V3)** gives that sub-mA injection a **rated** (200 mA)
  external path into the rail capacitance instead of the codec's unrated input ESD structure. Powered
  it idles (MIC1P stays within [0, AVDD]). It clamps to **+3V3** (the In1 plane, a via at the part)
  rather than AVDD: unpowered, both rails are equivalent capacitive sinks, and the ~5 pF of
  reverse-biased clamp capacitance couples < −80 dB of rail ripple into the ~3 kΩ mic node — below the
  codec's own noise floor either way, so plane access wins. The 3.3 kΩ shunts double as
  the **MIC bias** (the ES8311 has no internal mic bias), pinning both inputs to VMID; **C12 = 10 µF**
  holds VMID as a stiff AC ground against the two shunts. Symmetric legs preserve the differential
  balance. Final divider trim is bench-gated against the measured ADC full-scale. **The level ceiling is bounded by the gong, not unknown:** the Türruf gong couples line 4 onto line 2 (captured at ±8.8 V on P2) and ≈ the loudest audio line 2 ever carries — so the −18 dB divider sized for *its* abs-max also bounds normal speech, which the codec mic PGA + the ADC's ~90 dB SNR lift back to a usable code level. *(V3: the gong level is the expected maximum for line-2 audio.)*
- **Support net:** AVDD runs off a **dedicated low-noise LDO** — **U4 = LP5907MFX-3.3** (TI, SOT-23-5,
  10 µVrms / 82 dB PSRR @ 1 kHz; LCSC C80670) fed from **+5V**, generating a clean **AU_3V3** rail (C23
  1 µF in / C24 1 µF out) that the shared Wi-Fi/SMPS-noisy +3V3 plane can't offer. Its **EN ties to
  +3V3** so AU_3V3 sequences up after the digital rail (digital-before-analog). AU_3V3 then reaches the
  AVDD pin through **FB1** (Sunlord GZ1608D601TF, 600 Ω @ 100 MHz, 0603; LCSC C1002) + the AVDD
  bypass/bulk (C9/C10) — a second LC pole on an already-clean rail. **PVDD and DVDD stay on +3V3
  deliberately:** only AVDD feeds the ES8311 analog/reference section (ADC, DAC, VMID/ADCVREF/DACVREF,
  mic bias), so it is the only supply whose noise reaches the signal path; PVDD (digital-I/O driver) and
  DVDD (digital core) are switching-noise *sources*, and putting them on the analog LDO would re-inject
  that hash into the rail AVDD shares — each instead keeps a local 100 nF on the plane. DACVREF/ADCVREF/
  VMID reservoir caps; CE/DGND/AGND/EP → GND. Symbols/footprints imported with `easyeda2kicad` into
  `kicad/libraries/audio/` (the LP5907 uses the stock `Regulator_Linear` symbol).
- **EP grounding (no vias):** the QFN-20 centre EP carries no thermal vias — paste over open vias
  wicks solder away, and the codec dissipates milliwatts. EP (and pin 10/AGND, tied to it) bonds to
  GND through adjacent copper.

**BUS-1 (line 3 high-Z at idle) — met by the dual K1.** The transformer-less plan gated the TX audio
with K1 so line 3 is high-Z when not talking; the dual GAQW212GS does exactly that. The codec sits on
the permanently-wired `OUTP → R26 → C14 → TX_OUT` path and the Ra/Cf/Rb handshake leg hangs between
the two channels, but **ch2 (`TX_OUT ↔ P3`) is the
output gate**: at idle it lifts line 3 off TX_OUT, so neither the codec nor the filter leg reaches the
shared talk line; only
with K1 energised do they reach line 3. Confirmed in the sim — the
`TX idle isolation (BUS-1)`, `talk handshake`, `gong rejection` and `JP1 cut` tests. Firmware still
mutes the DAC off-PTT, but the
high-Z is now structural, not discipline.

**Gong ↔ TX handshake — why the handshake is filtered (BUS-2 a).** During a session the latched K5 seal-in ties
P2 galvanically to line 4, so while the 3-Klang tone is live it stands on P2 (measured,
`our-ring-no-door`: 1009 → 841 → 673 Hz strikes over ~3.9 s, ≤3.7 Vpp on the latched P2, nothing below
620 Hz above 10 mVpp; a neighbour's ring puts up to ~9.4 Vpp on the shared line 2) — and an
*unfiltered* P2-sourced handshake would carry that AC through the closed K1 onto line 3, tens of dB
above the deliberately mic-level codec TX. K3's chime-suppress can't help — it only opens the speaker
path; the tone stays on the bus. The Ra/Cf/Rb low-pass strips it (sub-mVpp at P3; the sim's
`gong rejection` test) while the DC pedestal still asserts talk. **The deployed V4.1 board predates
the filter** and instead holds each greeting until the gong window passes (`gong_until_ms`,
`doorbell-v4.yaml`) — a stopgap that costs ~1.75 s of latency, is structurally blind to mid-session
re-rings (line 4 stays high, so OC1 sees no edge) and to neighbour gongs, and undershoots the measured
~3.9 s tone (the third Klang, ~3.6 Vpp at expiry, leaks through its unfiltered strap regardless) —
retire it when the V4.2 board deploys (TODO).

**Bench-gated / open (analog front-end):**
- **RX — direct ES8311 differential input vs an external in-amp.** Confirm the mic input is high-Z /
  differential enough to tap P2↔P1 directly; add a buffer/in-amp if not.
- **RX trim + TX level.** The MIC1P/N attenuating divider and VMID bias are committed (R30/R31 22 kΩ
  series, R32/R33 3.3 kΩ to VMID, C12 = 10 µF); trim the 22 k/3.3 k against the measured ADC full-scale.
  Set the codec digital volume to the handset's mic-through-2.2 kΩ level, don't overdrive the TV20/S amp
  (AUDIO-6).
- **SAFE-7 bus protection** — per-line **bidirectional TVS** (each P-line→P1, at the connector). The
  front-end already tolerates the measured working envelope (`captures/runs/`: **≈ −11 V to +17 V**; SSRs at
  60 V Voff, optos current-limited + reverse-clamped, codec taps AC-coupled ≥ 50 V), so the TVS is
  **fault-only** (H24VND3BA): **24 V standoff** — above the +16–17 V ring/door switching transients, so it
  stays idle in normal use — clamping over-envelope surge/ESD/miswire to ~50 V, under the 60 V SSRs.
  DC-block caps ≥ 50 V (C16 sees the +16–17 V P2 transients). **SAFE-2 / miswire:** the bidirectional TVS
  clamps any line in any order and the front-end is bidirectional (optos + anti-parallel clamps, AC/DC SSRs,
  non-polar AC caps), so a scrambled bus wiring **survives** (need not function) — the gong cap is a
  **non-polar anti-series pair (C19 + C21)**. J2 is a *fixed* screw terminal (no plug to key/reverse), so
  the only miswire mode is a per-conductor scramble at the clamps, which no connector feature can prevent —
  survival rests on this bidirectional topology plus the silkscreen labels. Envelope + parts: see TODO / "Protection".
- **Hum** with the P1↔GND bond once RX is live.
- **⚠ TX-out reach (bench-gated).** Not yet confirmed on hardware: that the TV20/S **forwards the
  line-3 audio out to the door station** once it sees the 2.2 kΩ (Ra+Rb) handshake bridge — including
  that its talk-detect accepts the filtered leg's ~25 ms RC ramp in place of a switch-speed step —
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
- **C19 + C21** — the gong audio crossover across **P5↔P4** (~22 µF non-polar: two 47 µF/50 V
  electrolytics in anti-series, so scrambled bus wiring can't reverse-stress it, SAFE-2; the
  `CHIME_C1` node sits between K3 and this cap).
- **K5** — the **latch relay** (G6K-2F-Y), coil across **P1↔P4**, pulled in by the ring's own
  ~12 V Türruf DC pulse and then **sealed in from P2** (see "Bell signals"); its NO contact routes
  listen **line 2 → S1 → K1_COM → P4 → C1 → speaker**. **Bus-energised, not GPIO-driven** — that's
  what makes listen work unpowered. A **flyback diode (D1)** clamps its coil (the stock handset lets
  the speaker across the coil damp the kick; K3-in-series-with-C1 breaks that path, so the board adds
  its own clamp).
  - *Future option — fold the session-sense into this relay and drop OC1 (NOT adopted; OC1 kept for
    now, the opto sense works):* make it a **12 V DPDT** with the **coil on P4↔P1**; pole A = K1_COM↔P4
    (listen); pole B = **3V3 → GPIO + pull-down** = a galvanically-isolated, non-inverted **session/ring
    signal** (energised = HIGH) replacing OC1's opto sense (+ its limiter and clamp D8).
- **R29** — 2.2 kΩ talk resistor (`P4 → R1 → R1_BRIDGE`).
- **SW3 (door, DPDT) and SW4 (talk, DPDT)** — SPPJ322300 slide switches wired as in the
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
  behind the **speaker grille**, S1/S2 under the existing **button apertures**, and J2 (the 5-wire
  bus) at the housing's **wire entry**. The switch **plunger tips** must land where the enclosure
  buttons press them — given **relative to the board edges**, so they survive an outline move:
  - **S1 (top button, door release):** **17 mm from the top edge, 20 mm from the right edge**.
  - **S2 (bottom button, talk):** **5 mm from the bottom edge, 20 mm from the left edge**.
  Marked as crosshairs on **Dwgs.User** in the PCB; the edge-relative figures here are the source of
  truth — re-derive the absolute marker coordinates from the current Edge.Cuts if the outline shifts.
- **Power entry:** the WF26 has no USB/power opening, so the 5 V feed needs a route in (cable gland,
  an existing aperture, or an added hole) — the bus can't supply it.
- **Antenna:** U1 (WROOM-1U) uses a **u.FL external antenna** — route the antenna lead out of the
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
gerbers/BOM/CPL in `fab/` are exported from them. The firmware config passes `esphome config firmware/doorbell-v4.yaml`
(ESPHome 2026.5.3; needs a `secrets.yaml` with `wifi_ssid`/`wifi_password` alongside).

`VERIFICATION.md` is the **procedure** for confirming the board before fab — the automated gates,
an independent blind schematic-review method (reconstruct intent from the netlist + datasheets +
`wf26/wf26.kicad_sch` + the TV20/S PDF, *without* DESIGN.md), and the bench checks. Run blind
against the current schematic it found **0 polarity / pin-mapping / pin-usability errors**
(ERC 0/17), converging with this document on every system-level conclusion (including the WF26
seal-in model).

**Cross-checked against the WF26** (netlist extracted from `wf26/wf26.kicad_sch` with `kicad-cli`):
the bus pin map; the door/talk split — **K2 = a direct P2↔P3 short** (genuine S1), the 2.2 kΩ
(Ra+Rb, gong-filtered) on
the K1 talk strap (genuine R1); K3's chime-mute sits in the **C1 audio path** (P4↔C1), not line 4, so
it can't touch the latch or the Etagenruf; the K5 coil is across **P1↔P4** (ring-driven, then
sealed in from P2 — see "Bell signals"); and K1/K2/K3 are independent (no interlock, like the handset).
**Session state = OC1 high**, gated directly (line 4 holds through the session), no timer.
**The end-to-end TX-out reach is the remaining open investigation** — the codec taps the speech pair
(RX ← line 2 differential, TX → line 3 via K1's handshake, gong-suppress-independent); what's
bench-gated is whether the TV20/S forwards the line-3 audio to the door once it sees the 2.2 kΩ talk
bridge (see `TODO.md`, "TX-out reach"). See Switches / Audio path / Bell-sense.

**Datasheet-verified:** GAQY212GS / GAQY412EH PhotoMOS pinout + Ron/Voff/LED drive (K3 = 1-Form-B
**NC** confirmed); K5 (G6K-2F-Y) latch pinout; SGM2212 SOT-223 pinout + ~1 V dropout headroom;
1N4148W pin 1 = cathode (CDFER lib); LTV-217 pinout; USB front-end (D+/D− not swapped; TPD2S017
pinout/V_CC bias, CC 5.1 kΩ Rd); bell-sense GPIO LOW levels; ES8311 full pinout; every U1 pad↔GPIO assignment against the
**ESP32-S3-WROOM-1U** pinout (the GPIO map's pad numbers are the WROOM-1U pads, from the schematic).

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
- **Mounting holes H1/H2** (NPTH 3.2 mm) on the enclosure bosses; commissioning test points **TP1–TP8**: TP1 = GND (= P1, the bus common — bonded to board GND — the scope-ground anchor), TP2 = +3V3, the rest tap the door watchdog gate and the codec audio front-end (net per test point in the schematic). Bare 1.5 mm pads, excluded from BOM/CPL. The +5V rail has no test point — probe F1's output pad (the OR-merge VBUS sits on D4/D15's cathodes, one fuse upstream).
- Bench-confirm the relay-coil voltage under WiFi TX with a long USB cable if paranoid.
