# Doorbell controller — design reference

**What the board must do is in [`REQUIREMENTS.md`](REQUIREMENTS.md); this doc is *how* it does it.**
When the design changes in a way that affects behaviour, update REQUIREMENTS.md too.

**V4 source of truth: the KiCad files** (`kicad/doorbell.kicad_sch` / `kicad/doorbell.kicad_pcb`),
edited directly in KiCad. `./build.sh` verifies them — the checks KiCad's own DRC/ERC
can't express (connectivity + the copper-thieving sliver limit in `route.py`, placement in
`check_pcb.py`) — and exports the fab outputs; it does not generate the board.
`tools/doorbell_design.py` holds the placement constants `check_pcb.py` verifies (connector edge
fit, mounting-hole MLCC keep-out); the KiCad files are authoritative for everything else.
Firmware: `firmware/doorbell.yaml`. LCSC part numbers live in the schematic symbols as hidden
`LCSC`/`Description`/`MPN`/`Datasheet` fields (the JLCPCB library symbols carry most; the rest are
set by hand) and `tools/jlcpcb_files.py` reads them from the schematic for the BOM.
Ordering: `ORDERING.md`. Reverse-engineered handset: `wf26/wf26.kicad_sch`.
Intercom system reference: `docs/design/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`;
central-unit photo: `docs/design/tv20s-board.jpg`.

V3 — the retired perfboard predecessor, superseded in the wall by V4 — is documented in its
own section below (source: `docs/design/KlingelV4.fzz` Fritzing schematic).

---

## System context

This is an interface board between an **STR TV20/S intercom system** and Home Assistant
(via ESPHome on an ESP32). The TV20/S is a 5-wire intercom bus powered by an NTR201
transformer (230 V → 12 VAC). This board is the electronics of the apartment handset: it combines
the passive WF26 circuit with the smart interface, so normal handset operation survives without power.

