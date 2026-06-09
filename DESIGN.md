# Doorbell controller (Klingel V4) — design reference

**V4 source of truth: `kicad/doorbell_design.py`** (nets, parts, footprints; `gen_schematic.py`
and `gen_pcb.py` generate the schematic and PCB from it — build with `./build.sh all-route`).
V4 firmware: `doorbell-v4.yaml`. LCSC part numbers: `kicad/jlcpcb_files.py` (`EXTRA_LCSC`).
Ordering: `ORDERING.md`. Reverse-engineered handset: `wf26/wf26.kicad_sch`.
Intercom system reference: `STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`.

V3 — the board currently deployed in the wall — is documented in its own section below
(sources: `KlingelV4.fzz` Fritzing schematic, `doorbell.yaml`, netlist via
`scripts/extract_netlist.py` → `build/netlist.txt`).

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
2. **Trigger the door opener** by simulating the ÖT button press (bridge lines 2+3)
3. **Suppress the chime** by switching line 4 (the Türruf signal)
4. **Half-duplex audio** (V4): capture/inject on the P1/P5 transducer pair, with a
   virtual-PTT relay emulating the handset's talk switch (analog front-end provisional)

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
| P1 | Line 1 | Common reference (all bell/speech ref to line 1) | Opto LED return: each LED → its own 5.1 kΩ limiter → P1 (via polarity switch). T1 winding A leg |
| P2 | Line 2 | Speech (Sprechen/Hören); bridged to 3 = ÖT | Relay K2 **COM**; K1 **NO** (talk); OC1 session-sense leg |
| P3 | Line 3 | Speech; bridged to 2 = ÖT door-opener trigger | Relay K2 **NO** → **R_ot (2.2 kΩ)** → P3 |
| P4 | Line 4 (WF26 side, J2.4) | Türruf path to the handset | Relay K3 **COM** → WF26 terminal 4. K3 opens this to suppress the chime |
| IN-P4 | Line 4 (TV20/S side, **incoming**, J2.6) | Türruf — ~12 VDC house-door gong, **in**; also the PTT handshake line | Relay K3 **NC** → OC2 sense **and** K1 **COM**. K3 NC retains the TV20/S signal when K3 is energised |
| P5 | Line 5 | Etagenruf — floor/apartment call (tone) | OC3 sense; OC1 session-sense leg; T1 winding A leg |

**Relay K2** (P2 on COM; NO → R_ot → P3) simulates pressing the ÖT button: energising K2
**bridges P2+P3 through R_ot (2.2 kΩ)** → TV20/S activates the door opener. The PDF's test
*"Klemmen 2 u. 3 brücken"* uses a dead short; the real handset — and this board, via R_ot —
bridges through 2.2 kΩ, which still triggers but only loads the speech pair instead of fully
shorting it. **Relay K3** (P4 on COM, IN-P4 on NC) breaks the Türruf line when energised to
suppress the chime.

**Why line 4 needs two pins.** K2 (door opener) *adds* a contact across P2+P3 — a parallel
closure, fine from a parallel bus tap. K3 (chime suppress) must *break* the Türruf so it
stops reaching the WF26 gong — a **series** operation, so line 4 is split at the board:
**P4** = WF26-handset side (J2.4 → K3 COM → WF26 terminal 4),
**IN-P4** = TV20/S-incoming side (J2.6 → K3 NC; "IN" = incoming from TV20/S).
OC2 and K1 COM both sit on IN-P4 (K3 NC side): K3 NC retains the TV20/S signal when K3 is
energised, so gong sensing and PTT both work during chime suppression. At rest K3 passes
IN-P4→P4 (gong rings, OC2 senses); energised it opens the line (gong silenced).

> **Line 4 is dual-purpose**: besides carrying the incoming Türruf (PCB net **IN_P4**,
> TV20/S side), line 4 is the **common of the WF26's Sprechen/Hören switch** — i.e. the
> PTT / on-hook handshake (PCB net **P4**, WF26 side). At rest S2 straps **P4↔P3
> (on-hook/listen)**; pressed it ties **P4↔P2 (off-hook/talk)**. Disconnecting P4 (the
> WF26-side net) forces a permanent off-hook and **suppresses the chime** (observed). See
> "WF26 internal trace" below.

> **Invariant to keep:** the door-opener bridge stays COM=P2, NO→P3, NC unconnected, with
> **R_ot (2.2 kΩ) in series on the NO→P3 leg** (net `OT_BRIDGE`) — matching the genuine
> WF26, whose ÖT button bridges 2↔3 through its own 2.2 kΩ (R1, confirmed by colour bands).

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

