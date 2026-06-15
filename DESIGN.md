# Doorbell controller (Klingel V4) — design reference

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
transformer (230V → 12VAC). The WF26/G is the apartment handset unit.

```
[NTR201 transformer]──12VAC──[TV20/S control unit]──5-wire bus──[WF26 handset(s)]
                                      │
                                      └──8-12VAC, 1A max──[Türöffner / door opener]
```

The board taps into the 5-wire bus at the WF26 terminals to:
1. **Sense** when bells are rung (lines 4 and 5 carry ~12VDC bell signals)
2. **Trigger the door opener** by simulating the ÖT button press (bridge P2↔P3)
3. **Suppress the chime** by switching line 4 (the Türruf signal)
4. **Half-duplex audio** (V4): capture/inject on the bus **speech pair** (RX line 2 / TX line 3),
   with a virtual-PTT relay emulating the handset's talk switch (analog front-end provisional)

The board never touches the 8–12VAC door opener current — that is switched entirely
inside the TV20/S. All relay contacts carry low-voltage signalling only (≤12VDC,
milliamp-level). Small SMD signal relays are sufficient.

---

## WF26 connector — J2, 6-way screw terminal (3.5 mm)

**Connector:** 6-way, 3.5 mm pitch **screw terminal**, THT (assembled by JLCPCB). The WF26
bus wires are fine, flimsy stranded (~26–28 AWG flat cable) — below the rated minimum of
Wago picoMAX/221 push-in & lever connectors (0.2 mm² ≈ 24 AWG), and push-in cage clamps grip
fine bare strands poorly without ferrules. A screw terminal clamps thin stranded reliably
(tin/fold the ends) and matches what the WF26 uses internally.

Five positions tap the bus (P1–P5); the **6th is IN-P4**, the line-4 return jumpered back
into the WF26 — see "Why line 4 needs two pins" below.

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| J2 pin | TV20/S line | Signal | Role in our circuit |
|-----|-------------|--------|---------------------|
| P1 | Line 1 | Common reference (all bell/speech ref to line 1) | Opto LED return: each LED → its own 5.1 kΩ limiter → P1. T1 winding A leg |
| P2 | Line 2 | ÖT door-opener pair with line 3; listen-PTT leg | Relay K2 **COM**; K1 **NO** (listen leg) |
| P3 | Line 3 | ÖT door-opener pair with line 2; talk-PTT leg (P4↔P3) | Relay K2 **NO** → P3 (direct short); K1 talk strap via **R16 (2.2 kΩ)** → P3 |
| P4 | Line 4 (WF26 side, J2.4) | Türruf path to the handset | Relay K3 **COM** → WF26 terminal 4. K3 opens this to suppress the chime |
| IN-P4 | Line 4 (TV20/S side, **incoming**, J2.6) | Türruf — ~12 VDC house-door gong, **in**; also the PTT handshake line | Relay K3 **NC** → OC1 sense **and** K1 **COM**. K3 NC retains the TV20/S signal when K3 is energised |
| P5 | Line 5 | Etagenruf — floor/apartment call (tone) | OC2 sense; T1 winding A leg |

**Relay K2** (P2 on COM, NO → P3) bridges **P2↔P3 directly** when energised → TV20/S activates
the door opener (a dead short, no series resistor). **Relay K3** (P4 on COM, IN-P4 on NC) breaks
the Türruf line when energised to suppress the chime.

**Why line 4 needs two pins.** K2 (door opener) *adds* a contact across P2+P3 — a parallel
closure, fine from a parallel bus tap. K3 (chime suppress) must *break* the Türruf so it
stops reaching the WF26 gong — a **series** operation, so line 4 is split at the board:
**P4** = WF26-handset side (J2.4 → K3 COM → WF26 terminal 4),
**IN-P4** = TV20/S-incoming side (J2.6 → K3 NC; "IN" = incoming from TV20/S).
OC1 and K1 COM both sit on IN-P4 (K3 NC side): K3 NC retains the TV20/S signal when K3 is
energised, so gong sensing and PTT both work during chime suppression. At rest K3 passes
IN-P4→P4 (gong rings, OC1 senses); energised it opens the line (gong silenced).

> **Line 4 carries the Türruf** (PCB net **IN_P4** on the TV20/S side, **P4** on the WF26 side).
> Inside the handset it is the junction of C1, R1, the relay coil and the relay NO: the ring's
> **DC energises the coil** (coil = P1↔P4 = common↔Türruf) and its **AC tone reaches the speaker
> via C1** (the gong). **Talk** is a 2.2 kΩ bridge of **line 4 ↔ line 3** (S2 + R1); **listen**
> routes line 2 → relay → P4 → C1 → speaker. Chime suppression **breaks line 4** so the Türruf
> audio never reaches the WF26 speaker (observed: remove P4 → no gong) — there is no local tone
> generator (no ICs), the chime *is* the audio on line 4. See "WF26 internal circuit" below.

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | J2 pin |
|--------|----------|
| Orange | P1 |
| Green | P2 |
| Blue/white stripe | P3 |
| Blue | IN-P4 (line 4, **incoming from TV20/S**, J2.6) |
| Black | P5 |
| — (short jumper) | P4 (J2.4) → back into WF26 terminal 4 |

> To wire the series break: move the **blue** (line-4) wire off WF26 terminal 4 onto
> **J2.IN-P4 (pad 6)**, and run a short jumper from **J2.P4 (pad 4)** back to WF26
> terminal 4. P1/P2/P3/P5 stay parallel taps on WF26 terminals 1/2/3/5.

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
- **Bell signals:** Türruf (house door) ≈ **12 VDC across terminals 4 & 1**; Etagenruf
  (floor call) measured across **5 & 1**. Line **1 is the common** reference.
- **Tones:** Türruf = **3-Klang-Gong** (3-chime); Etagenruf = **Dauerton** (continuous).
- **ÖT door-opener trigger (authoritative):** the troubleshooting test says
  *"Zum Test, Klemmen 2 u. 3 brücken"* — **bridge terminals 2 & 3** → opener voltage
  appears at 8/9. This is exactly what relay **K2** does (COM=P2, NO→P3, a direct short).