```
[NTR201 transformer]──12VAC──[TV20/S central unit]──5-wire bus──[this endpoint + other handsets]
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
   handshake sourced from P2 through the restored V4.1 R28 path. V4.2 prevents own-ring bleed by
   isolating raw P4 from the internal K5 latch node after the relay has pulled in. No isolation
   transformer; **P1 is bonded to board GND**.

The board never touches the 8–12 VAC door-opener current — switched entirely inside the TV20/S. The
bus carries only low-voltage signalling (≤12 VDC, mA-level): the three ESP-driven switches (talk,
door, chime-mute) are **PhotoMOS SSRs**; the one electromechanical part is the **passive WF26 latch
relay**, which the bus drives itself (so it works with the board dead).

---

## WF26 connector

J2 is one 5-way, 3.5 mm-pitch screw terminal, pins 1–5 = P1–P5. A screw clamp reliably accepts the
handset's fine stranded cable and preserves the original terminal order. J2.4 is raw **P4**. K6,
a normally-closed PhotoMOS, connects it to the internal **K5_LATCH** node used by the latch coil,
seal-in contact and manual-Talk resistor. Chime suppression still opens only the raw-P4 gong-capacitor
path. The exact orderable connector is maintained in the schematic and `ORDERING.md`.

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| Line | TV20/S role | Role in our circuit |
|------|-------------|---------------------|
| **P1** (= board GND) | Common reference (all bell/speech ref to line 1) | Bonded to board GND; opto LED returns (each via 5.1 kΩ to P1); the codec RX/TX reference |
| **P2** | Listen leg; ÖT pair with line 3 | **K2** door bridge (to P3); **RX tap** (P2 → C16 → codec ADC); SW3; the **P2 supply** that seals the WF26 latch in; the 200 kΩ TX precharge path (`P2 → JP4 → R38 → R39 → TALK_BRIDGE`). **Idles at +12 V vs P1** — a continuous standing bus rail (`captures/runs/`: 12.06–12.11 V at rest), sagging to ~9.4 V under the seal-in load during a session and momentarily to ~2.6 V at session-end before snapping back |
| **P3** | Talk leg; ÖT pair with line 2 | **K2** door bridge (from P2); **TX inject** (`OUTP → R26 → C14 → TALK_BRIDGE → R28 → TX_OUT → K1-ch2 → P3`); WF26 talk/door switches |
| **P4** | Türruf — ~12 VDC front-door gong + tone | **OC1** sense; **K3** chime-mute (P4↔C1); **K6** normally-closed bridge to `K5_LATCH` |
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

- **K4** (normally-closed PhotoMOS) sits **in series in the seal-in** (`SW3.6 → K4 → K5.3`, in the
  `P2 → K1_COM` path). Energised it **opens** → the seal-in breaks → K5 drops. At rest it's closed,
  so the passive/unpowered latch is untouched (MODE-1 / SAFE-4).
- **The break leads the make.** K4's LED is driven straight off DOOR_DRV (opens immediately), while K2's
  LED returns to ground through **Q3**, a logic-level N-FET whose gate (DELAY_GATE) ramps on
  **R17 (100 kΩ) · C18 (1 µF) ≈ 38 ms** — so K2 closes after K4 (≥~14 ms at the fast
  Vgs(th)/cap corner), well past the ~6 ms latch drop. The V4.1 emulated-bus bench test measured
  approximately **33–34 ms** from P4 falling (K5 released) to P3 rising (K2 made), with no premature
  P3 pulse; see the [scope capture](docs/scope/door-break-before-make.png). One gate (DOOR_DRV),
  hardware-timed break-before-make; the firmware just pulses the door line.

With the seal-in broken before P2↔P3 closes, the held Türruf is never bridged onto line 3. The
firmware's 1.75 s **minimum ring-to-open deadline remains intentional** regardless of greeting
selection: it gives the visitor time to reach the door before the latch releases, while a greeting
that runs longer completes before the opener. It is separate from V4.1's 1.45 s ring-to-audio
`welcome_not_before_ms` guard, which covers the measured door-station startup suppression and keeps
V4.1's unfiltered TX handshake away from the initial gong. The audio guard can be retired only after
K6 isolation is validated on fabricated V4.2 hardware. Boot/idle: DOOR_DRV low ⇒
Q3 off (K2 open) and K4 LED off (K4
closed) ⇒ fail-safe (SAFE-6).

**Door-open watchdog (DOOR-5).** Q4, R25, C20 and D11 form a hardware one-shot that releases K2 even
if firmware leaves DOOR_DRV asserted. Its deliberately loose RC/FET threshold range starts after the
normal 1.75 s pulse and bounds a stuck command to seconds rather than indefinitely; D11 quickly
re-arms it when the command drops. K4 may remain open during such a fault, which only keeps the
session latch released. Simulation covers the timing envelope, and the deployed V4.1 board released
the opener after roughly 6–7 s when deliberately held on. After a 250 ms DOOR_DRV-low interval, a
retrigger reproduced the normal break-before-make sequence and held P3 at 12 V for approximately
5.7–5.8 s before the watchdog released it; see the
[scope capture](docs/scope/door-watchdog-rearm-250ms.png). This proves functional re-arm of the
external door path. A 500 ms repeat produced the same approximately 5.8 s interval, validating the
firmware minimum with margin.

> **Line 4 carries the Türruf** on raw PCB net **P4**. Normally-closed K6 passes it to **K5_LATCH**,
> the internal junction of R29, the K5 coil and its NO contact. The ring's **DC energises the
> coil** (coil = P1↔K5_LATCH — a ~1 s TV20/S pulse, then sealed in from P2), and its **AC
> tone reaches the speaker via C1** (P4↔P5 → LS1 = the gong). **Talk** is a 2.2 kΩ bridge of **line
> 4↔line 3** (S2 + R29); **listen** routes line 2 → K5 → K5_LATCH → K6 → P4 → C1 → speaker. **Chime suppression
> opens C1** (K3, NC, in the P4↔C1 path) so the Türruf tone never reaches the speaker — line 4, the
> latch and the Etagenruf are untouched. Once K5 is confirmed, firmware may open K6 during smart TX
> to keep the raw gong off the latched P2 handshake. There is no local tone generator; the chime *is*
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
- **Door opener:** the TV20/S switches a separate 8–12 VAC supply on terminals 8/9. This board only
  requests an open through the low-current bus and never carries opener current.
- **Bell signals:** Türruf (house door) ≈ **12 VDC nominal across terminals 4 & 1** (measured
  ~10 V at the bus); Etagenruf (floor call) measured across **5 & 1**. Line **1 is the common**
  reference. The TV20/S pulses P4 long enough to pull in the handset relay; the handset then seals it
  from the standing P2 supply, keeping P4 high for the session. A genuine door press breaks that
  seal-in before bridging P2↔P3. The inactivity timeout instead pulses P2 low. Both paths drop P4,
  so OC1 provides an edge-to-edge session signal.
- **Tones:** Türruf = **3-Klang-Gong** (3-chime) — the gong is an **AC tone superimposed on the
  line-4 DC pedestal at the *start*** of the window; once the chime finishes, line 4 holds
  **steady DC** for the remainder. The measured three-strike tone lasts about 3.9 s; detailed
  spectral evidence lives under `captures/runs/our-ring-no-door/`. Etagenruf is continuous.
- **Bus is a shared party line; line 4 is per-apartment.** Line 4 (Türruf) is **address-selective**
  — it only goes hot for *this* apartment's own door button; another apartment's ring leaves our
  line 4 cold, so **OC1 (on line 4) senses only our own ring**. Line 2, by contrast, is **shared
  across apartments**, so a line-2 audio tap can hear other apartments' active calls.
- **ÖT door-opener trigger (authoritative):** the troubleshooting test says
  *"Zum Test, Klemmen 2 u. 3 brücken"* — **bridge terminals 2 & 3** → opener voltage
  appears at 8/9. This is exactly what relay **K2** does (COM=P2, NO→P3, a direct short).
- **ET versus ÖT:** ÖT directly bridges P2↔P3. The external floor-call button gates P5 for that
  apartment; it is not part of the handset internals.
- **Speech:** only enabled *after* a bell; ~25 s talk window, auto-off after ~60 s. The bus
  speech pair is **lines 2/3** (STR Fehlersuchhilfe: *Sprechverkehr* on 1/2/3, door side 6/7) —
  up-audio on line 3 (S2's 2.2 kΩ talk bridge), down-audio on line 2 (via the relay). At the
  WF26 the transducer couples to line 4 via **C1 (P5↔P4)**. The door-opener also momentarily
  shorts **2↔3**, so that pair is shared between speech and the ÖT trigger — **not** opener-only.

## WF26 internal circuit (reverse-engineered)

The WF26/G has no active electronics: one 16 Ω speaker/microphone, a latch relay, a 22 µF coupling
capacitor, a 2.2 kΩ talk resistor and two DPDT switches. Its authoritative connectivity is in
`wf26/wf26.kicad_sch`, with a neutral readout in `wf26/wf26-schematic.md`.

**The numbering is canonical: Pₙ = bus line n** (J1 pin n → Pₙ), confirmed by measurement — the
door-opener bridges **P2↔P3** (= the ÖT pair, lines 2/3) and the speaker sits across **P1↔P5**
(common + Etagenruf), leaving **P4 = line 4 (Türruf)**.

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
  (no door-open). Which line is pulled is immaterial to the board: OC1 sees line 4 fall either way.
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

**Session hold:** after the TV20/S's ~1 s Türruf pulse, the energised relay connects P2 through S1
and its NO contact back onto P4. Thus P2—not a continuing central-unit line-4 drive—holds the coil
and line 4 high for the session. OC1 consequently tracks the latch edge-to-edge. Door-open breaks
that seal-in; the inactivity timeout ends it with the measured P2-low pulse.

**Interfacing takeaways (audio tap / virtual PTT):**
- Record/monitor: a high-Z tap on **P1/P5** (the transducer) captures gong, Etagenruf and both
  speech directions regardless of bus line — *but* it rides the relay/C1 path, so it dies when the
  gong is suppressed (C1 opened). The board instead taps the **speech pair** (RX P1↔P2, TX
  P1↔P3), which is independent of line 4 / suppress — see "Audio path."
- To mimic the stock S2 during a held session, bridge **line 4 ↔ line 3 through ~2.2 kΩ**; the
  energised latch already makes the internal latch node follow P2. The smart K1 path sources its
  restored 2.2 kΩ R28 handshake directly from **P2**, allowing controlled TX independently of session state. Virtual
  door-open remains a direct **line 2 ↔ line 3** short paired with a seal-in break (mimic S1).
- Injecting TX audio on P1/P5 makes LS1 replay it (quiet at mic level); lift one LS1 lead to
  silence it (1-wire board mod).

---

## V3 — the retired predecessor (perfboard)

V3 was an ESP32 DevKit and relay module on hand-wired perfboard; its source is
`docs/design/KlingelV4.fzz`. It was retired because the inter-board jumper connections worked loose
and because its shared optocoupler limiter allowed an active channel to reverse-stress the idle
Etagenruf optocoupler. V4 retains the proven basic sensing and switching behavior but integrates it
on one PCB and gives each optocoupler its own limiter and anti-parallel clamp. V3 pin assignments and
parts are historical and are not design inputs for V4.

---

## V4 — integrated single board

**Design philosophy: carry the proven V3 sense path over; modernise the rest.** The bell-sense
front-end is reproduced — per-opto LED limiters (a shared limiter would let a ringing channel
reverse-bias the idle opto's LED past its 6 V VR), anti-parallel reverse-clamp diodes on each opto
(polarity hardwired anode-to-bus-line) — as is the direct ÖT bridge (K2, P2↔P3). The three ESP-driven
actuators are now **PhotoMOS SSRs** (K1 talk gate, K2 door, K3 chime-mute), the audio path is
**transformer-less** (codec on the speech pair, P1↔GND bonded), and a passive **WF26 core** preserves
the complete handset function when unpowered. Line 4 carries the Türruf as a ~12 V DC level with the 3-Klang
tone riding on it: the opto (on P4↔P1, **ahead of C1**) sees the DC-dominated level — so it is debounced
in firmware (`delayed_on`/`delayed_off`), not rectified — while C1 (K3-gated) blocks that DC and passes
only the AC tone on to LS1. Same line, two views: DC at the opto, audio at the speaker.

### Decisions

- **Single integrated PCB:** no inter-board jumpers; full SMT/THT assembly is handled by JLCPCB.
- **ESP32-S3 with PSRAM and external antenna:** enough memory and I/O for ESPHome audio, native USB
  flashing/logging, and flexible pin placement. Wi-Fi is the only network interface.
- **PhotoMOS switching:** talk and door contacts default open; chime-mute and seal-in-break contacts
  default closed. This preserves passive handset behavior with the smart layer unpowered.
- **Transformer-less, half-duplex audio:** the codec taps lines 2/3 and shares P1 with logic ground.
  This deliberately trades galvanic isolation for a compact, direct audio path.
- **One protected 5 V/USB inlet:** the JST-SH service connector carries VBUS and native USB data;
  D4 blocks reverse input and back-feed before the fuse and regulators.
- **Four layers:** provide continuous reference planes and practical routing density around the
  ESP32, codec and mixed bus/logic interfaces.
- Exact device variants, footprints and supplier identifiers belong to the schematic and
  `ORDERING.md`; the sections below retain only values that affect behavior.

### ESP32-S3 GPIO map

The authoritative pin assignment lives in `firmware/doorbell.yaml` and the schematic
(`kicad/doorbell.kicad_sch`, U1); it is not duplicated here. **Placement rationale:** U1 sits so the
native-USB pins (IO19/IO20) reach J1 through the D5 ESD clamp, and the ES8311 I²C/I²S
bus is assigned **ascending by module pad** (SDA, SCL, MCLK, BCLK, DIN on GPIO38–42, then WS, DOUT on
GPIO2/GPIO1) so it fans out toward U3 in U3's pin order with no crossings. The S3's GPIO matrix makes
this purely a placement choice: any function routes to any pad.

**Boot-state rationale (the part that isn't just a pin list):**
- **SSR gates idle off through boot (SAFE-6).** The three DRV pins are plain GPIO that power up as
  floating inputs; the 10 k pull-downs keep the SSR LEDs dark until firmware drives them. DOOR_DRV
  sits on a pin with no boot-time drive, so the opener can't pulse on reset.
- **Strapping pins parked safe:** the S3 straps on IO0/IO3/IO45/IO46. **IO0** is the boot strap, held
  high by R11 (10 k to +3V3) for normal SPI-flash boot, with SW1 pulling it to GND for download mode.
  IO3, IO45 and IO46 remain unconnected at their module defaults; the WROOM sets its own internal-flash
  voltage. The active-low status LED instead uses unrestricted **IO7** (U1 pad 7):
  `+3V3 → R15 → D6 → IO7`, with R27 (1 kΩ) pulling IO7 to GND for a defined boot indication.
  Firmware drives IO7 high when healthy and lets ESPHome blink it on Wi-Fi/API errors. The I²C/I²S
  bus deliberately lands SCL/MCLK/BCLK/DIN on IO39–42 = the MTCK/MTDO/MTDI/MTMS JTAG group — none of
  those are S3 strapping pins, so it only forgoes pin-JTAG (debug runs over USB-Serial-JTAG) with no
  boot-time effect. EN has the 10 k (R10) + 1 µF (C5) RC + SW2 (Espressif EN-RC spec).
- **No USB-UART bridge:** flashing + logs run over the native USB-Serial-JTAG (IO19/IO20 → D5 → J1).
### Bell / session sense front-end

Two identical channels (OC1 = house bell on P4↔P1, OC2 = apartment bell on P5↔P1):

```
bus line (active, +) ──► opto LED anode ── LED ── cathode ──┬── R_lim (5.1k) ── P1 (common)
                          ▲ 1N4148W clamp, ANTI-parallel ───┘