From `STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` (*Verdrahtungsplan* + *Fehlersuchhilfe*):

- **Power:** NTR201 transformer, 230 V~ → **12 VAC**; feeds the TV20/S control unit.
- **Door opener (Türöffner Tö):** **8–12 VAC, 1 A max** (~5–15 Ω), switched by the TV20/S
  on its terminals **8/9** — our board never carries this current.
- **Bell signals:** Türruf (house door) ≈ **12 VDC across terminals 4 & 1**; Etagenruf
  (floor call) measured across **5 & 1**. Line **1 is the common** reference.
- **Tones:** Türruf = **3-Klang-Gong** (3-chime); Etagenruf = **Dauerton** (continuous).
- **ÖT door-opener trigger (authoritative):** the troubleshooting test says
  *"Zum Test, Klemmen 2 u. 3 brücken"* — **bridge terminals 2 & 3** → opener voltage
  appears at 8/9. This is exactly what relay **K2** does (COM=P2, NO→R_ot→P3).
- **ET (Etagenruftaster):** floor-call button on the WF26; **ÖT** is the *additional*
  door-opener button. Both are momentary contacts across the 5-wire bus.
- **Speech:** only enabled *after* a bell; lines 1/2/3 carry audio (also 6/7 internally),
  ~25 s talk window, auto-off after ~60 s.

### TV20/S audio behaviour

Audio runs on lines 2+3 as a simple analogue half-duplex pair through the TV20/S amp.

- **Bell required first** — TV20/S only enables speech *after* a bell button press.
- **Talk** — resident presses Lautsprechertaste on WF26; lines 2+3 connect to amp → door
  station speaker.
- **Listen** — releasing the button reverses direction; door station mic → WF26 speaker
  for ~25 s.
- **Auto-disconnect** — WF26 drops the circuit after ~60 s regardless.

Implications: K2's 1750 ms ÖT bridge loads the speech pair through R_ot exactly like the
genuine button (momentary disturbance, not a dead short); clean relay contacts are the only
audio-related contact requirement. The V4 audio path itself taps P1/P5, not lines 2/3 — see
"Audio path" below.

---

## WF26 internal circuit (reverse-engineered)

The apartment handset (Sprechstelle **WF26/G**, PCB silk "…WF26") has **no MCU**, but it is
**not purely passive**: it contains an internal signal relay, an RC network and two
switches. The full internals are captured in **`wf26/wf26.kicad_sch`** (standalone,
ERC-clean KiCad project; teardown photos `IMG_5082.jpg` / `m53n9gtxg41f1.png`). Parts:
LS1 (16 Ω speaker/mic), S2 (Sprechen/Hören, DPDT), S1 (Türöffner/ÖT, DPDT), R1 (2.2 kΩ,
confirmed by colour bands red-red-red-gold), C1 (22 µF/50 V, value image-read), K2 (relay),
J1 (5-way bus = P1–P5).

| Net | Pins |
|-----|------|
| P1 | J1.1, LS1.2, C1.1(+) |
| P2 | J1.2, R1.1, C1.2(−), K2.7 (NO), K2.8 (coil) |
| P3 | J1.3, S2.1, S2.4, S1.1, S1.4 |
| P4 | J1.4, S2.2, S2.3, S2.5 |
| P5 | J1.5, LS1.1, K2.5 (coil) |
| S1_COM | R1.2, S1.2, S1.5 |
| K2_COM | K2.1, K2.12, S2.6 |
| n/c | S1.3, S1.6, K2.6 (NC) |

Key facts:

- **ÖT bridge:** pressing S1 ties lines 2↔3 *through R1 (2.2 kΩ)* — the genuine handset
  triggers the opener with a 2.2 kΩ bridge, not a dead short. V4's K2+R_ot replicates this
  exactly.