- **ET (Etagenruftaster) vs ÖT:** the **ÖT** (door-opener) button momentarily bridges **2↔3**
  across the bus as a **direct short** (the handset's S1). The **ET** (Etagenruf / floor-call) sits **in line 5**, between the WF26's terminal
  5 and the onward bus conductor — so **P5 does not run directly to the TV20/S**; line 5 reaches
  the central unit through the ET button (**not** among the WF26's captured internals).
  **Each station's P5 is gated by that apartment's door button** (confirmed), making line 5 a
  per-station line — relevant to the Etagenruf, but *not* to the relay coil, which is across
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
- **The relay coil is across P1↔P4 = common ↔ Türruf, so the house ring energises it directly.**
  The ~12 V Türruf DC on line 4 drives ~12 V/320 Ω ≈ 37 mA through the coil to common and pulls
  WF26_K1 in — the ring *is* the coil drive; no external "session" supply needed. **WF26_K1:**
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
- C1 polarity (+ assumed toward P5).
- **Does line 4 hold ~12 V through the talk window, not just the ring?** Listen needs the relay
  to stay pulled in for the session, so the Türruf DC must persist past the chime. Re-measure
  P4→P1 idle / ringing / mid-talk-window.

**Interfacing takeaways (audio tap / virtual PTT):**
- Record/monitor: a high-Z tap on **P1/P5** (the transducer) captures gong, Etagenruf and both
  speech directions regardless of bus line — *but* it rides the relay/C1 path, so it dies when the
  gong is suppressed (line 4 broken). The board instead taps the **speech pair** (RX P1↔P2, TX
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
V3's `WF26-IN-P4` is V4's `IN_P4`).

**Reliability problem (the reason for V4):** Dupont jumper headers between perfboard and
relay module work loose over months. The redesign eliminates all inter-board jumpers by
integrating everything onto one PCB.

---

## V4 — integrated single board

**Design philosophy: carry the proven V3 analog path over.** The bell-sense front-end and
the relay contact arrangement (K2 COM=P2/NO=P3, K3 COM=P4/NC=IN-P4) are reproduced, with
deliberate improvements: per-opto LED limiters (a shared limiter would let a ringing channel
reverse-bias the idle opto's LED past its 6 V VR), anti-parallel reverse-clamp diodes on each
opto (polarity hardwired anode-to-bus-line), the direct ÖT bridge (K2), and the audio/PTT additions.
Line 4 carries the Türruf as a ~12 V DC level with the 3-Klang tone riding on it: the opto
(on IN_P4↔P1, **ahead of C1**) sees the DC-dominated level — so it is debounced in firmware
(`delayed_on`/`delayed_off`), not rectified — while C1 downstream blocks that DC and passes
only the AC tone on to LS1. Same line, two views: DC at the opto, audio at the speaker.

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C6-WROOM-1-N8** (LCSC C5366877) | ESPHome-supported, native USB, enough GPIO for the audio path (I²S + I²C + 3 relay gates + 3 opto inputs) |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT), Economic PCBA where eligible | J2 is through-hole (as are J1's shell stakes) but assembled by JLCPCB — nothing hand-soldered. Part eligibility/stock checks at order time: see `ORDERING.md` |
| Relays | **SMD signal relay, 4.5 V coil, gold/bifurcated contacts** (Omron G6K-2F-Y-TR DC4.5, LCSC C397193) | Dry, ≤12 VDC, mA-level switching; gold contacts beat silver at these low "wetting" currents. 4.5 V coil (must-operate 3.6 V) clears the post-Schottky ~4.5 V rail by ~0.7–0.9 V, with ~1.9 V headroom below the 6.75 V (150%) coil max. PhotoMOS SSRs (AQY212/TLP222A class, AC/DC type) were considered for click noise but rejected: K3 needs the fail-safe NC contact, clicks are rare and event-correlated, and no second board spin is planned. If K2's click ever bothers in the field, its land refits to a dead-bugged SOP-4 PhotoMOS (LED across coil pads 1/8 via ~680 Ω, output across contact pads 3/4) |
| Relay driver | **Discrete: 2N7002 + 1N4148W flyback + 10 k gate pull-down** | Pull-down ⇒ relays default OFF at boot |
| Opto polarity | **Fixed: LED anode → bus line, cathode → R_lim → P1** + **anti-parallel 1N4148W clamp** across each LED | Bus is taken to drive active lines **positive w.r.t. common (P1)**, so polarity is hardwired (no switch) — bench-confirm per channel by ringing each bell. The clamp limits reverse V to ~0.7 V (< the LED's 6 V VR) on the AC tone content |
| WF26 connector | **6-way screw terminal, 3.5 mm** (THT) | See "WF26 connector"; 6-way because line 4 needs in + out for the series chime-break |
| USB-C connector | **GCT USB4105-GF-A-060** (single-row SMD + THT shell stakes, C3025063) | ~⅓ the cost of a THT USB4085 and better stocked; the THT shell stakes keep cable-insertion strength, and the single-row SMD escape is workable on 4 layers (D+/D− on B.Cu over GND) |
| Layers | **4-layer** (F.Cu / +3V3 / GND / B.Cu) | Solid planes; GND on In2 (under B.Cu) so the USB D+/D− pair references GND |
| Power | **USB-C 5 V** → SS14 reverse-protection Schottky → **SGM2212-3.3** low-dropout LDO (C3294699) | The ~0.45 V Schottky drop still leaves ~1 V LDO headroom (an AMS1117's 1.3 V dropout would brown out under WiFi TX) |
| Audio | **Half-duplex path on-board**: ES8311 mono codec + SM-LP-5001 isolation transformer + K1 virtual-PTT relay; RX/TX tap the **speech pair (P1↔P2 / P1↔P3)**, gated by **OC1** (session = Türruf held, see "Audio path"); analog front-end provisional | The bus is half-duplex by design (single LS1 transducer) ⇒ no echo cancellation needed ⇒ within the C6's reach |
| Form factor | **Single PCB**, no daughter boards | Eliminates inter-board jumpers (the V3 failure mode) |

### ESP32-C6 GPIO map (matches `doorbell_design.py` NETS and `firmware/doorbell-v4.yaml`)

| GPIO | U1 pad | Signal | Dir | Notes |
|------|--------|--------|-----|-------|
| IO20 | 18 | K1 drive — virtual PTT (talk: IN_P4↔P3 via R16 2.2 kΩ) | out | series R (R6) gate-side; 10 k pull-down ⇒ off at boot |
| IO21 | 19 | K2 gate — front door buzzer / ÖT (bridge P2↔P3 direct) | out | 10 k gate pull-down ⇒ off at boot |
| IO22 | 20 | K3 gate — chime suppress (break IN_P4→P4) | out | 10 k gate pull-down ⇒ off at boot |
| IO3  | 26 | OC1 collector — house bell (Türruf, IN_P4) | in | internal pull-up (firmware) |
| IO2  | 27 | OC2 collector — apartment bell (Etagenruf, P5) | in | internal pull-up (firmware) |
| IO23 | 21 | **spare** — unused GPIO, pad free | — | available for reuse |
| IO12 / IO13 | 13 / 14 | USB D− / D+ | — | native USB-Serial-JTAG: flashing + logs |
| IO18 / IO19 | 16 / 17 | I²C SDA / SCL (10 k pull-ups R18/R19) | — | ES8311 control, addr 0x18 |
| IO11 / IO10 / IO0 | 12 / 11 / 8 | I²S BCLK / DIN(ASDOUT) / WS | — | ES8311; pad order matches U3's south-row pins for a crossing-free fan |
| IO6 / IO7 | 6 / 7 | I²S MCLK / DOUT(DSDIN) → U3 | out | ES8311 |
| IO9 | 15 | BOOT strap | — | 10 kΩ pull-up + button to GND |
| EN | 3 | Reset | — | 10 kΩ pull-up + 1 µF to GND (Espressif EN-RC spec) + button |
| IO8 | 10 | strap | — | 3.3 kΩ pull-up (R12, per C6 datasheet / DevKitC-1 R6) |
| IO1 / IO4 / IO5 | 9 / 4 / 5 | spare | — | No-Connect |
| IO15 | 23 | strap | — | left floating (acceptable per datasheet) |
| IO16 / IO17 | 25 / 24 | U0TXD / U0RXD | — | No-Connect |

### Bell / session sense front-end

Two identical channels (OC1 = house bell on IN_P4↔P1, OC2 = apartment bell on P5↔P1):

```
bus line (active, +) ──► opto LED anode ── LED ── cathode ──┬── R_lim (5.1k) ── P1 (common)
                          ▲ 1N4148W clamp, ANTI-parallel ───┘
opto collector ──► GPIO (internal pull-up)   opto emitters ──┬── R_em (1k, shared) ──► GND
```

- **Fixed polarity (no switch):** the bus is taken to drive active lines **positive** w.r.t.
  common, so each LED is hardwired **anode → bus line** (IN_P4 for OC1, P5 for OC2),
  **cathode → R_lim → P1** — it conducts on the active (positive) half. **Bring-up check (per
  channel):** ring the real bell and confirm detection, or look for the ~10.7 V drop across R_lim
  (≈2 mA) when active. If a channel never detects (near-0 V across R_lim, ~0.7 V across the LED),
  that line's polarity is the other way — swap the LED's two bus connections. The wrong guess is a
  silent non-detect, not damage: the clamp (D8/D9) holds the reverse-biased LED to ~0.7 V.
- **Reverse clamps (D8–D9, 1N4148W):** anti-parallel across each opto LED — clamp anode on
  the LED-cathode net, clamp cathode on the LED-anode net — so the clamp conducts only on
  the reverse half-wave and limits the LED's reverse voltage to ~0.7 V (< its 6 V VR).
  **Lib convention: 1N4148W pin 1 = cathode, pin 2 = anode** (CDFER JLCPCB lib, same as the
  flybacks D1–D3 and Schottky D4 — pin 1 toward +5V there).
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
  - **House Doorbell (OC1)** is forced off while PTT is engaged: K1 ties IN_P4 to P3 (via
    R16), so OC1's P1/IN_P4 node sees a bridge voltage and would report a phantom ring —
    which can pulse the door buzzer via auto-open. A real ring during a talk bridge is
    hardware-indistinguishable from the bridge, so masking the PTT window loses nothing.
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

### Relays

```
K2 (door opener / ÖT):    COM=P3 (direct), NO=P2, NC open — energise to bridge P2↔P3 (direct short)
K3 (chime suppress):      COM=P4, NC=IN_P4               — at rest passes the Türruf; energise to break it
K1 (virtual PTT):         COM→R16(2.2k)→P3, NO=IN_P4, NC open — energise to tie IN_P4↔P3 through R16 = talk
(K1 and K2 are pin-3/4 swapped vs the part's COM/NO labels — both poles are symmetric bridges, done for routing.)
```

- **G6K-2F-Y pinout:** coil 1/8; pole A COM=3, NC=2, NO=4; pole B COM=6, NC=7, NO=5
  (datasheet-verified).
- **Talk strap (K1).** Talk is **P4↔P3**, so K1 closes **IN_P4↔P3 through R16 (2.2 kΩ)** when
  energised. K1's pins 3/4 are swapped vs the part's COM/NO labels (COM = pin 3 → R16 → P3; NO =
  pin 4 → IN_P4): both poles are symmetric, so the function is identical and it routes cleanly
  (K2 is swapped the same way). K1, K2 and K3 are driven independently (no interlock). The board RX/TX
  taps the bus **speech pair** (RX P1↔P2, TX P1↔P3; see "Audio path"). The firmware now keeps **K3
  de-energised whenever PTT or a session is active**, so line 4 stays continuous during talk —
  whether the injected audio then actually reaches the door station is the open **outgoing-path**
  question (see "TX-out reach").
- **K1's NC is deliberately open** (not wired): a contact onto P3 here would permanently
  strap P4↔P3 (= talk) and fight the WF26's own S2.
- **K1 armature feedback: not fitted, by decision.** Wiring K1's spare pole B to a GPIO
  would only catch a welded/stuck contact — not a realistic failure mode for bifurcated
  gold contacts switching µA–mA dry loads — and a stuck-closed K1 only holds the talk strap
  (IN_P4↔P3 via R16, 2.2 kΩ), which the handset's own S2 asserts on every call anyway, too
  soft to fire the opener. K1 pole B stays spare. (If telemetry is ever wanted: K1.6 COM →
  spare GPIO w/ internal pull-up, K1.5 NO → GND; LOW = engaged.)

### Relay driver subcircuit (per channel)

```
GPIO ──100Ω── gate │ NMOS (2N7002)        coil ── +5V
              gate ──10kΩ── GND            coil ── drain
                  source ── GND      flyback D (1N4148W): cathode→+5V, anode→drain
```
4.5 V coils run off the +5V rail (≈4.5 V after the SS14 Schottky; keeps the 3V3 LDO
unloaded). The 10 kΩ gate pull-down holds each relay **off** while the GPIO floats during
boot — so the door opener can't pulse and the chime can't be silenced by a booting/dead
board.

### Power tree

```
USB-C VBUS (5V) ── F1 1A fast fuse ── SS14 (series reverse-protect) ── +5V ──┬── relay coils (+5V)
                                                          └── SGM2212-3.3 ── +3V3 ── ESP32-C6 + codec
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3: 10µF (C_out) + 10µF + 100nF decoupling
USB D±  ── IO12/IO13 (native USB)             SGM2212: 10µF in (C_in) / 10µF out (C_out)
USB D± ESD: TPD2S017 flow-through clamp (D5), VCC biased from fused VBUS; VBUS_F TVS: SMF5.0A (D10)
VBUS fuse: F1 (0466001.NRHF, 1A fast) ahead of all protection — a clamping D10 blows it (fail-safe)
```
> No bulk electrolytic: the local LDO actively regulates the ~350 mA WiFi-TX burst
> (modeled droop ≈ 90 mV across 20 µF of ceramic on +3V3), so a bulk cap buys nothing.
> VBUS cable-sag is a dropout-headroom question, covered by the low-dropout SGM2212.

### Galvanic isolation (preserve in layout)

The **bus side** (P1–P5, IN_P4, P4, T1 winding A) is galvanically separate from the **logic
side** (GND / +3V3 / +5V). The only crossings are *through* the optocouplers (input), the
relay coil↔contact air gaps (output), and T1's winding-to-winding isolation (audio;
SM-LP-5001 dielectric strength 2000 VRMS). **P1 is the bus common, not board GND.**
(Voltages are low — 12 VAC bus — so this is about hum/ground-loops more than shock.)

> **4-layer caveat:** the GND/+3V3 planes span the whole board, so bus-side traces run over
> logic-plane copper. Isolation is intact (the planes don't bridge the domains; the bus
> domain's only on-board path to logic is capacitive), and the coupling is small: the
> longest bus runs (P1/P5, ~120 mm of 0.5 mm trace over 0.21 mm prepreg) come to ≈10 pF
> ≈ 300 MΩ at 50 Hz — on-board hum injection is negligible; ground-loop exposure lives in
> the external wiring, not the stack. The J2 pad row's merged antipads already form a
> ~21 mm plane slot under the terminal block (both planes), thinning copper under the bus
> entry. Revisit with deliberate plane cut-outs only if hum shows up in practice.

### BOM

The BOM is **generated, not hand-maintained**: parts/values/footprints live in
`kicad/doorbell_design.py` (`COMP` / `FOOTPRINT`), LCSC part numbers in
`kicad/jlcpcb_files.py` (`EXTRA_LCSC`), and `./build.sh all-route` emits the order files
(`kicad/fab/doorbell-bom-jlcpcb.csv` + `doorbell-cpl.csv`). See `ORDERING.md` for the
stock/eligibility checks at order time.

> J1/J2 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered.

### PCB — stackup, floorplan & routing

**4-layer stack:** `F.Cu` (signals + parts) / `In1.Cu` = solid **+3V3** plane / `In2.Cu` =
solid **GND** plane / `B.Cu` (signals). GND on In2 (under B.Cu) so the USB D+/D− pair
routed on B.Cu references GND. +5V is a short surface trace. The board is a 4-layer stack; fab gerbers include
the inner layers.

**Why 4-layer.** J1 (USB4105) is a single-row SMD Type-C: D+/D−/CC/VBUS escape from one
fine-pitch interleaved pad row, which leans on the 4-layer stack — the D+/D− pair routes
together on B.Cu over the GND plane, and the remaining escapes fan out on F.Cu/B.Cu.
Placement around J1 must leave the escape fan room (re-verify the hand-routed escape
fan after any reshuffle).

**Why this plane assignment (not GND/3V3 swapped, a 5V plane, or a split In1).**
B.Cu is load-bearing (USB pair, P1/P5 weave, IN_P4), so a dedicated 5V
plane would cost a routing layer and break the J1 escape fan; +5V's loads (LDO in,
three relay coils + flybacks) are tens of mA at ms timescales, so a 0.5 mm trace is
electrically over-spec'd and a plane buys nothing. GND stays on In2 (not In1)
because USB on B.Cu is the only net that needs a direct plane reference; F.Cu
signals referencing the well-decoupled +3V3 plane is fine. A 3V3/5V split of In1
(5V island under the relay/LDO cluster) was considered and rejected: the boundary
would run near the audio nest (return-path cut where it matters most) and the spine
works as-is. Fallback if a re-floorplan ever breaks the +5V spine's threading
corridors: 5V island on In1 with the seam kept clear of the MIC/SEC/OUT region —
and combine it with the bus-side plane relief noted above.

**Power routing.** The power nets are hand-routed: **+5V** is a single 0.5 mm F.Cu
spine (D4 → C_in → LDO in, then up to the three relay coils + flybacks). GND/+3V3
reach the In2/In1 planes through 0.2 mm stubs + vias at every SMD pad; U2's tab and
J1's shield stakes are PTH (barrel-connected). **Neither exposed pad carries vias**
(solder-wicking avoidance): U1's and U3's EPADs are laced and bonded to the planes
through an adjacent pad's via, and no-via rule areas over both pad fields keep them
hole-free.

**Plane integrity & thieving (measured from the fill).** Both inner planes are solid
apart from the antenna keepout (all-layer, x≤37.1/y≥63.5) and 81 via/PTH piercings;
merging overlapping antipads (0.5 mm clearance, 0.25 mm min web) leaves ~9 slots per
plane. Notable: the J2 pad row (~21 mm slot at y=15, both planes — crossed only by bus
nets, which don't return through the planes); the USB pair's two via transitions (~3 mm
each — the one near U1 is crossed on F.Cu by I2C_SCL/I2S_BCLK/I2S_MCLK, a ~1.5 mm In1
return interruption, accepted at those edge rates); the rest are benign 2-via chains.
Copper thieving (`route.py`): a priority-1 GND zone plus a priority-0 floating zone per
outer layer. B.Cu float is empty (the GND thieve reaches everything); F.Cu float is a
few dozen sub-2 mm² slivers, each 0.21 mm over the solid +3V3 plane so lateral pickup
is plane-shunted (~10:1) — audio/hum coupling negligible. Every larger pocket is
grounded by a hand-placed GND stitching via in KiCad (relay/bus region, opto
block, OC2 jumper, bus corner, NW of U3, SE of J1, the opto-output column, and the
three gaps of the OUT/MIC column under T1, where the grounded strips also guard the
OUT pair from the MIC pair). `route.py` enforces a hard sliver limit post-fill: **the build FAILS on any
float island ≥ 2 mm² or ≥ 10 mm long** (the length test catches thin slivers that
dodge the area test). Sub-limit slivers are electrically inert and pass without
ceremony — there is no waiver mechanism.
Vias are never auto-placed: the remedy for an unwanted island is a hand-placed GND
stitching via in KiCad (the pocket then joins the GND thieve on the next fill) or
shrinking the pocket. `route.py` only refills the existing zones (idempotent) and
checks — it never creates copper.

**The board is 100% hand-routed** in KiCad — every net is hand-placed geometry in
`kicad/doorbell.kicad_pcb`.
`route.py` refills the inner planes and checks the ratsnest, FAILING the build
if any connection is unrouted — missing copper is routed in KiCad.

**Routing + plane recipe.** All copper is hand-placed in KiCad; the inner planes
(+3V3 on In1, GND on In2) are copper-fill zones in the board. `route.py` refills
every zone and verifies connectivity. Result: **0 unconnected, 0 DRC**.

**Floorplan** (positions live in the authoritative `doorbell.kicad_pcb`; the audio block is
tightly re-packed, so on-board positions differ from any tidy grid). Board ≈ **64 × 60 mm**, all parts on
the **top side**. **U1 bottom-left, rotated 180°, antenna flush on the bottom edge** over a
copper keepout; **J1 (USB-C) on the bottom edge** right of the antenna, mouth overhanging;
**J2 (WF26 terminal) flush on the top edge**, right side; the **opto sense block** (the two
optos, clamps, limiters, pull-ups) fills the upper-left; the **relay row** (K3, K2, K1 + drivers) runs across the
upper middle; the **audio cluster** (U3 + support passives, T1 below it) sits mid-board
between U1 and the LDO/USB area; LDO + buttons + power LED fill the right/centre gaps.

**Edge handling** (`EDGE_FLUSH` / `EDGE_OVERHANG` in `doorbell_design.py`): J1 and U1 are
pinned flush to the bottom edge (J1 sits on its footprint's recommended PCB-edge line,
shell mouth protruding ~1.3 mm so a cable seats fully), J2 flush to
the top edge; the remaining edges get a 1 mm margin off the tight bounding box.
`check_pcb.py` verifies the overhangs and that every other footprint stays inside the
outline.

**Antenna keepout:** an all-copper rule area (no tracks/vias/plane pour)
±15 mm either side of the WROOM-1 antenna, from just below U1's south pad row to the
bottom edge — clears the GND/+3V3 planes around the antenna. Fiducial placement avoids it.

**Fine-pitch clearance:** the ES8311's 0.40 mm pitch can't be routed under a 0.2 mm
net-class clearance (a 0.6 mm via can't sit beside a fine-pitch pin), so routing clearance
is set to JLCPCB's published **0.127 mm** capability — globally, since the tighter spacing
spreads board-wide. A global rule in `kicad/doorbell.kicad_dru` keeps KiCad's DRC
consistent; hole-to-copper is 0.2 mm to match. Trade-off: the
board routes at the fab limit rather than keeping a clearance design margin.

**Track widths:** signal nets route at the 0.2 mm default; the current-carrying nets
are widened to **0.5 mm** in KiCad: `+5V` (LDO input — ESP32
WiFi-TX peaks ~350 mA — plus three relay coils) and every net at WF26-bus potential —
`P1/P2/P3/P4/P5/IN_P4` (line 4 carries the TV20/S's Türruf signal through K3's NC
contact; the "gong" is an electronically generated tone played through the WF26's 16 Ω
speaker — there is no chime solenoid — so the worst-case bus current is bounded by the
speaker drive, well under 1 A), `TALK_BRIDGE` (K1↔R16↔P3, also bus potential), and the opto sense legs up to the LED
(`OCx_JP`, `OCx_CATH`, `OCx_RET`). The opto transistor sides (`OCx_OUT`, `OC_EMIT`),
the transformer secondary (`SEC_*`/`OUT_*`/`MIC_*`), and the relay gate-drive nets
(`GATE1`/`GATE1_DRV`/`GATE2`/`GATE2_DRV`/`GATE3`/`GATE3_DRV`) are not bus potential and
stay at 0.2 mm. KiCad's DRC does not enforce these widths.

**Routing notes (rationale; the trace geometry itself lives in the board).** A few
design choices behind the layout, worth keeping even though the coordinates are now in
`kicad/doorbell.kicad_pcb`:
- **Pin assignment exploits the C6 GPIO matrix** so the escape fans route crossing-free:
  the GPIO/relay-driver lanes leave U1 in west→east target order, and an I²C/I²S pin swap
  makes U3's control lanes land in **SDA, SCL, MCLK, BCLK** order with no crossings.
- **The floating audio front-end** (T1 secondary → R24–R27 series resistors → coupling
  caps) keeps each direction's legs **paired tightly (~0.329 mm)** to minimise the audio
  pair's pickup loop; the W→E resistor order is chosen so the whole nest routes without
  crossings. T1's bus winding owns the east pads (winding swap/polarity are inaudible).
- **The WF26 bus group** (P1–P5, IN_P4) and the opto block are fully hand-routed at bus
  width (see **Track widths**).
To free the NE corridor, the ESP-side USB pair takes a south
detour on B.Cu: straight stubs on the pad rows into vias in line with U1 pads 14/13
(DM's on its vertical at x=23.85; DP's 0.58 mm east so its drop clears DM's via,
converging to the 0.329 pair pitch just below), south beside GPIO8's B.Cu wall, then
45° SE into the eastbound pair at y=58.85/59.179 under T1 to the TPD2S017-side vias.

Build result: 0 errors, 0 unconnected, DRC clean (only the intentional
thieving-zone isolated-copper warning). R12 (GPIO8 strap
pull-up) lives SE of U1 beside C3, GPIO8 pad south onto a B.Cu via — GPIO8 crosses
under the I2S fan corridor from a via next to U1 pad 10 — and +3V3 pad north, tapping
the power rail that now runs in-line from U1 pad 2 through C6's and C3's +3V3 pads
into R12 (U1 pad 1 likewise feeds C6/C3's GND pads). The audio block anchors off U1's
east edge (constant chosen to preserve its position from the R12-anchored era).
The ESP-side USB pair (U1 pads 14/13) is fully hand-routed: east into a B.Cu via pair
at x=24.5, across B.Cu (over the In2 GND plane) as a tight pair — 0.327 mm
perpendicular on the 45° diagonals, 0.329 mm on straights — surfacing in a second via
pair west of the TPD2S017 and fanning into D5 pins 6/1. Via pairs sit 0.8 mm apart; the
partner trace stays on a wider offset past each via (0.166 mm trace-to-via copper gap)
before converging. The connector side is hand-routed too (F.Cu): D+/D− each
tie their A/B pad pair together and rise into the TPD2S017 inputs — DP joins A6↔B6
with a shallow U just south of the pad row and climbs a vertical at x=45.5 into D5
pin 4; DM tees at (44.152, 61.598), joining B7/A7 and running one 45° into D5 pin 3 —
and the CC lines wrap around J1's south side as two nested staircases (CC2 inside,
CC1 outside) up into their pulldowns. With these, every USB net (VBUS, VBUS_F, D±
both sides, CC1/CC2) is hand-routed.

**DRC** limits live in `kicad/doorbell.kicad_dru`, grounded in JLCPCB's published
capabilities (e.g. 0.127 mm spacing, 0.3 mm board-edge copper).

**Fiducials:** three `Fiducial_1mm_Mask2mm` marks (1 mm copper / 2 mm mask)
in an **asymmetric triangle** so the pick-and-place camera resolves orientation
unambiguously. The search grows inward from three corners (top-left, bottom-left,
bottom-right; top-right deliberately empty) on a 0.5 mm grid and takes the first spot
≥2 mm inside the board edge that clears every component **courtyard** by ≥1.4 mm and every
pad by ≥1.5 mm. JLCPCB adds its own panel/rail fiducials regardless — these are
belt-and-suspenders local references. Gotchas handled in code, so DRC stays 0/0:

- The search clears each footprint's *courtyard*, not just its pads — pad-only clearance
  can tuck a mark under a connector shell (invisible to the camera). The fiducial's own
  courtyard is kept so DRC courtyard-overlap catches regressions.
- The footprint is bare copper, not a placed part → `FP_EXCLUDE_FROM_POS_FILES` +
  `FP_EXCLUDE_FROM_BOM`, so it never enters the CPL (`jlcpcb_cpl.py` skips that attribute)
  or the BOM; its netless pad is exempted from `check_pcb.py`'s "every pad in a net" check.
- The stock fiducial pad's 0.6 mm local clearance override is dropped (inherit the
  board default) so DRC doesn't flag the gap on the netless pad.
- A minimal **F.Cu-only** keepout (r = 1.1 mm = mask radius + margin) around each mark
  stops tracks from running under the mask window (two nets in one exposed
  aperture = solder-mask bridge). Front-side only, so B.Cu/inner planes stay free; the
  fiducial's own pad is allowed inside.

### Build / test notes

- **Antenna:** flush on the bottom edge over the copper keepout — keep metal (enclosure,
  mounting plate) away from that edge.
- **Programming/bring-up:** flash + view logs over USB-C (native USB-Serial-JTAG); BOOT +
  EN buttons fitted for recovery.
- **Bench validation against the real TV20/S** (door pulse, chime suppress, session sense,
  PTT) before it goes in the wall. Probe via the commissioning test points (TP1 = GND
  scope anchor, TP2 = +5V, TP3 = +3V3), J2's screws, and component pads. The board has
  **no mounting holes** (accepted for the test-board run; revisit for the wall install).

---

## Audio path (half-duplex; analog front-end provisional)

**The bus is half-duplex by design — this simplifies everything digital.** Speech is on the
**1/2/3 group** (the STR *Sprechverkehr*): **listen on line 2, talk on line 3, ref line 1 (common)**.
The board taps that pair directly:

- **RX (listen):** capture **P1↔P2** — door-station → us.
- **TX (talk):** drive **P1↔P3** — us → door-station. K1 still asserts the talk handshake to the
  TV20/S. ⚠ The exact handshake and the end-to-end TX reach are bench-gated — see "TX-out reach."

Tapping 1/2/3 (not the WF26 *speaker* pair P1/P5) keeps the smart audio **independent of line 4 /
K3 / the relay**, so it works with the gong muted and is identical in replacement or parallel mode.
**The committed netlist still taps P1/P5 via T1 — a provisional first cut; re-tap to 2/3** (one
isolation transformer switched between line 2/line 3, or two — see "TX-out reach").

Consequences:
- **No acoustic echo cancellation.** Both directions are never streamed at once, so AEC is moot —
  full-duplex is physically impossible on this bus regardless of MCU, and the half-duplex path the
  bus supports is within the C6's reach (I²S codec + ESPHome half-duplex).
- **Sequencing, not mixing:** assert direction → settle → stream → release → stream the other
  (walkie-talkie cadence).

**"Can we send?" — session sense.** The Türruf DC (line 4) holds for the **whole session** — it
has to, or the WF26 relay drops and the handset goes dead — so **OC1, which senses it, stays
asserted edge to edge**. So "session active" = **OC1 high**, gated directly: no talk-window timer
needed (just debounce). Audio is gated on the session, direction by K1:

| Session (OC1) | K1 | State |
|---|---|---|
| inactive | – | no session — neither RX nor TX |
| active | released | listen → **capture (RX)** |
| active | engaged | talk → **send (TX)** |

⇒ "can I send right now?" = **OC1 high AND K1 engaged.**

**Codec + transformer (committed to the netlist; analog values provisional):**

- **U3 = ES8311** (mono codec, WQFN-20 3×3, 0.4 mm pitch; LCSC C962342) — mono is the
  right fit for half-duplex. Pinout wired per datasheet: CCLK=1, MCLK=2, PVDD/DVDD=3/4,
  DGND=5, SCLK=6, ASDOUT=7, LRCK=8, DSDIN=9, AGND=10, AVDD=11, OUTP/N=12/13,
  DACVREF/ADCVREF/VMID=14/15/16, MIC1N/P=17/18, CDATA=19, CE=20 (pull-down → addr 0x18),
  EP=GND.
- **T1 = Bourns SM-LP-5001** (600:600 1:1 line/audio transformer; LCSC C7503474), winding A
  (pads 1,3) currently across **P1/P5** (the WF26 speaker pair). **Provisional** — this rides the
  handset's C1/relay path, which ties it to line 4 (dies under gong-suppress). **To be re-tapped to
  the speech pair** (RX P1↔P2, TX P1↔P3), see "TX-out reach." Winding B (pads 4,6) is the secondary;
  centre taps 2,5 = NC.
- **Analog:** ES8311 differential OUTP/OUTN and MIC1P/MIC1N, AC-coupled (C_op/C_on/
  C_mp/C_mn, 1 µF) to T1 winding B. Out and mic share the secondary; **firmware mutes the
  idle direction** (standard ES8311 half-duplex), so no analog switch is needed and K1
  stays PTT-only.
- **Support net:** PVDD/DVDD/AVDD → +3V3 with decoupling; DACVREF/ADCVREF/VMID reservoir
  caps; CE/DGND/AGND/EP → GND. Symbols/footprints/3D imported with `easyeda2kicad` into
  `kicad/lib_audio/`.
- **EP grounding (no vias):** the QFN-20 centre EP carries no thermal vias — paste
  printed over open via holes wicks solder away from the joint, and the codec's milliwatt
  dissipation needs no dedicated path to the inner plane. The EP (and pin 10/AGND, which
  ties into it) grounds through the F.Cu GND pour; DRC confirms full connectivity. U3's
  imported package silk is stripped (it crossed pads → silk_over_copper).

**Is leaving LS1 connected electrically safe? — Yes.** LS1 is a passive 16 Ω transducer
the TV20/S is already designed to drive; a high-Z RX tap doesn't load it (handset keeps
working = free local monitoring). The constraints fall on **our injection stage**: drive
transformer-isolated, series-current-limited, high-Z/disabled except during talk, and rate
the amp for the parallel 16 Ω. Reasons to still lift one LS1 lead (1-wire mod) are
functional, not safety: (a) in TX the live mic mixes room ambient into what the door
station hears; (b) in RX incoming audio blares from the handset; (c) the amp wastes power
into 16 Ω.

**Bench-gated / open (analog front-end):**
- **Ring-tone overdrive: addressed** with R26/R27 (10 k) in series with each MIC leg —
  a −12.7 dB divider against the ES8311's 6 kΩ differential input, so a loud gong
  (~2.8–5.7 Vrms on the speaker pair) arrives at ≤1.4 Vrms (FS 2 Vrms, PGA min 0 dB).
  R24/R25 (1 k) in the DAC legs stop the idle DAC's low output impedance from shunting
  received audio off the shared winding and drop the TX high-pass corner to ~160 Hz.
  Verify levels on the bench; values are 0603 swaps if the attenuation needs trimming.
- Coupling-cap values, MIC1P/N input **biasing**, and whether to tie unused analog to
  AGND — all datasheet-typical, unverified on hardware.
- **⚠ TX-out reach / audio tap — re-tap the codec to the speech pair (lines 2/3).**
  Today the codec rides the **speaker pair (P1/P5)** via T1, leaning on the WF26's C1/relay path:
  it injects P5→C1→P4 and captures whatever reaches the speaker. That ties the smart audio to
  **line 4** — so **muting the gong (K3 breaks line 4) also kills the codec's RX/TX**, and the
  talk-out route is unconfirmed. But the **voice isn't on line 4**: per the STR *Sprechverkehr*
  (lines 1/2/3), **listen is line 2, talk is line 3** (line 4 is only the gong). So the fix is to
  **re-tap the codec onto the speech pair — RX ← line 2, TX → line 3 (ref line 1)** — which is
  independent of line 4 / K3 / the relay, so the smart RX/TX keep working with the gong muted and
  sidestep the "does talk ride line 4 or line 3" question (drive line 3 directly). The station
  handset's own audio still rides line 4 and goes quiet when muted — acceptable; nobody uses the
  handset while it's muted. **Bench-gated:** confirm which line carries the voice each way and **how
  the TV20/S is told to switch to talk** (the talk handshake). See `TODO.md`.

---

## Dual-mode variant: WF26 replacement ↔ parallel interface

Today the board is a **parallel interface** — it taps an external WF26's terminals and relies on
the handset's passive circuit. A small superset lets the *same* design also **replace** the WF26
outright while still degrading to a working handset when unpowered. One design, two install modes;
the only difference is whether the board's own passive WF26 core is connected to the bus.

**Fail-safe principle.** In replacement mode the board must behave like a WF26 with **no power**.
So the passive intercom (transducer, C1, the Türruf-driven relay, R1, the talk/door switches) is a
**self-contained circuit needing no board power**, and the smart layer (ESP32, codec, sense optos,
K1/K2/K3) is strictly **additive** — it parallel-taps the bus and defaults to inactive/transparent
when unpowered.

### Add: the passive WF26 core
These reproduce the handset (see "WF26 internal circuit") and run with zero board power:
- **Transducer** — 16 Ω speaker/mic across **P1↔P5** (LS1 equivalent; doubles as the mic for talk).
- **C1** — 22 µF across **P5↔P4** (audio crossover).
- **Türruf-driven relay** — coil across **P1↔P4**, pulled in by the ring's own ~12 V DC
  (~37 mA / 320 Ω), routing listen **line 2 → K1_COM → P4 → C1 → speaker**. Must be **bus-energised,
  not GPIO-driven** — that's what makes listen work unpowered.
  - *Future option — fold the session-sense into this relay and drop OC1 (NOT adopted; OC1 kept
    for now, the opto sense works):* make it a **12 V DPDT** with the **coil on IN_P4↔P1** (pre-K3,
    so it tracks the *incoming* Türruf even during gong-suppress). Pole A = K1_COM↔P4 (listen);
    pole B = **3V3 → GPIO + pull-down** = a galvanically-isolated, non-inverted **session/ring
    signal** (energised = HIGH) replacing OC1's opto sense (+ its limiter and clamp D8). Coil on
    IN_P4 also keeps station-listen alive through suppress. Cost: in parallel mode the coil draws
    ~15 mA (pick a sensitive coil) alongside the external WF26's — bench-confirm the real WF26 still
    pulls in.
- **R1** — 2.2 kΩ talk resistor.
- **Physical S1 (door, DPDT) and S2 (talk, DPDT)** wired as in the handset, so a person can open
  the door / talk by hand with the board dead.

### Mode selection: isolate the core with two links
In parallel mode the on-board core must not double the load on a real WF26 (two transducers → 8 Ω,
two coils → ~74 mA, two C1s). Only the three parts that sit **across the bus continuously** matter —
transducer (P1↔P5), C1 (P5↔P4), coil (P1↔P4) — and each runs from **P1 to P4 or P5**. So:

- **Keep P1 permanent; cut P4 and P5** (two passive links — solder bridges / 0 Ω / a 2-pole jumper).
  Each continuous load loses its non-P1 end, so none can conduct; a part tied only at P1 carries no
  current. Leaving P1 connected keeps the isolated core **referenced to the bus common** rather than
  floating.
- Isolation must be **passive** (links, not relays) — replacement mode must work unpowered.
- The talk/door switch paths are open at rest, so they need no link. The one residual is a *pressed*
  on-board button back-feeding the bus (talk → P3→R1→P4→coil→P1; door → P2↔P3) — momentary, unused in
  parallel mode, and duplicated by K1/K2. Add a third cut on **P3** only if accidental on-board
  presses must be inert too.
- **Links in → replacement** (core live); **links out → parallel interface** (core floating, today's
  behaviour). For interface-only builds, **DNP the core** instead of fitting links — same design,
  zero added parts.

Modes are mutually exclusive: **never run the on-board core and an external WF26 together** — that
is the doubled-load case the links exist to prevent.

### Already mode-agnostic (no change)
- **K3** is NC-passes-line-4 de-energised → the gong rings unpowered; chime-suppress still works in
  either mode.
- **K1/K2** default open (gate pull-downs) → they parallel the S2/S1 bridges; powered they add app
  talk/door, unpowered they vanish.
- **OC1/OC2** sense and the **codec audio tap** are high-Z / transformer parallel taps that work
  the same in both modes (the codec is planned to tap the speech pair, lines 2/3 — see "TX-out
  reach" — which is independent of the gong-suppress, so the smart RX/TX path is mode-agnostic).
- The **6-way connector** serves both: `IN_P4 → K3 → P4`, with P4 feeding the on-board core
  (replacement) or jumpering out to the external WF26 terminal 4 (parallel).

### Enclosure reuse (the existing WF26 housing)
The replacement variant drops into the **existing WF26 enclosure**, so outline, mounting and
placement are set by the housing, not by the part count — it's a mechanically-driven re-floorplan,
not a tweak of the current board:
- **Outline + mounting holes** match the WF26's own PCB: **64 mm (W) × 59 mm (H)**, mounting holes
  on the enclosure's existing bosses. (The board is already **64 mm wide**; it's still **~60 mm
  tall** (vs the 59 mm target) and has **no mounting holes** — so the remaining mechanical work is
  trimming the height to 59 mm once parts are re-floorplanned and adding the holes.)
- **Placement is pinned to the enclosure's openings**, not optimised for routing: the transducer
  behind the **speaker grille**, S1/S2 under the existing **button apertures**, and J2 (the 5-wire
  bus) at the housing's **wire entry**.
- **Power entry:** the WF26 has no USB/power opening, so the 5 V feed needs a route in (cable gland,
  an existing aperture, or an added hole) — the bus can't supply it.
- **Antenna:** the WROOM-1 PCB antenna needs an RF-transparent region — confirm the housing is
  plastic (no metal/foil) at the antenna edge and that the keepout clears enclosure ribs.
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
- **Small non-identical loads** when unpowered: each opto still pulls ~2 mA off a ringing line, and
  T1's primary sits across the transducer — negligible against 16 Ω + 320 Ω, but not zero.

---

## Verification status

Automated gates (run by `./build.sh all-route`): **ERC 0 errors, DRC 0/0, routes
0 unrouted, `check_pcb.py` PASS** — these verify the authoritative KiCad files; the
gerbers/BOM/CPL in `kicad/fab/` are exported from them. The firmware config passes `esphome config firmware/doorbell-v4.yaml`
(ESPHome 2026.5.3; needs a `secrets.yaml` with `wifi_ssid`/`wifi_password` alongside).

An independent blind review (no DESIGN.md / generator scripts; netlist re-extracted from
the routed PCB, every pinout re-checked against manufacturer datasheets) is recorded in
`VERIFICATION.md` — it found no polarity, pin-mapping or pin-usability errors and
converged with this document on all system-level conclusions.

**Cross-checked against the WF26** (netlist extracted from `wf26/wf26.kicad_sch` with
`kicad-cli`): J2 pin map; K3's series break matches the chime-suppress behaviour; K1's PTT
contact map and NC-open; T1 across LS1. The board matches the handset on the door/talk split —
K2 is a **direct P2↔P3 short** (genuine S1), the 2.2 kΩ (R16) is on the K1 talk strap (genuine R1),
and the relays are independent (no interlock, like the handset). **Still open:** the relay coil is
across **P1↔P4** (common↔Türruf, ring-driven), and idle line 4 sits at common (measured: P1↔IN_P4
= 0 V) but **holds through the session** (the relay must stay in, and V3 senses it fine), so
**session state = OC1 high**, gated directly (no timer).
**The end-to-end audio routing is an open investigation** — re-tap the codec to the speech pair
(RX ← line 2, TX → line 3) so it's independent of the gong-suppress; confirm the talk handshake on
the bench (see `TODO.md`, "TX-out reach"). See Relays / Bell-sense.

**Datasheet-verified:** G6K-2F-Y pole pinout; SGM2212 SOT-223 pinout + ~1 V dropout
headroom; relay coil margin (DC4.5 must-operate 3.6 V vs ~4.5 V rail); 1N4148W pin 1 =
cathode (CDFER lib); LTV-217 pinout; USB front-end (D+/D− not swapped; TPD2S017 pinout/V_CC bias,
CC 5.1 kΩ Rd); 2N7002 gate drive at 3.3 V; bell-sense GPIO LOW levels; ES8311 full pinout; SM-LP-5001 isolation
rating; every U1 pad↔GPIO assignment against the Espressif C6-WROOM-1 symbol.

**Known minor items (accepted):**
- One 0.388 mm bus↔logic clearance spot (<0.5 mm aspiration; fine for 12 V).
- A benign plane-stitch warning on U1's EPAD.
- No board fiducials (generator support exists, disabled): JLCPCB's CAM added two marks
  on the V4 proto, and the production drill file shows they are **drilled 1.152 mm
  positioning holes** (JLCPCB's standard SMT tooling size) through a 1.55 mm pad on both
  outer layers — mechanical fixture-registration holes, not flat optical fiducials. One
  sits at ~(2.1, 68.25), just west of (outside) the antenna copper-clear zone (estimated
  impact < 0.3 dB — accepted for proto); the other at (36.0, 64.5) west of T1. Because
  they register the assembly fixture, optical fiducials alone may not prevent them —
  V4.1: re-enable our own fiducials **and** pre-place 1.152 mm tooling holes at
  controlled positions (or carry an order remark keeping CAM-added holes away from the
  antenna edge).
- No mounting holes; three commissioning test points: TP1 = GND at (37.5, 62.5) (the logic ground is isolated from the bus, so TP1 is the scope-ground anchor; bus measurements reference J2.1/P1 instead), TP2 = +5V at (46.3, 21.1) (stub into K1's coil pad 1), TP3 = +3V3 at (28.6, 39.152) (stub onto R18's plane via). Bare 1.5 mm pads, excluded from BOM/CPL.
- Bench-confirm the relay-coil voltage under WiFi TX with a long USB cable if paranoid.