opto collector ──► GPIO + 12 kΩ to +3V3     opto emitter ──► GND  (per channel, direct)
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
- **Low-current sense margin:** OC1/OC2 are Toshiba **TLP293 GB-rank** parts, guaranteed to at least
  100% CTR at IF=0.5 mA and 30% saturated CTR at IF=1 mA, VCE=0.4 V (25 °C). The captured 5.1 kΩ
  LED-current envelope is approximately 1.1–2.8 mA. With the fitted 12 kΩ ±1% collector pull-up,
  the ESP32's worst VDD/VIL corner needs approximately 0.23 mA. The 0.30 mA guarantee therefore has
  enough margin for a 10% cold engineering derating to 0.27 mA over the expected 0–50 °C enclosure
  range. For idle HIGH, applying the more severe 85 °C maximum dark current of 50 µA to the 12 kΩ
  maximum leaves approximately 2.39 V at minimum VDD, above the 2.25 V VIH limit. These temperature
  bounds are engineering calculations, not production CTR guarantees: Toshiba specifies minimum CTR
  at 25 °C and presents the temperature curves as typical. First-board endpoint characterization
  remains required.
- **Cross-talk masking** (`firmware/doorbell.yaml`, lambda filters ahead of the debounce):
  **OC1 is not masked**; it senses the DC-dominated line-4 session level and must remain able to
  report a genuine ring during PTT.
  - **Apartment Doorbell (OC2)** taps the speaker pair, so it pulses on *any* loud
    speaker audio — Etagenruf tone, Türruf gong and session speech alike. It is forced
    off while House Doorbell / PTT are active; what remains is a genuine floor
    call.
  - All masked interferers are AC, so the raw input keeps toggling and the masks
    re-evaluate continuously while active. The masks must never gate a *steady-DC*
    signal that outlives the mask window — the lambda only re-runs on raw-input edges.