- **Line 4 is dual-purpose (ring *and* PTT handshake).** Line 4 carries the incoming
  house-door ring (the controller's opto across P1/IN-P4 detects it), **and** it is the
  common of the Sprechen/Hören switch S2:
  - **S2 at rest → P4↔P3** = on-hook / idle / **listen** — the state in which the gong
    can sound.
  - **S2 pressed → P4↔P2** (via relay common K2_COM; NO = P2) = off-hook / **talk**.

  Disconnecting P4 forces a permanent off-hook — the P4↔P3 strap breaks, the TV20/S reads
  the station as off-hook, and the chime is suppressed (matches the observed "remove P4 →
  no doorbell sound"). So: **talk = P4↔P2, listen = P4↔P3.**
- **Internal relay K2:** 6-pin DIL **SPDT (1 Form C)** — coil **5/8** (~320 Ω, across
  **P5↔P2**), common **1+12** (tied), contacts **6** (NC, unused) / **7** (NO = P2). The
  coil is energised by the TV20/S powering the line (session active), which **gates** the
  talk path: S2→K2_COM only reaches P2 while the coil is on.
- **Single transducer:** LS1 (16 Ω) sits directly across **P1↔P5** and is reused for tone
  output and both speech directions.

> Takeaway: nothing in the WF26 is "smart" — our board emulates its button presses
> (ÖT = bridge 2+3 via 2.2 kΩ, PTT = drive line 4) and senses the tone-drive lines (4, 5).
> No firmware handshake exists.

**Open / inferred (verify on the bench):**
- Which physical S2 slider position is "pressed/talk" — inferred from the relay gating +
  the doorbell test, not measured.
- How the Türruf (P4) / Etagenruf (P5) tones reach the transducer: LS1 is hard-wired
  **P1/P5**, which does not yet fully reconcile with the TV20/S "speech = lines 2/3"
  model — needs scoping.
- C1 polarity (+ assumed toward P1); NC vs NO of K2 pins 6/7 (de-energised, COM 1/12
  closes to NC).
- Relay part identity: the hand-drawn schematic labels it **TIANBO HJR-4102-N-12V**; the
  teardown photo was read as Siemens V23100 — confirm on the board, the pinout depends on it.

**Interfacing takeaways (audio tap / virtual PTT):**
- Record incoming audio: high-Z tap on **P1/P5** (speaker stays live, no board contact).
- Virtual PTT from the bus, board untouched: leave the handset's P4 floating, drive bus
  wire 4 yourself — **4↔3 = listen, 4↔2 = talk** (only during an active call; talk is
  relay-gated).
- Injecting TX audio on P1/P5 makes LS1 replay it (quiet at mic level); lift one LS1 lead
  to silence it (1-wire board mod).

---

## V3 — the deployed board (perfboard)

The system currently in the wall: an ESP32 DevKit + relay module on hand-wired perfboard,
running `doorbell.yaml` (`board: esp32dev`). Its sense/relay topology is what V4 carries
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

V3 netlist verified against `build/netlist.txt` (nets `WF26-P4`/`WF26-P5`, `N9`–`N12`;
V3's `WF26-IN-P4` is V4's `IN_P4`).

**Reliability problem (the reason for V4):** Dupont jumper headers between perfboard and
relay module work loose over months. The redesign eliminates all inter-board jumpers by
integrating everything onto one PCB.

---

## V4 — integrated single board

**Design philosophy: carry the proven V3 analog path over.** The bell-sense front-end and
the relay contact arrangement (K2 COM=P2/NO=P3, K3 COM=P4/NC=IN-P4) are reproduced, with
deliberate improvements: per-opto LED limiters (a shared limiter would let a ringing channel
reverse-bias the idle opto's LED past its 6 V VR), anti-parallel reverse-clamp diodes and
polarity switches on each opto, the ÖT bridge through R_ot, and the audio/PTT additions.
The Türruf AC tone is still debounced in firmware (`delayed_on`/`delayed_off`, not
rectified).

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C6-WROOM-1-N8** (LCSC C5366877) | ESPHome-supported, native USB, enough GPIO for the audio path (I²S + I²C + 3 relay gates + 3 opto inputs) |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT), Economic PCBA where eligible | J1/J2 are through-hole but assembled by JLCPCB — nothing hand-soldered. Part eligibility/stock checks at order time: see `ORDERING.md` |
| Relays | **SMD signal relay, 4.5 V coil, gold/bifurcated contacts** (Omron G6K-2F-Y-TR DC4.5, LCSC C397193) | Dry, ≤12 VDC, mA-level switching; gold contacts beat silver at these low "wetting" currents. 4.5 V coil (must-operate 3.6 V) clears the post-Schottky ~4.5 V rail by ~0.7–0.9 V, with ~1.9 V headroom below the 6.75 V (150%) coil max |
| Relay driver | **Discrete: 2N7002 + 1N4148W flyback + 10 k gate pull-down** | Pull-down ⇒ relays default OFF at boot |
| Opto polarity | **DPDT slide switch per opto** (NIDEC CAS-220TB1, C2921541) + **anti-parallel 1N4148W clamp** across each LED | Bus signal polarity is unconfirmed per channel; the switch selects it without rework, the clamp limits reverse V to ~0.7 V (< the LED's 6 V VR) on AC content |
| WF26 connector | **6-way screw terminal, 3.5 mm** (THT) | See "WF26 connector"; 6-way because line 4 needs in + out for the series chime-break |
| USB-C connector | **GCT USB4085** (2-row THT, C7095263) | Single-row SMD Type-C pads fight routing; USB4085's two TH rows escape cleanly |
| Layers | **4-layer** (F.Cu / +3V3 / GND / B.Cu) | Solid planes; GND on In2 (under B.Cu) so the USB D+/D− pair references GND |
| Power | **USB-C 5 V** → SS14 reverse-protection Schottky → **SGM2212-3.3** low-dropout LDO (C3294699) | The ~0.45 V Schottky drop still leaves ~1 V LDO headroom (an AMS1117's 1.3 V dropout would brown out under WiFi TX) |
| Audio | **Half-duplex path on-board**: ES8311 mono codec + SM-LP-5001 isolation transformer + K1 virtual-PTT relay + OC1 session-sense; analog front-end provisional | The bus is half-duplex by design (single LS1 transducer) ⇒ no echo cancellation needed ⇒ within the C6's reach |
| Form factor | **Single PCB**, no daughter boards | Eliminates inter-board jumpers (the V3 failure mode) |

### ESP32-C6 GPIO map (matches `doorbell_design.py` NETS and `doorbell-v4.yaml`)

| GPIO | U1 pad | Signal | Dir | Notes |
|------|--------|--------|-----|-------|
| IO21 | 19 | K2 gate — front door buzzer / ÖT (bridge P2+P3) | out | 10 k gate pull-down ⇒ off at boot |
| IO22 | 20 | K3 gate — chime suppress (break IN_P4→P4) | out | 10 k gate pull-down ⇒ off at boot |
| IO20 | 18 | K1 gate — virtual PTT (IN_P4↔P2) | out | drive routed through K3's pole-B interlock contact |
| IO3  | 26 | OC2 collector — house bell (Türruf, IN_P4) | in | internal pull-up (firmware) |
| IO2  | 27 | OC3 collector — apartment bell (Etagenruf, P5) | in | internal pull-up (firmware) |
| IO23 | 21 | OC1 collector — session-active sense (P5↔P2) | in | internal pull-up (firmware) |
| IO12 / IO13 | 13 / 14 | USB D− / D+ | — | native USB-Serial-JTAG: flashing + logs |
| IO18 / IO19 | 16 / 17 | I²S MCLK / BCLK → U3 | out | ES8311 |
| IO11 / IO10 / IO0 | 12 / 11 / 8 | I²S WS / DOUT(DSDIN) / DIN(ASDOUT) | — | ES8311 |
| IO6 / IO7 | 6 / 7 | I²C SDA / SCL (10 k pull-ups R18/R19) | — | ES8311 control, addr 0x18 |
| IO9 | 15 | BOOT strap | — | 10 kΩ pull-up + button to GND |
| EN | 3 | Reset | — | 10 kΩ pull-up + 1 µF to GND (Espressif EN-RC spec) + button |
| IO8 | 10 | strap | — | 10 kΩ pull-up (R12) |
| IO1 / IO4 / IO5 | 9 / 4 / 5 | spare | — | No-Connect |
| IO15 | 23 | strap | — | left floating (acceptable per datasheet) |
| IO16 / IO17 | 25 / 24 | U0TXD / U0RXD | — | No-Connect |

### Bell / session sense front-end

Three identical channels (OC2 = house bell on IN_P4↔P1, OC3 = apartment bell on P5↔P1,
OC1 = session sense on P5↔P2):

```
bus line A ──┬─[SW pole 1]─► opto LED anode ── LED ── cathode ──┬── R_lim (5.1k) ──[SW pole 2]──┬── bus line B
             │                  ▲ 1N4148W clamp, ANTI-parallel ─┘                               │
             └──────────────────┴── (switch pos B swaps A↔B on both poles simultaneously) ──────┘
opto collector ──► GPIO (internal pull-up)   opto emitters ──┬── R_em (1k, shared) ──► GND
```

- **Polarity switches (SW3–SW5, CAS-220TB1):** DPDT slide, commons on the centre pins 2/5
  (verified against the NIDEC CAS datasheet: throws 1/3 and 4/6, both poles ganged; contact
  rating non-switching DC 50 V / 100 mA — fine for the ~2 mA, ≤12 V opto loop). Pin 2 feeds
  the LED anode, pin 5 the R_lim return; throws 1+6 on one bus line, 3+4 on the other.
  Either position gives a complete loop of opposite polarity; a mirrored mounting is
  harmless.
- **Reverse clamps (D7–D9, 1N4148W):** anti-parallel across each opto LED — clamp anode on
  the LED-cathode net, clamp cathode on the LED-anode net — so the clamp conducts only on
  the reverse half-wave and limits the LED's reverse voltage to ~0.7 V (< its 6 V VR).
  **Lib convention: 1N4148W pin 1 = cathode, pin 2 = anode** (CDFER JLCPCB lib, same as the
  flybacks D1–D3 and Schottky D4 — pin 1 toward +5V there).
- **Per-opto limiters (R_lim1–3, 5.1 kΩ):** one per channel; a shared limiter would let a
  ringing channel lift the common node and reverse-bias the idle LED. R_em (1 kΩ emitter,
  shared) carries only µA and is not part of any reverse path.
- Bell present → LED conducts → phototransistor pulls the GPIO low → ESPHome
  `inverted: true` ⇒ "on". GPIO LOW level ≈ 0.12–0.27 V.
- **OC1 (session sense)** parallels the WF26's internal relay coil (P5↔P2, ~320 Ω,
  energised by the TV20/S only during a live session). R_lim3 = 5.1 k provisional pending
  the measured session voltage.
- **Cross-talk masking** (`doorbell-v4.yaml`, lambda filters ahead of the debounce): the
  **House Doorbell** input is forced off while PTT is engaged (K1 ties IN_P4 to P2, so
  speech audio appears across OC2's sense pair); the **Intercom Session** input is forced
  off while the Apartment Doorbell is ringing (the Etagenruf tone on P5 appears across
  OC1's P5↔P2 pair via the WF26's coil/C1 network). Both interferers are AC, so the raw
  input keeps toggling and the mask re-evaluates continuously while active.

### Relays

```
K2 (door opener / ÖT):    COM=P2, NO→R_ot(2.2k)→P3, NC open — energise to bridge 2↔3 like the genuine button
K3 (chime suppress):      COM=P4, NC=IN_P4            — at rest passes the Türruf; energise to break it
K1 (virtual PTT):         COM=IN_P4, NO→P2, NC open   — energise (talk) to tie TV20/S line 4 to line 2
```

- **G6K-2F-Y pinout:** coil 1/8; pole A COM=3, NC=2, NO=4; pole B COM=6, NC=7, NO=5
  (datasheet-verified).
- **K1's NC is deliberately open** (not wired to P3): de-energised, K1 makes no connection,
  so it cannot strap P4↔P3 through the relay chain and block the WF26's physical S2 from
  switching to talk while K3 is off.
- **Hardware interlock:** K3's spare pole-B NO contact sits in series with Q1's gate drive
  (`GATE1_PRE`: R_g1 → K3.5; `GATE1`: K3.6 → Q1 gate + R_pd1). K1 physically cannot
  energise unless K3 is already on — otherwise K1-talk with line 4 still through-connected
  would short P2↔P3 via the WF26's at-rest S2 strap and fire the door opener.
- **Release sequencing (firmware):** dropping K3 while K1 is held would reclose K3's
  pole-A NC (~1 ms) before K1's armature releases (~1–3 ms), momentarily dead-shorting
  P2↔P3 via the S2 strap. `doorbell-v4.yaml` guards this in the `doorbell_sound_state`
  sensor's `on_press` — the only code path that de-energises K3 — with
  `switch.turn_off: intercom_ptt` → `delay: 10ms` → K3 off. Using the switch (not the raw
  output) keeps the HA-visible PTT state in sync when a session ends with PTT latched on.
- **K1 armature feedback: not fitted, by decision.** Wiring K1's spare pole B to a GPIO
  would only catch a welded/stuck contact — not a realistic failure mode for bifurcated
  gold contacts switching µA–mA dry loads — and the worst case it would prevent (a few-ms
  P2↔P3 short) equals the TV20/S's own documented test action, too short to pull in the
  opener relay. The ≥10 ms firmware gap covers the bounded G6K release time with large
  margin; a simultaneous drop on power loss is equally benign and feedback wouldn't help.
  K1 pole B stays spare. (If telemetry is ever wanted: K1.6 COM → spare GPIO w/ internal
  pull-up, K1.5 NO → GND; LOW = engaged. Precedent for logic signals on a bus relay's
  pole B exists: K3's interlock.)

### Relay driver subcircuit (per channel)

```
GPIO ──100Ω── gate │ NMOS (2N7002)        coil ── +5V
              gate ──10kΩ── GND            coil ── drain
                  source ── GND      flyback D (1N4148W): cathode→+5V, anode→drain
```
4.5 V coils run off the +5V rail (≈4.5 V after the SS14 Schottky; keeps the 3V3 LDO
unloaded). The 10 kΩ gate pull-down holds each relay **off** while the GPIO floats during
boot — so the door opener can't pulse and the chime can't be silenced by a booting/dead
board. (K1's gate drive additionally runs through the K3 interlock contact, above.)

### Power tree

```
USB-C VBUS (5V) ── SS14 (series reverse-protect) ── +5V ──┬── relay coils (+5V)
                                                          └── SGM2212-3.3 ── +3V3 ── ESP32-C6 + codec
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3: 10µF (C_out) + 10µF + 100nF decoupling
USB D±  ── IO12/IO13 (native USB)             SGM2212: 10µF in (C_in) / 10µF out (C_out)
USB D± ESD: SRV05-4 (D5)
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
> logic-plane copper. Isolation is intact (the planes don't bridge the domains), but there
> is no plane-free slot; revisit with plane cut-outs under the bus side if ground-loop/hum
> coupling proves to matter.

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
routed on B.Cu references GND. +5V is a short surface trace. Set in `gen_pcb.py`
(`SetCopperLayerCount(4)`); fab gerbers include the inner layers.

**Why 4-layer + the USB4085 connector.** A single-row SMD Type-C carries D+/D−/CC/VBUS on
interleaved, duplicated pads in one row — a routing nightmare. The 2-row through-hole
USB4085 gives clean escapes, and 4 layers let the D+/D− pair route together on B.Cu over
the GND plane.

**Routing + plane recipe.** Freerouting routes on all four layers freely (no `LT_POWER`
designation, no pre-stitch vias). After the SES is imported, `route.py` pours +3V3 on In1
and GND on In2 as copper-fill zones; the filler leaves clearance gaps around any signal
traces Freerouting placed on those layers. Result: **0 unconnected, 0 DRC**; no
manually-placed vias.

**Floorplan** (`PCB_PLACE` in `gen_pcb.py`; the audio block is additionally re-packed by
rigid-body transforms in `gen_pcb.py`, so on-board positions differ from the raw table —
the generated `doorbell.kicad_pcb` is authoritative). Board ≈ **52 × 58 mm**, all parts on
the **top side**. **U1 bottom-left, rotated 180°, antenna flush on the bottom edge** over a
copper keepout; **J1 (USB-C) on the bottom edge** right of the antenna, mouth overhanging;
**J2 (WF26 terminal) flush on the top edge**, right side; the **opto sense block** (optos,
clamps, limiters) and the three **polarity switches** fill the upper-left (switch bodies
sit ~1 mm inside the left edge); the **relay row** (K3, K2, K1 + drivers) runs across the
upper middle; the **audio cluster** (U3 + support passives, T1 below it) sits mid-board
between U1 and the LDO/USB area; LDO + buttons + power LED fill the right/centre gaps.

**Edge handling** (`EDGE_FLUSH` / `EDGE_OVERHANG` in `doorbell_design.py`): J1 and U1 are
pinned flush to the bottom edge (J1 overhanging 3.1 mm so a cable seats fully), J2 flush to
the top edge; the remaining edges get a 1 mm margin off the tight bounding box.
`check_pcb.py` verifies the overhangs and that every other footprint stays inside the
outline.

**Antenna keepout:** `gen_pcb.py` adds an all-copper rule area (no tracks/vias/plane pour)
±15 mm either side of the WROOM-1 antenna, from just below U1's south pad row to the
bottom edge — clears the GND/+3V3 planes around the antenna. Fiducial placement avoids it.

**Fine-pitch clearance:** the ES8311's 0.40 mm pitch does not autoroute under a 0.2 mm
net-class clearance (a 0.6 mm via can't sit beside a fine-pitch pin), so routing clearance
is set to JLCPCB's published **0.127 mm** capability — globally, since the tighter spacing
spreads board-wide once the autorouter packs the escapes. `route.py` patches the DSN
(`clearance 200→127`); a global rule in `kicad/doorbell.kicad_dru` keeps KiCad's DRC
consistent; hole-to-copper is 0.2 mm to match. **Tracks stay 0.2 mm.** Trade-off: the
board routes at the fab limit rather than keeping a clearance design margin.

**DRC** limits live in `kicad/doorbell.kicad_dru`, grounded in JLCPCB's published
capabilities (e.g. 0.127 mm spacing, 0.3 mm board-edge copper).

**Fiducials** (`gen_pcb.py`): three `Fiducial_1mm_Mask2mm` marks (1 mm copper / 2 mm mask)
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
- The stock fiducial pad's 0.6 mm local clearance override is dropped (inherit the board
  default): Freerouting doesn't honour overrides on netless pads and DRC would flag the
  gap. (Fencing the fiducial off with an all-layer keepout instead starves the autorouter.)
- A minimal **F.Cu-only** keepout (r = 1.1 mm = mask radius + margin) around each mark
  stops autorouted tracks from running under the mask window (two nets in one exposed
  aperture = solder-mask bridge). Front-side only, so B.Cu/inner planes stay free; the
  fiducial's own pad is allowed inside.

### Build / test notes

- **Antenna:** flush on the bottom edge over the copper keepout — keep metal (enclosure,
  mounting plate) away from that edge.
- **Programming/bring-up:** flash + view logs over USB-C (native USB-Serial-JTAG); BOOT +
  EN buttons fitted for recovery.
- **Bench validation against the real TV20/S** (door pulse, chime suppress, session sense,
  PTT) before it goes in the wall. The board has **no dedicated test points** — probe on
  J2's screws and component pads — and **no mounting holes** (accepted for the test-board
  run; revisit for the wall install).

---

## Audio path (half-duplex; analog front-end provisional)

**The bus is half-duplex by design — this simplifies everything digital.** The WF26 has a
single 16 Ω transducer (LS1, across P1/P5) reused for both directions; the Sprechen/Hören
switch S2 (which K1 emulates) picks which:

- **PTT released → listen (P4↔P3):** LS1 is the **speaker** — door-station mic → handset →
  our **RX/capture** window.
- **PTT engaged → talk (P4↔P2):** LS1 is the **mic** — handset → door-station speaker →
  our **TX/inject** window.

Consequences:
- **One tap pair, not two.** RX and TX share P1/P5 and one codec, time-multiplexed;
  direction is owned by K1.
- **No acoustic echo cancellation.** Both directions are never tapped at once, so AEC is
  moot — full-duplex is physically impossible on this bus regardless of MCU, and the
  half-duplex path the bus actually supports is within the C6's reach (I²S codec + ESPHome
  half-duplex).
- **Sequencing, not mixing:** assert K1 → settle → stream one direction → release → stream
  the other (walkie-talkie cadence).

**"Can we send?" — OC1 session-sense.** Talk is relay-gated inside the WF26: its internal
relay coil (~320 Ω across P2↔P5) is energised by the TV20/S only while a session is live,
and S2 only reaches P2 while that coil is on. OC1 + K1 fully define the audio state:

| OC1 (P2↔P5 coil energised) | K1 | State |
|---|---|---|
| inactive | – | session dead — neither RX nor TX |
| active | released | listen → **capture (RX)** |
| active | engaged | talk → **send (TX)** |

⇒ "can I send right now?" = **OC1 active AND K1 engaged.**

**Codec + transformer (committed to the netlist; analog values provisional):**

- **U3 = ES8311** (mono codec, WQFN-20 3×3, 0.4 mm pitch; LCSC C962342) — mono is the
  right fit for half-duplex. Pinout wired per datasheet: CCLK=1, MCLK=2, PVDD/DVDD=3/4,
  DGND=5, SCLK=6, ASDOUT=7, LRCK=8, DSDIN=9, AGND=10, AVDD=11, OUTP/N=12/13,
  DACVREF/ADCVREF/VMID=14/15/16, MIC1N/P=17/18, CDATA=19, CE=20 (pull-down → addr 0x18),
  EP=GND.
- **T1 = Bourns SM-LP-5001** (600:600 1:1 line/audio transformer; LCSC C7503474), winding A
  (pads 1,3) across **P1/P5** — directly across the WF26's LS1, which sidesteps the
  "speech = lines 2/3" question for the tap point. Winding B (pads 4,6) is the secondary;
  centre taps 2,5 = NC.
- **Analog:** ES8311 differential OUTP/OUTN and MIC1P/MIC1N, AC-coupled (C_op/C_on/
  C_mp/C_mn, 1 µF) to T1 winding B. Out and mic share the secondary; **firmware mutes the
  idle direction** (standard ES8311 half-duplex), so no analog switch is needed and K1
  stays PTT-only.
- **Support net:** PVDD/DVDD/AVDD → +3V3 with decoupling; DACVREF/ADCVREF/VMID reservoir
  caps; CE/DGND/AGND/EP → GND. Symbols/footprints/3D imported with `easyeda2kicad` into
  `kicad/lib_audio/`.
- **EP grounding (deliberate no-via-in-pad exception):** the QFN-20 centre EP can't reach
  the inner GND plane via an offset via at 0.4 mm pitch, so `gen_pcb.py` drops a 2×2 GND
  via array inside the EP (pre-route, so Freerouting sees it grounded). U3's imported
  package silk is stripped (it crossed pads → silk_over_copper).

**Is leaving LS1 connected electrically safe? — Yes.** LS1 is a passive 16 Ω transducer
the TV20/S is already designed to drive; a high-Z RX tap doesn't load it (handset keeps
working = free local monitoring). The constraints fall on **our injection stage**: drive
transformer-isolated, series-current-limited, high-Z/disabled except during talk, and rate
the amp for the parallel 16 Ω. Reasons to still lift one LS1 lead (1-wire mod) are
functional, not safety: (a) in TX the live mic mixes room ambient into what the door
station hears; (b) in RX incoming audio blares from the handset; (c) the amp wastes power
into 16 Ω.

**Bench-gated / open (analog front-end):**
- **Ring-tone overdrive:** the Etagenruf tone is the speaker drive across P1/P5 — it hits
  T1 (a −10 dBm-class telecom transformer, primary DCR 115 Ω) and arrives 1:1 at ES8311
  MIC1P/N through the 1 µF caps with **no series limiting**. Every apartment ring
  overdrives the mic path; risk of codec input overstress. Add series R / divider / clamp
  on the MIC side (or attenuate at the primary) when finalising the front-end.
- Coupling-cap values, MIC1P/N input **biasing**, and whether to tie unused analog to
  AGND — all datasheet-typical, unverified on hardware.
- The **P1/P5-vs-lines-2/3** reconciliation (see "WF26 internal circuit — open items"):
  *where* TX injection reaches the door station depends on how the mic-on-P1/P5 couples
  to lines 2/3. Scope before finalising.
- **R_lim3** (OC1 limiter) = 5.1 k provisional pending the measured session voltage.

---

## Verification status

Automated gates (run by `./build.sh all-route`): **ERC 0 errors, DRC 0/0, routes
0 unrouted, `check_pcb.py` PASS**. The generated board must be rebuilt whenever
`doorbell_design.py` / `gen_pcb.py` change — the committed `.kicad_pcb`/gerbers are
outputs, not sources.

**Cross-checked against the WF26** (netlist extracted from `wf26/wf26.kicad_sch` with
`kicad-cli`): J2 pin map; K2's ÖT bridge mirrors the handset's S1+R1 path; K3's series
break matches the S2 topology and the observed chime-suppress behaviour; K1's PTT contact
map and NC-open; the K3 pole-B interlock; OC1 across the internal relay coil; T1 across
LS1.

**Datasheet-verified:** G6K-2F-Y pole pinout; SGM2212 SOT-223 pinout + ~1 V dropout
headroom; relay coil margin (DC4.5 must-operate 3.6 V vs ~4.5 V rail); 1N4148W pin 1 =
cathode (CDFER lib); LTV-217 pinout; USB front-end (D+/D− not swapped, SRV05-4 low-cap,
CC 5.1 kΩ Rd); 2N7002 gate drive at 3.3 V; bell-sense GPIO LOW levels; CAS-220 switch
contact arrangement (COM = pins 2/5) and rating; ES8311 full pinout; SM-LP-5001 isolation
rating; every U1 pad↔GPIO assignment against the Espressif C6-WROOM-1 symbol.

**Known minor items (accepted):**
- USB D+/D− is autorouted; for a guaranteed coupled pair, hand-route on B.Cu and lock —
  FS USB (12 Mbps) doesn't strictly require it.
- One 0.388 mm bus↔logic clearance spot (<0.5 mm aspiration; fine for 12 V).
- A benign plane-stitch warning on U1's EPAD.
- No mounting holes, no dedicated test points (see "Build / test notes").
- Bench-confirm the relay-coil voltage under WiFi TX with a long USB cable if paranoid.