- **OC2 tone detection** (`firmware/doorbell.yaml`): the opto conducts only on positive
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

### Switches (K1/K2/K3/K4/K6 — PhotoMOS SSRs)

```
K1 (talk+TX gate, dual NO): ch1 P2↔TALK_BRIDGE (precharged by JP4+R38+R39 = 200 kΩ), ch2 TX_OUT↔P3
K2 (door opener, NO): P2 ↔ P3 — energise to bridge the ÖT pair
K3 (chime mute, NC): P4 ↔ CHIME_C1 — energise to open and mute
K4 (seal-in break, NC): SW3.6 ↔ K5.3 — energise to drop the latch
K6 (P4 isolator, NC): P4 ↔ K5_LATCH — opens only when ISO_REQ and K5 auxiliary NO are both active
LED drive: PTT_DRV → R4 (K1 ch1 LED) + R24 (K1 ch2 LED); MUTE_DRV → R6; DOOR_DRV → R5→K2 LED (via Q3 delay) + R21→K4 LED (each Rn = 220 Ω)
```

- **PhotoMOS, bidirectional.** K2/K3/K4 are single-pole; K1 contains two independent NO contacts.
  K1/K2 are **1-Form-A (NO)** = open at idle; K3/K4 are **1-Form-B (NC)** = closed at idle. Off-state
  default is fail-safe: K1/K2 open ⇒ no talk/door at boot (the passive core's S2/S1 cover those
  unpowered); K3 closed ⇒ the gong rings at boot/unpowered (GONG-3/SAFE-6).
- **K1 — talk handshake + TX gate (BUS-1).** Ch1 sources P2 onto `TALK_BRIDGE`; R28 provides the
  field-proven 2.2 kΩ handshake to `TX_OUT`; ch2 gates `TX_OUT` onto P3. Codec TX joins
  `TALK_BRIDGE` through R26/C14. Factory-bridged JP4 and R38+R39 (100 kΩ + 100 kΩ) span ch1 so
  C14's bus side follows the standing P2 bias before K1 closes; the closed contact bypasses that
  high-value path during TX. K1 ch2 still leaves line 3 structurally high-impedance at idle. JP4 is
  cuttable only for diagnostic A/B testing and is normally restored bridged.
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
  directly on line 5, bypassing C1 — structurally non-suppressible, GONG-4). **R36 (100 kΩ) + JP2
  (factory-bridged)** bleed `CHIME_C1` to GND while K3 is open, discharging C19's 22 µF
  coupling capacitance (τ≈2.2 s). It is a passive robustness measure: on the V4.1 bench board,
  `CHIME_C1` held about 10 V for tens of seconds, yet an immediate K3 reclose neither latched K5 nor
  asserted even unfiltered OC1. A subsequent ten-cycle sweep with reclose waits from 0 to 5 s showed
  a brief P4 discharge pulse on every cycle and zero K5 re-latches. The always-connected K5 coil
  (P4→P1) loads the transient before its contacts move. Therefore firmware need not impose a 5τ/12 s
  reclose delay, and an immediate fail-safe reclose on reset/brownout is acceptable. Cutting board
  USB power with the charge trapped produced the expected brief P4 pulse and no seal-in; see the
  [scope capture](docs/scope/k3-usb-power-loss.png). JP2 exists only for diagnostic A/B isolation;
  production/default is bridged. Repeat this acceptance capture on the first fabricated board because
  its crossover capacitor and clamp differ from the bench hardware. The simulator models K5's voltage-dependent pickup force: 9.6 V
  is a static must-operate limit, not a full-strength 3 ms command.
- **K4 — seal-in break (DOOR-4).** NC SSR in series in the `P2 → K1_COM` seal-in (`SW3.6 ↔
  K5.3`). De-energised = closed (seal-in intact, the passive latch works unpowered); energised
  (off DOOR_DRV, immediate) = open = K5 drops. With K2's make delayed ~38 ms (Q3 · R17·C18) the
  break leads the make — S1's transfer reproduced in hardware. See "Door-open mirrors S1".
- **K6 — P4 isolator.** NC at rest and unpowered, so raw P4 reaches `K5_LATCH` and the passive handset
  behaves normally. K5's auxiliary NO contact is the K6 LED return: even a stuck-high `ISO_REQ`
  cannot open K6 until K5 has physically pulled in, and K5 release immediately removes LED current.
  JP3 is an open recovery jumper directly across K6's output.
- K1/K2/K3 are independent (no interlock); **K4 is ganged with K2 on DOOR_DRV** — the break-before-make
  door pair. Firmware holds **K3 de-energised whenever a ring should be heard**. V4.1 field operation
  proves that the TV20/S forwards codec audio on line 3 after a 2.2 kΩ handshake. V4.2 retains that
  topology; first-board validation now concentrates on K5-confirmed K6 isolation.

### SSR LED drive (per channel)

```
GPIO ── R4/R5/R6 (220Ω) ── SSR LED anode │ LED │ cathode ── GND
GPIO ── R7/R8/R9 (10kΩ) ── GND   (pull-down: SSR off while the GPIO floats at boot)
```
The 220 Ω resistors give each SSR LED adequate operate current even at the GPIO's guaranteed-low
output-high voltage. IO9 and IO10 each drive two LEDs, so firmware must retain the ESP32-S3's normal
drive strength. V4.1 field operation proves the same direct-drive topology with higher 300 Ω LED
resistors; V4.2's 220 Ω values increase PhotoMOS operate-current margin, so no buffer stage is needed.
The 10 kΩ pull-downs hold every smart actuator inactive while GPIOs float at boot: talk and door
remain open, while the normally-closed chime and seal-in paths remain intact. PhotoMOS contacts need
no flyback; D1 exists only for the passive electromechanical latch.

### Power tree

```
J1 VBUS ──[D4 SS14]── VBUS_PROTECTED ── F1 1A fast fuse ── +5V ─┬─ main 3.3V LDO ── +3V3 ── digital loads
                                                                  └─ low-noise 3.3V LDO ── D18 ── codec AVDD
J1 D± ── D5 ── IO19/IO20 (native USB)         +3V3: 10µF + 10µF + 100nF; AU_3V3: 10µF out (C24)
D4 blocks a reversed J1 supply and prevents VBUS_PROTECTED from feeding back out through the service connector
USB D± ESD: TPD2S017 flow-through clamp (D5), VCC biased from +5V (post-fuse); +5V TVS: SMF5.0A (D10)
VBUS fuse: F1 (0466001.NRHF, 1A fast) ahead of all downstream protection — a clamping D10 blows it, isolating J1 (fail-safe)
```
> No bulk electrolytic: the local LDO actively regulates the ~350 mA WiFi-TX burst
> (modeled droop ≈ 90 mV across 20 µF of ceramic on +3V3), so a bulk cap buys nothing.
> VBUS cable sag is a dropout-headroom question covered by the selected low-dropout regulator.

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
(`kicad/doorbell.kicad_sch` / `.kicad_pcb` — the generator scripts are gone). `./build.sh`
**exports** the order files from them (`fab/doorbell-bom-jlcpcb.csv` + `doorbell-cpl.csv`). See
`ORDERING.md` for the stock/eligibility checks at order time.

> J1/J2 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered.

### PCB — layout constraints & rationale

Physical layout — traces, vias, copper zones, component positions, the 4-layer stack — lives in the
authoritative `kicad/doorbell.kicad_pcb`; this section keeps only the decisions and rules behind it.
The board is **4-layer**, **64.2 × 59.2 mm**, all parts on the top side, and **100 % hand-routed in
KiCad**; `./build.sh` verifies the inner copper-fill planes and fails if any net is unrouted.

- **Why 4-layer.** J1 is a single-row SMD Type-C: D+/D−/CC/VBUS all escape from one
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
- **Bus-width policy.** Nets at WF26-bus potential (P1–P5, K5_LATCH, TALK_BRIDGE, TX_OUT, CHIME_C1) and +5V are routed
  wider than signal nets — the bus carries the Türruf and the door currents, +5V feeds the LDO and the
  ESP32's WiFi-TX peak (via +3V3). KiCad's DRC does not enforce this; it's a routing rule.
- **Pin assignment exploits the S3 GPIO matrix** (any function routes to any pad) so U1's and U3's escape fans
  route without crossings — see the GPIO map.
- **Copper thieving:** both outer layers carry fill zones; the build refills and checks them. An
  oversized floating island fails the check only if a GND stitching via actually fits inside it (via
  pad + float clearance on each side); it's then grounded with a hand-placed via in KiCad (vias are
  never auto-generated). Pockets too narrow for a via are unavoidable slivers and are accepted.
### Build / test notes

- **Antenna:** U1 (WROOM-1U) has a **u.FL connector** for an external antenna — route the lead out of
  the housing; there is no PCB-antenna keepout to honour (unlike the old WROOM-1).
- **Programming/bring-up:** flash + view logs over native USB-Serial-JTAG; BOOT + EN buttons are
  fitted for recovery. **J1 (JST-SH)** is the single deployed power inlet and native-USB service
  port; its cable pinout is `docs/design/usb-jst-j1-wiring.svg`. **Field re-flash (OTA failed):**
  move the service lead's USB-A end from the wall supply to a laptop. The smart layer reboots, but
  the doorbell keeps working throughout — the
  passive WF26 core is bus-powered, not USB-powered (MODE-1) — so only HA/notifications drop for the
  minute it takes. **Flash with the laptop on battery** so the host doesn't earth board GND
  (= P1 = bus common); see "Bus↔logic coupling".
- **Bench validation against the real TV20/S** (door pulse, chime suppress, session sense,
  PTT) before it goes in the wall. Wall wire-up map + line-identification signatures:
  `docs/design/wall-wiring-v4.svg`. Probe via the commissioning test points (TP1 = GND
  scope anchor, TP2 = +3V3, TP3–TP8 = watchdog gate + codec taps — net per test point in
  the schematic), J2's screws, and component pads. The board has
  **H1/H2 mounting holes** (NPTH 3.2 mm) on the enclosure bosses.
- **3D fit models:** `./build.sh step` exports the assembled STEP model; `./build.sh board-step`
  exports a printable bare board. SW3/SW4 carry `STEP_Exclude`, so fit-test exports omit their bodies
  and enlarge only their drills on a temporary copy; the committed PCB and fab outputs are unchanged.
  The implementation lives in `tools/step_*.py` and is intentionally not part of the circuit design.

---

## Audio path (half-duplex; restored V4.1 TX + V4.2 P4 isolation)

**The bus is half-duplex by design.** Speech is on the **1/2/3 group** (the STR *Sprechverkehr*):
**listen on line 2, talk on line 3, ref line 1 (common)**. The board taps that pair with an **ES8311
codec, transformer-less** — P1 is bonded to board GND, so the codec senses/drives line 2/3 relative to
that shared common (the SAFE-3 trade; see "Bus↔logic coupling"):

- **RX (listen):** a **differential sense of line 2** — `P2 → C16 → R30 → MIC1P`, `P1/GND → C17 → R31
  → MIC1N`, each codec pin biased to VMID through a 3.3 kΩ shunt (see RX front-end below). AC-coupled
  and high-Z (no DC bus load, BUS-1); the differential tap rejects hum and the ~0.5 V common-mode, and
  the series-R/VMID divider keeps the loud line-2 gong inside the codec's input range.
- **TX (talk):** dual K1 restores the field-proven V4.1 topology: ch1 connects the always-on P2 supply
  to `TALK_BRIDGE`; R28 (2.2 kΩ) connects `TALK_BRIDGE` to `TX_OUT`; ch2 gates `TX_OUT` onto P3.
  Codec audio joins at `TALK_BRIDGE` through `OUTP → R26 (2.2 kΩ) → C14 (DC-block)`. With K1 open,
  the factory-bridged `P2 → JP4 → R38 (100 kΩ) → R39 (100 kΩ) → TALK_BRIDGE` path precharges C14's
  bus side while K1 ch2 keeps P3 high-impedance. During a confirmed ring session, K6 can disconnect
  raw P4 from `K5_LATCH`, preventing the own-ring gong from reaching the P2-sourced handshake without
  shunting codec audio.

Tapping 1/2/3 (not the WF26 *speaker* pair P1/P5) keeps the smart audio **independent of line 4 / K3 /
the gong-suppress**, so it works with the gong muted.

Consequences:
- **No acoustic echo cancellation.** Both directions are never streamed at once, so AEC is moot —
  full-duplex is physically impossible on this bus regardless of MCU, and the half-duplex path the
  bus supports is within the S3's reach (I²S codec + ESPHome half-duplex).
- **Sequencing, not mixing:** assert direction → settle → stream → release → stream the other
  (walkie-talkie cadence).

**"Can we send?" — session sense.** V4.2 adds `K5_SENSE`, pulled low by K5's auxiliary NO contact,
so firmware can distinguish raw P4 activity from a relay that has actually pulled in and sealed.
OC1 remains on raw P4 for ring detection and diagnostics. K3 control remains independent: it may mute
the local gong while K6 controls only the raw-P4-to-latch connection. Audio direction is selected by
K1:

| Session (`K5_SENSE`) | K1 | State |
|---|---|---|
| inactive | – | no session — neither RX nor TX |
| active | open | listen → **capture (RX)** |
| active | closed | talk → **send (TX)** — line 3 asserted via the K1 handshake |

⇒ On validated V4.2 hardware, "can I send right now?" = **K5 confirmed AND K1 closed.** Production
firmware remains on the V4.1-compatible OC1 + 1.45 s ring-to-audio guard, plus a separate 1.75 s
minimum ring-to-open deadline, until the first fabricated V4.2 board passes passive bring-up and K6
validation.

**Codec + front-end (committed to the netlist; analog values bench-gated for final trim):**

- **U3 is a mono ES8311 codec**, matching the bus's half-duplex audio. Its pinout and address
  configuration are authoritative in the schematic and datasheet.
- **TX front-end:** `P2 → K1-ch1 → TALK_BRIDGE → R28 (2.2 kΩ) → TX_OUT → K1-ch2 → P3` is
  the DC talk handshake. The codec leg joins `TALK_BRIDGE` through `OUTP → R26 (2.2 kΩ) → C14
  (1 µF DC-block)`. The DAC drives **single-ended** off OUTP; OUTN is parked through its own
  `R16 (2.2 kΩ) → C15 → GND` termination (OUTN sees no bus path, so it needs no clamp).
  Factory-bridged **JP4 + R38 + R39** place 200 kΩ from P2 to `TALK_BRIDGE` while K1-ch1 is open.
  This gives C14's bus side the same DC bias that the closed contact will impose, rather than letting
  K1 make into a charged coupling network. The nominal charging time constant is
  `(200 kΩ + R26) × 1 µF ≈ 202 ms`; after any P2 or codec-bias step, the existing 1.45 s
  ring-to-audio guard is more than seven time constants. C14 blocks steady DC, while at voice
  frequencies the added branch is about 202 kΩ into the DAC; in parallel with the existing
  25.3 kΩ RX tap it makes the total smart-layer P2 load about 22.5 kΩ. When K1 closes, ch1 bypasses
  the two resistors, so neither the 2.2 kΩ handshake nor TX gain changes. JP4 is a diagnostic escape
  hatch, not a normal assembly option.
  R26 limits current from bus steps coupled back through C14; D13 clamps positive excursions into
  AVDD and D16 clamps negative excursions into GND. Codec output is far above
  the passive handset microphone level, so firmware turns it down rather than adding a buffer. The
  R28 remains exactly 2.2 kΩ, safely distinct from the door short. K6 isolates the gong source rather
  than placing a voice-band shunt on this codec/handshake node.
- **RX front-end:** a balanced attenuating tap fed **differentially** to the ADC —
  `P2 → C16 (1 µF) → R30 (22 kΩ) → MIC1P` and `GND → C17 (1 µF) → R31 (22 kΩ) → MIC1N`, with
  **R33 / R32 (3.3 kΩ)** shunting MIC1P / MIC1N to **VMID**. Each leg is a 22 k/3.3 k divider (≈ −18 dB):
  it drops the bench-measured ±8.8 V line-2 Türruf gong to ~1.1 V — inside the ES8311 mic abs-max
  (AVDD + 0.3 ≈ 3.6 V), so the input ESD clamps never conduct on a ring — while the 22 kΩ also
  current-limits any clamp conduction and is the BUS-1 high-Z line-2 load. D14 clamps positive MIC1P
  excursions into AVDD and D17 clamps negative excursions into GND, keeping that current out of the
  codec's internal ESD structure. The 3.3 kΩ shunts bias both inputs to VMID and C12 keeps VMID
  quiet. The measured gong envelope bounds the input range; remaining work is PGA calibration.
- **Clamp rail + supplies:** all five protection diodes use LMBR01S30ST5G (30 V; maximum 0.30 V at
  10 mA at 25 °C). The exact C383224 X3-DFN0603 footprint and 3D model are project-local; its
  external pin-1 silk dot remains readable while the microscopic package outline stays on F.Fab.
  U4 generates `AU_3V3`; D18 then feeds AVDD while blocking reverse current toward
  the unpowered regulator. R37 (220 Ω) gives AVDD a defined discharge and injection-current sink.
  The D18 drop still leaves the codec comfortably above its 1.7 V minimum operating voltage at the
  combined codec/bleeder load. Under the simulated sustained ±17 V C14-short fault, R26 plus the
  clamps keep OUTP within the moving AVDD/GND window, AVDD below codec turn-on, and +5 V/+3V3 off.
  For the 0–50 °C enclosure range, the 0.30 V maximum remains a 25 °C guarantee rather than a cold
  specification. The cold-VF margin is accepted as an engineering judgment: even the conservative
  17 V/R bounds are only 7.8 mA through R26 and 0.8 mA through R30, with those resistors limiting any
  current shared with the codec's internal clamps.
  PVDD and DVDD remain on the normal +3V3 plane so their switching currents do not contaminate AVDD.
- **EP grounding (no vias):** the QFN-20 centre EP carries no thermal vias — paste over open vias
  wicks solder away, and the codec dissipates milliwatts. EP (and pin 10/AGND, tied to it) bonds to
  GND through adjacent copper.

**Why P4 is isolated (BUS-2 a).** During a session K5 seals `K5_LATCH` from P2. If raw P4 remains
connected, its gong rides onto the P2-sourced talk handshake and can be forwarded to the door. Once
K5's auxiliary contact proves pull-in, K6 opens raw P4↔`K5_LATCH`; K5 continues to hold from P2 while
the gong remains on the raw side with OC1 and K3. The K5 contact is a hardware interlock, and K6 is
normally closed so reset or power loss restores the passive topology. V4.1 firmware still delays
ring-triggered greeting audio with `welcome_not_before_ms`; retire that workaround only after
fabricated V4.2 validation.

**Final bench calibration:**
- **RX trim + TX level.** The MIC1P/N attenuating divider and VMID bias are committed (R30/R31 22 kΩ
  series, R32/R33 3.3 kΩ to VMID, C12 = 10 µF); trim the 22 k/3.3 k against the measured ADC full-scale.
  Set the codec digital volume to the handset's mic-through-2.2 kΩ level, don't overdrive the TV20/S amp
  (AUDIO-6).

**Committed SAFE-7 bus protection:** per-line **bidirectional TVS** (each P-line→P1, at the connector). The
front-end already tolerates the measured working envelope (`captures/runs/`: **≈ −11 V to +17 V**; SSRs at
60 V Voff, optos current-limited + reverse-clamped, codec taps AC-coupled ≥ 50 V), so the TVS is
**fault-only** (H24VND3BA): **24 V standoff** — above the +16–17 V ring/door switching transients, so it
stays idle in normal use — clamping over-envelope surge/ESD/miswire to ~50 V, under the 60 V SSRs.
DC-block caps are rated ≥50 V. J2 uses the verified P1–P5 wire order; arbitrary wire ordering is not
permitted because the WF26 audio crossover is polarized.

**Remaining bench checks:**

- **Hum** with the P1↔GND bond once RX is live.
- **⚠ V4.2 K6 isolation.** On the first fabricated board, confirm that a ring pulls K5 in before
  K6 opens, the P2 seal-in holds with raw P4 disconnected, own-ring energy disappears from P3 during
  TX, K5 release immediately restores K6, and JP3 restores the original topology when bridged.

---

## On-board passive WF26 core (the unpowered fallback)

The board is one complete WF26-compatible handset endpoint. Its **hardwired passive WF26 core** and
the smart layer share the same bus connection; connecting a second WF26 in parallel is unsupported.
The smart circuitry (ESP32, codec, sense optos, K1/K2/K3) is strictly additive to the passive core.

**Fail-safe principle.** With **no board power** the board must behave like a plain WF26. So the
passive core (transducer, C1, the Türruf-driven latch relay, R1, the talk/door switches) is a
**self-contained circuit needing no board power**, and the smart layer defaults to
inactive/transparent when unpowered (SSRs off, optos passive, codec quiet).

### The passive WF26 core (the `WF26_*` parts)
These reproduce the handset (see "WF26 internal circuit") and run with zero board power:
- **LS1** — 16 Ω speaker/mic across **P1↔P5** (doubles as the mic for talk).
- **C19** — the 22 µF/50 V polarized gong/audio crossover across **P5↔P4**, matching the original
  WF26 topology; pin 1 (+) faces `CHIME_C1`/P4 and pin 2 (−) faces P5.
- **K5** — the **latch relay**, coil across **P1↔K5_LATCH**; normally-closed K6 passes the ring's
  ~12 V raw-P4 pulse at rest, after which K5 is **sealed in from P2** (see "Bell signals"). Its primary
  NO contact routes listen **line 2 → S1 → K1_COM → K5_LATCH → K6 → P4 → C1 → speaker**.
  **Bus-energised, not GPIO-driven** — that's
  what makes listen work unpowered. A **flyback diode (D1)** clamps its coil (the stock handset lets
  the speaker across the coil damp the kick; K3-in-series-with-C1 breaks that path, so the board adds
  its own **1N4004W** clamp, also rated for the repetitive floor-call current coupled through C19).
  On the V4.1 emulated bus at room temperature, automated OC1/P4 checks gave 0/5
  pull-ins at 8.5 V and 5/5 at 9.0 V, placing that board's observed boundary between them; 9.6 V
  remains the guaranteed must-operate limit. The real ring bus is approximately 12 V, and the
  100 kΩ R36 load draws only about 0.1 mA, so pull-in has comfortable design margin; retain a
  normal 12 V latch/seal-in check at first-board bring-up, not a low-voltage fabrication gate.
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
The board mounts in the **existing WF26 enclosure**, so outline, mounting and
placement are set by the housing, not by the part count — it's a mechanically-driven re-floorplan,
not a tweak of the current board:
- **Outline + mounting holes** match the WF26's own PCB: nominally **64 mm (W) × 59 mm (H)**; the
  current fitted outline is **64.2 × 59.2 mm**. **H1/H2 (NPTH 3.2 mm)** sit on the enclosure's existing bosses — **25 mm up from the
  bottom edge, at the left/right edges**; this pattern is field-fit verified.
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
- **Physical fit is verified:** the JLCPCB-assembled **V4.1 PCB was installed in the original WF26
  enclosure** with the lid closed and the handset operating. Its outline, boss pattern, switch
  plunger positions, transducer/grille position, wire entry and assembled component Z-height all
  fit the real housing. The current mechanical interface and component envelope inherit that
  proven layout; repeat the housing fit test only after changing the outline, mounting holes,
  enclosure-pinned parts, or maximum component height.
- Use the current **64.2 × 59.2 mm** outline; still take the **mounting pattern** and the
  **speaker / button / wire-entry positions** from the **real WF26** (and `wf26/wf26.kicad_pcb`
  where it captures them).

## Verification status

Run `./build.sh verify` for the current ERC, DRC, routing, placement and simulation results; do not
copy warning counts or tool versions into this document because they become stale. The default
`./build.sh` additionally exports the release artifacts. Validate firmware changes with
`esphome config` against both production and bench configurations.

`VERIFICATION.md` defines the repeatable pre-fab review and bench procedure. `TODO.md` owns the
remaining measurements and design gates. Established evidence relevant to the architecture is kept
next to the decision it supports—for example, V4.1 field operation proves enclosure fit, watchdog
release, the 2.2 kΩ talk handshake and end-to-end TX reach. The remaining V4.2-specific TX work is
first-board validation of K5-confirmed K6 isolation.
