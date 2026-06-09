# Doorbell controller (Klingel V3) — design reference

Source of truth: `KlingelV4.fzz` (Fritzing schematic), `doorbell.yaml` (ESPHome),
`STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` (intercom system wiring diagram).
Netlist extracted by `scripts/extract_netlist.py` → `build/netlist.txt`.
V4 KiCad project scaffold + capture spec (net list, JLCPCB/CDFER part mapping): `kicad/`.

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

The ESP32 board taps into the 5-wire bus at the WF26 terminals to:
1. **Sense** when bells are rung (lines 4 and 5 carry ~12VDC bell signals)
2. **Trigger the door opener** by simulating the ÖT button press (bridge lines 2+3)
3. **Suppress the chime** by switching line 4 (the Türruf signal)

The board never touches the 8–12VAC door opener current — that is switched entirely
inside the TV20/S. All relay contacts carry low-voltage signalling only (≤12VDC,
milliamp-level). Small SMD signal relays are sufficient.

---

## WF26 connector — 6-way screw terminal (3.5 mm)

**Connector:** 6-way, 3.5 mm pitch **screw terminal**, THT (assembled by JLCPCB — through-hole, not hand-soldered).
The WF26 bus wires are fine, flimsy stranded (~26–28 AWG flat cable) — *below* the rated
minimum of Wago picoMAX/221 push-in & lever connectors (0.2 mm² ≈ 24 AWG), and push-in cage
clamps grip fine bare strands poorly without ferrules. A screw terminal clamps thin stranded
reliably (tin/fold the ends) and matches what the WF26 uses internally. (The earlier
Wago 2604-1105 spring-cage spec was wrong on both counts and is dropped.)

Five positions tap the bus (P1–P5); the **6th is IN-P4**, the line-4 return jumpered back
into the WF26 — see "Why line 4 needs two pins" below.

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| J2 pin | TV20/S line | Signal | Role in our circuit |
|-----|-------------|--------|---------------------|
| P1 | Line 1 | Common reference (all bell/speech ref to line 1) | Each opto LED cathode → its own 5.1 kΩ (R_lim1/R_lim2) → P1 |
| P2 | Line 2 | Speech (Sprechen/Hören); bridged to 3 = ÖT | Relay K2 **COM (MAIN1)** |
| P3 | Line 3 | Speech; bridged to 2 = ÖT door-opener trigger | Relay K2 **NO** → **R14 (2.2 kΩ)** → P3 |
| P4 | Line 4 (WF26 side, J2.4) | Türruf path to the handset | Relay K3 **COM** → WF26 terminal 4. K3 opens this to suppress the chime |
| IN-P4 | Line 4 (TV20/S side, **incoming**, J2.6) | Türruf — ~12 VDC house-door gong, **in**; also K1 PTT common | Relay K3 **NC** → OC2 anode (always-on) **and** K1 **COM**. K3 NC retains the TV20/S signal when K3 is energised |
| P5 | Line 5 | Etagenruf — floor/apartment call (tone) | → OC3 anode (apartment bell sense) |

**Relay K2** (P2 on COM/MAIN1; NO1 → R14 → P3) simulates pressing the ÖT button: energising
K2 closes COM1→NO1, **bridging P2+P3 through R14 (2.2 kΩ)** → TV20/S activates the door
opener. (The PDF's test *"Klemmen 2 u. 3 brücken"* uses a dead short; the real handset — and
now this board, via R14 — bridges through 2.2 kΩ, which still triggers but doesn't fully
short the speech pair. See "Audio system" note.) **Relay K3** (P4 on
COM/MAIN2, IN-P4 on NC2) breaks the Türruf line when energised to suppress the chime.

**Why line 4 needs two pins.** K2 (door opener) *adds* a contact across P2+P3 — a parallel
closure, fine from a parallel bus tap. K3 (chime suppress) must *break* the Türruf so it
stops reaching the WF26 gong — a **series** operation, so line 4 is split at the board:
**P4** = WF26-handset side (J2.4 → K3 COM → WF26 terminal 4),
**IN-P4** = TV20/S-incoming side (J2.6 → K3 NC; "IN" = incoming from TV20/S).
OC2 and K1 COM both sit on IN-P4 (K3 NC side): K3 NC retains the TV20/S signal when K3 is
energised, so gong sensing and PTT both work during chime suppression.
At rest K3 passes IN-P4→P4 (gong rings, OC2 senses); energised it opens the line (gong silenced) —
this is the proven V3 topology. V4 originally collapsed the WF26-side node to an internal-only net
(no jumper back to the WF26), silently breaking chime suppression; restored here on the 6-way J2 (pad 6).

> **Line 4 is dual-purpose** *(found 2026-06-08)*: besides carrying the incoming Türruf (PCB net **IN-P4**, TV20/S side), line 4
> is the **common of the WF26's Sprechen/Hören switch** — i.e. the PTT / on-hook handshake (PCB net **P4**, WF26 side).
> At rest S2 straps **P4↔P3 (on-hook/listen)**; pressed it ties **P4↔P2 (off-hook/talk)**.
> Disconnecting P4 (the WF26-side net) forces a permanent off-hook and **suppresses the chime** (observed). See
> "WF26 internal trace" below.

> **Invariant to keep:** the door-opener bridge stays COM=P2, NO→P3, NC unconnected — now
> with **R14 (2.2 kΩ) in series on the NO→P3 leg** (net `OT_BRIDGE`). (V3 named these
> `U2.MAIN1` / `U2.NO1`; V4 is K2 + R14.)

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | J2 pin |
|--------|----------|
| Orange | P1 |
| Green | P2 |
| Blue/white stripe | P3 |
| Blue | IN-P4 (line 4, **incoming from TV20/S**, J2.6) |
| Black | P5 |
| — (short jumper) | P4 (J2.4) → back into WF26 terminal 4 |

> To wire the series break: move the **blue** (line-4) wire off WF26 terminal 4 onto **J2.IN-P4 (pad 6)**,
> and run a short jumper from **J2.P4 (pad 4)** back to WF26 terminal 4. P1/P2/P3/P5 stay
> parallel taps on WF26 terminals 1/2/3/5.

---

## GPIO map (ESPHome ↔ hardware)

> ⚠️ **V3 (ESP32 dev board) mapping — kept for reference only.** These pins (25/26/32/33)
> **do not exist on the ESP32‑C3** and must NOT be used for V4. `doorbell.yaml` still carries
> these stale pins and `board: esp32dev`; remap it to the C3 pins below before flashing the V4
> board. See "ESP32‑C3 GPIO map (final)" for the authoritative V4 assignment.

| GPIO (V3) | ESPHome entity | Direction | Hardware | → V4 C3 pin |
|------|---------------|-----------|----------|----|
| 32 | `"Apartment Doorbell"` — binary sensor, pullup, inverted | Input | OC3 collector (senses P5 / Etagenruf) | **IO3** |
| 33 | `"House Doorbell"` — binary sensor, pullup, inverted | Input | OC2 collector (senses IN-P4 / Türruf, TV20/S side) | **IO10** |
| 26 | `front_door_buzzer_bin` — output, inverted | Output | Relay K2 (bridges P2+P3 = ÖT door opener) | **IO4** |
| 25 | `suppress_doorbell_sound_bin` — output, inverted | Output | Relay K3 (breaks IN-P4→P4 = chime suppress) | **IO5** |

---

## Circuit description

### Bell sense (inputs)
Each bell line drives a PC817 LED **referenced to the bus common P1** (the ~12 VDC bell
voltage sits across line 4↔1 / 5↔1, per the PDF), and the phototransistor pulls the
GPIO low. R2 and R1 are **shared** between both optos.
```
IN-P4 ──► OC2 LED anode ;  P5 ──► OC3 LED anode
OC2/OC3 LED cathodes ──┬── R2 (5.1kΩ, shared) ──► P1 (bus common)   [LED loop is bell↔P1]
OC2 collector ──► GPIO33 ;  OC3 collector ──► GPIO32   (ESP32 internal pull-up to 3V3)
OC2/OC3 emitters ──┬── R1 (1kΩ, shared) ──► GND
Bell present → LED conducts → phototransistor pulls GPIO low → ESPHome inverted:true ⇒ "on"
```
> R2 (5.1 kΩ) is the **LED series limiter on the cathode→P1 return**; R1 (1 kΩ) is the
> **phototransistor emitter resistor to GND** — the LED itself never connects to GND.
> Verified against `build/netlist.txt` (nets `WF26-P4`/`WF26-P5`, `N9`, `N10`/`N11`, `N12`). Note: V3 netlist used `WF26-IN-P4` for what is now `IN_P4` in V4.

### Relay outputs
```
K2 (GPIO26, front door buzzer):  COM(MAIN1)→P2, NO→R14(2.2k)→P3  — energise to bridge P2+P3 via 2.2k (ÖT)
K3 (GPIO25, chime suppress):     COM(MAIN2)→P4, NC→IN-P4 — energise to break Türruf line (IN-P4 = TV20/S/J2.6 side)
```

### Power
```
USB 5V → Vin → relay coils (JD-VCC, isolated)
3V3 → relay logic VCC + opto collector side
Common GND
```

---

## Audio system (TV20/S)

Audio runs on lines 2+3 as a simple analogue half-duplex pair through the TV20/S amp.

- **Bell required first** — TV20/S only enables speech *after* a bell button press.
- **Talk** — resident presses Lautsprechertaste on WF26; lines 2+3 connect to amp → door station speaker.
- **Listen** — releasing the button reverses direction; door station mic → WF26 speaker for ~25s.
- **Auto-disconnect** — WF26 drops the circuit after ~60s regardless.

**Implications for our circuit:**
- K2 (door opener) bridges lines 2+3 for 1750ms. The TV20/S interprets this short as an ÖT button press, not audio — momentary conversation disruption results. **Note (2026-06-08):** this disruption is *not* truly unavoidable — the genuine WF26 ÖT button bridges 2↔3 through **R1 = 2.2 kΩ** (confirmed), which still triggers the opener but only *loads* the speech pair instead of fully shorting it. **Implemented 2026-06-08:** added **R14 (2.2 kΩ, 0603)** in series with K2's NO contact
(`K2.NO → R14 → J2.P3`, net `OT_BRIDGE`), so the controller now bridges 2↔3 through 2.2 kΩ
exactly like the genuine handset instead of dead-shorting it. Board re-routed, DRC clean.
- The ESP32 has **no access to audio** — bell detection and relay switching only. Adding audio would require an analogue front-end tapping lines 2+3, which is out of scope.
- No special relay contact requirements for audio — clean contacts are sufficient.

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
  appears at 8/9. This is exactly what relay **K2** does (COM1=P2, NO1=P3).
- **ET (Etagenruftaster):** floor-call button on the WF26; **ÖT** is the *additional*
  door-opener button. Both are momentary contacts across the 5-wire bus.
- **Speech:** only enabled *after* a bell; lines 1/2/3 carry audio (also 6/7 internally),
  ~25 s talk window, auto-off after ~60 s — consistent with the Audio section above.

## WF26 internal circuit (from teardown photos / `m53n9gtxg41f1.png`)

The apartment handset (Sprechstelle **WF26/G**, PCB silk "…WF26") has **no MCU**, but it is
**not purely passive**: the teardown photo (`IMG_5082.jpg`) shows an **internal signal relay**
plus an RC network and the two switches. It has now been **fully reverse-engineered
(2026-06-08)** into a standalone, ERC-clean KiCad project — `wf26/wf26.kicad_sch`, see
**"WF26 internal trace"** below. V4's board still only reproduces its proven sense /
ÖT-bridge / line-4 series-break topology (it emulates button presses, not the handset); the
full trace exists for the audio-tap / virtual-PTT exploration. The hand-traced internal
schematic shows:

- **Speaker/Mic** — a single **16 Ω** transducer used for both Türruf/Etagenruf tone
  output and half-duplex speech.
- **Relay** — internal SPDT; **now fully traced** (see "WF26 internal trace" below). Part is
  uncertain: the hand-drawn schematic labels it **TIANBO HJR-4102-N-12V**; the teardown photo
  was read as Siemens V23100 — confirm the actual part on the board, as the pinout depends on it.
- **S2** — multi-pole **Sprechen/Hören (Lautsprechertaste)** changeover switch: routes
  the transducer between the tone path and the speech path (talk vs. listen).
- **S3** — the **Türöffner (ÖT)** / call buttons (momentary), bridging bus lines as above.
- **R1 = 2.2 kΩ** (**confirmed 2026-06-08** by colour bands red-red-red-gold = 22×10² ±5%),
  **C1 (22 µF / 50 V)**. R1 is **in series in the ÖT door-opener bridge**: pressing S1 ties
  lines 2↔3 *through R1*, i.e. the genuine handset triggers the opener with a **2.2 kΩ bridge,
  not a dead short** (C1 value still image-read — confirm if it matters).
- A **5-pin terminal block** = the bus interface (terminals 1–5 ↔ lines/P1–P5). Our board's
  6-way J2 taps P1–P5 here and jumpers IN-P4 back onto terminal 4.

> Takeaway: nothing in the WF26 is "smart" — our board simply emulates its button presses
> (ÖT = bridge 2+3) and senses the tone-drive lines (4, 5). No firmware handshake exists.

> Note on labels: **K2/K3 are the relays' own designators** on the 2-channel module
> (channel 1 / channel 2), driven by GPIO26 / GPIO25 respectively.

### WF26 internal trace (reverse-engineered 2026-06-08)

Full handset internals captured in **`wf26/wf26.kicad_sch`** (standalone KiCad project, custom
HJR-4102 relay symbol, ERC-clean). Parts: LS1 (16 Ω speaker/mic), S2 (Sprechen/Hören, DPDT),
S1 (Türöffner/ÖT, DPDT), R1 (2.2 kΩ), C1 (22 µF/50 V), K2 (relay), J1 (5-way bus = P1–P5).

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

**Headline finding — line 4 is dual-purpose (ring *and* PTT handshake).** Line 4 / Türruf carries
the incoming house-door ring (confirmed: the controller's AC opto across P1/IN-P4 detects it),
**and** it is the common of the Sprechen/Hören switch S2:
- **S2 at rest → P4↔P3** = on-hook / idle / **listen** — the state in which the gong can sound.
- **S2 pressed → P4↔P2** (via relay common K2_COM; NO = P2) = off-hook / **talk**.

So **disconnecting P4 forces a permanent off-hook** — the P4↔P3 strap breaks, the TV20/S reads
the station as off-hook, and the chime is suppressed (matches the observed "remove P4 → no
doorbell sound"). This confirms the polarity: **talk = P4↔P2, listen = P4↔P3** (the earlier
"P3↔P4 = talk" guess is actually the listen/idle state).

**Relay K2:** 6-pin DIL **SPDT (1 Form C)** — coil **5/8** (~320 Ω, across **P5↔P2**), common
**1+12** (tied), contacts **6** (NC, unused) / **7** (NO = P2). The coil is energised by the
TV20/S powering the line (session active), which **gates** the talk path: S2→K2_COM only
reaches P2 while the coil is on.

**Open / inferred (verify on the bench):**
- Which physical S2 slider position is "pressed/talk" — inferred from the relay gating + the
  doorbell test, not measured.
- How the Türruf (P4) / Etagenruf (P5) tones reach the transducer: LS1 is hard-wired **P1/P5**,
  which does **not** yet fully reconcile with the TV20/S "speech = lines 2/3" model — needs scoping.
- C1 polarity (+ assumed toward P1); NC vs NO of K2 pins 6/7 (de-energised, COM 1/12 closes to NC).
- Relay part identity (HJR-4102 vs Siemens V23100, above).

**Interfacing takeaways (audio tap / virtual PTT):**
- Record incoming audio: high-Z tap on **P1/P5** (speaker stays live, no board contact).
- Virtual PTT from the bus, board untouched: leave the handset's P4 floating, drive bus wire 4
  yourself — **4↔3 = listen, 4↔2 = talk** (only during an active call; talk is relay-gated).
- Injecting TX audio on P1/P5 makes LS1 replay it (quiet at mic level); lift one LS1 lead to
  silence it (1-wire board mod).

---

## Current build (V3, on perfboard — for reference)

| Ref | Part | Role |
|-----|------|------|
| U1 | LuaNode32 / ESP32 DevKit (ESP-WROOM-32, 30-pin), socketed | MCU |
| U2 | 2-ch relay module (SONGLE SRD-05VDC-SL-C), separate board | K2 + K3 |
| OC2 | PC817 optocoupler | House bell sense |
| OC3 | PC817 optocoupler | Apartment bell sense |
| R2 | 5.1 kΩ (2010 SMD) | Opto LED series limiter (shared, in cathode→P1 return) |
| R1 | 1 kΩ (2010 SMD) | Opto phototransistor emitter resistor (shared, to GND) |
| J4–J9 | Camdenboss CTB0158 screw terminals (various sizes) | Wiring breakout |
| U3, U4 | 2× 15-pin machine-pin sockets | Hold ESP32 DevKit |
| Perfboard | — | Hand-wired substrate |

**Reliability problem:** Dupont jumper headers between perfboard and relay module
work loose over months — this is the connector that requires periodic adjustment.
The redesign eliminates this entirely by integrating everything onto one PCB.

---

## Redesign (V4) — integrated single board

**Design philosophy: carry the proven V3 analog path over verbatim.** The bell-sense
front-end (2× PC817, 5.1 kΩ cathode→P1 LED limiters, 1 kΩ shared emitter→GND)
and the relay contact arrangement (K2 COM=P2/NO=P3, K3 COM=P4/NC=IN-P4) are reproduced
**unchanged** — with one deliberate fix: the V3 *single shared* LED limiter is split into one
5.1 kΩ resistor per opto (**R_lim1, R_lim2**) so a ringing channel can't reverse-bias the idle
opto's LED past its 6 V VR (review finding 5). The Türruf AC tone is still debounced in firmware (via
`delayed_on`/`delayed_off`, not rectified). The only genuinely new work is **integration**:
an ESP32-C3 MCU, USB-C power, and **discrete relay coil drivers** replacing the SONGLE
module — all on one JLCPCB-assembled PCB. No low-level "what works" is re-engineered.

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C3-WROOM-02-N4** (LCSC C2934560) | Same C3 SoC, ESPHome-supported, native USB. Chosen over the ESP32-C3-MINI-1 because the **MINI-1 is Standard-PCBA-only** at JLCPCB (forces the $25/side setup); the **WROOM-02 is Economic-PCBA-eligible**. Larger module (18×20 vs 13×17 mm) but the board had room |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT), **Economic PCBA** | SMT parts reflowed; J1/J2 (USB-C, WF26 terminal) are through-hole but **also assembled by JLCPCB** — nothing hand-soldered. Every part (the WROOM-02, the G6K relays, the THT connectors) is Economic-eligible, so no $25/side Standard setup is needed |
| Relay | **SMD signal relay, 4.5 V coil, gold/bifurcated contacts** (Omron G6K-2F-Y-TR DC4.5, LCSC C397193) | Dry, ≤12 VDC, mA-level switching; gold contacts are *more* reliable than the V3 SONGLE's silver at these low "wetting" currents. **4.5 V** (not 5 V) coil so the post-Schottky ~4.5 V rail clears the 3.6 V must-operate with margin (see review finding 2) |
| Relay driver | **Discrete: logic-level NMOS + flyback diode + gate pull-down** | The SONGLE module did this for us; now on-board. Pull-down ⇒ relays default OFF at boot |
| WF26 connector | **6-way screw terminal, 3.5 mm** (THT, JLCPCB-assembled) | Bus wire ~26–28 AWG is below Wago push-in/lever min (0.2 mm²); screws clamp fine stranded reliably. 6-way because line 4 needs **in + out** for the series chime-break |
| USB-C connector | **GCT USB4085** (2-row THT) | The cheap single-row SMD Type-C (HRO) carries interleaved/duplicated D+/D−/CC/VBUS pads that fight routing; USB4085's two TH rows escape cleanly. LCSC C7095263 |
| Layers | **4-layer** (F.Cu / +3V3 / GND / B.Cu) | Solid GND + power planes; GND on In2 (under B.Cu) so the USB D+/D− pair on B.Cu references GND; keeps signals off the planes |
| Power | **USB-C** (5 V) → **SGM2212-3.3** (low-dropout LDO, LCSC C3294699) via a series SS14 VBUS reverse-protection Schottky | native-USB flashing/logging on the C3; +5V & +3V3 distributed on the planes. Low-dropout part chosen so the ~0.45 V Schottky drop still leaves ~1 V headroom (an AMS1117's 1.3 V dropout would have browned out under WiFi TX) |
| Form factor | **Single PCB**, no daughter boards | Eliminates all inter-board jumpers (the V3 failure mode) |
| Audio | **Half-duplex PTT path now on-board** (K1 PTT relay + OC1 session-sense); analog front-end still bench-gated | Bus is half-duplex (single LS1 reused) ⇒ no echo-cancel ⇒ C6 suffices; supersedes the 2026-06-06 "needs S3+PSRAM" deferral. See "Audio (revisited)" |

### ESP32-C3 GPIO map (final)

| GPIO | Signal | Dir | Notes |
|------|--------|-----|-------|
| IO20 | K2 relay driver — front door buzzer / ÖT (bridge P2+P3) | out | pad 11 (north row); IO20/U0RXD — high-Z input at reset, pull-down holds relay off |
| IO10 | K3 relay driver — chime suppress (break IN-P4→P4) | out | pad 10 (east end, north row); gate pull-down ⇒ off at boot |
| IO3 | OC2 collector — house bell sense (Türruf, IN-P4 TV20/S side) | in | pad 15 (north row, faces OC2); internal pull-up (firmware) |
| IO1 | OC3 collector — apartment bell sense (Etagenruf, P5) | in | pad 17 (north row, faces OC3); internal pull-up (firmware) |
| IO4 / IO5 / IO6 / IO7 | — (unused) | — | No-Connect; freed when relay drivers moved to north row |
| IO18 / IO19 | USB D− / D+ | — | native USB-Serial-JTAG: flashing + logs |
| IO9 | BOOT strap | — | 10 kΩ pull-up + button to GND |
| EN | Reset | — | 10 kΩ pull-up + 1 µF to GND (Espressif EN-RC spec value) (+ optional button) |
| IO21 | UART0 TX | — | **No-Connect** — ROM drives HIGH at boot; must not be reused as relay gate |

Avoided: IO2 / IO8 / IO9 (strapping), IO11–IO17 (internal flash), IO21/U0TXD (ROM drives HIGH at boot — unsuitable as relay gate). All four active GPIOs — IO20/IO10 (relay drivers) and IO3/IO1 (bell sense) — are non-strapping and on U1's **north castellated row**, which directly faces both the opto block and the relay cluster. IO20 (pad 11, x=6.7 mm) drives K2; IO10 (pad 10, x=8.2 mm) drives K3 — saving ~25 mm vs. the former south-row IO4/IO5 assignment. Bell-sense pads (IO3=pad 15, IO1=pad 17) route ~7–11 mm straight up to OC2/OC3. IO20/U0RXD is safe as a gate driver: it is a high-Z input at reset, so the 10 kΩ pull-down holds K2 off during the boot window. IO8 carries a 10 kΩ pull-up (R10, download-mode robustness); **IO2 is left floating** — Espressif's datasheet (Table 3-3 fn 2) recommends a 10 kΩ pull-up there to harden boot against glitches (optional).

### Relay driver subcircuit (per channel)

```
GPIO ──100Ω── gate │ NMOS (2N7002)        coil ── +5V
              gate ──10kΩ── GND            coil ── drain
                  source ── GND      flyback D (1N4148W): cathode→+5V, anode→drain
```
4.5 V coils run off the +5V rail (≈4.5 V after the SS14 Schottky; keeps the 3V3 LDO unloaded). The 10 kΩ gate pull-down
holds each relay **off** while the GPIO floats during boot — so the door opener can't
pulse and the chime can't be silenced by a booting/dead board.

### Power tree

```
USB-C VBUS (5V) ── SS14 (series reverse-protect) ── +5V ──┬── relay coils (+5V)
                                                          └── SGM2212-3.3 ── +3V3 ── ESP32-C3
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3: 10µF (C_out) + 10µF + 100nF decoupling
USB D±  ── IO18/IO19 (native USB)             SGM2212: 10µF in (C_in) / 10µF out (C_out)
```
> No bulk electrolytic: the 470 µF was **removed** — the local LDO actively regulates the
> ~350 mA WiFi-TX burst (modeled droop ≈ 90 mV across 20 µF of ceramic on +3V3), so a bulk
> cap buys nothing here. VBUS cable-sag is a dropout-headroom question, covered by the
> low-dropout SGM2212, not a cap-size one.

### Galvanic isolation (preserve in layout)

The **bus side** (P1–P5, IN-P4, and P4) is galvanically separate from the **logic side**
(GND / +3V3 / +5V). The only crossings are *through* the optocouplers (input) and the
relay coil↔contact air gap (output). **P1 is the bus common, not board GND.** Keep a
clearance gap / slot between the two domains on the PCB. (Voltages are low — 12 VAC bus —
so this is about hum/ground-loops more than shock, but it's a property worth keeping.)

> **4-layer caveat:** the GND/+3V3 planes now span the whole board, so the bus-side traces run
> over logic-plane copper. Isolation is still intact (only the optocouplers and relay air-gap
> cross the domains — the planes don't bridge them), but the plane-free slot is gone; revisit
> with plane cut-outs under the bus side if ground-loop/hum coupling proves to matter.

### BOM (draft — confirm JLCPCB/LCSC stock at order time)

| Ref | Part | Footprint |
|-----|------|-----------|
| U1 | ESP32-C3-WROOM-02-N4 (LCSC C2934560) | module (18×20 mm, castellated + EPAD) |
| U2 | SGM2212-3.3 (low-dropout LDO, LCSC C3294699) | SOT-223 |
| J1 | **GCT USB4085** USB-C 2.0 (LCSC C7095263) | THT, 2-row — JLCPCB-assembled |
| J2 | 6-way screw terminal, 3.5 mm (e.g. 4Ucon / generic KF128-3.5 6P) | THT — JLCPCB-assembled |
| K2, K3 | Signal relay, **4.5 V coil**, SPDT, gold contacts (G6K-2F-Y-TR DC4.5, C397193) | SMD |
| Q2, Q3 | 2N7002 (logic-level NMOS) | SOT-23 |
| D2, D3 | 1N4148W (flyback) | SOD-123 |
| OC2, OC3 | PC817 / EL817S (SMD opto) | SOP-4 |
| R_lim1, R_lim2 | 5.1 kΩ (opto LED limiter, one per opto) | 0603 |
| R_em | 1 kΩ (opto emitter, shared) | 0603 |
| R_g2, R_g3 | 100 Ω (gate series) | 0603 |
| R_pd2, R_pd3 | 10 kΩ (gate pull-down) | 0603 |
| R_en, R_boot | 10 kΩ | 0603 |
| R_cc1, R_cc2 | 5.1 kΩ (USB-C CC) | 0603 |
| C_* | 10 µF×3 (C_in, C_out, C_3v3), 100 nF×2 (C_en, C_dec) | 0603 |
| LED_pwr + R | power indicator (+3V3) | 0603 |

> J1/J2 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered. Prefer LCSC *Basic* parts
> elsewhere; give K2/K3 a second source.

### PCB — stackup, floorplan & routing

**4-layer stack:** `F.Cu` (signals + parts) / `In1.Cu` = solid **+3V3** plane / `In2.Cu` = solid
**GND** plane / `B.Cu` (signals). GND on In2 (under B.Cu) so a USB D+/D− pair routed on B.Cu
references GND. +5V is a short surface trace. Set in `gen_pcb.py`
(`SetCopperLayerCount(4)`); fab gerbers include the inner layers.

**Why 4-layer + the USB4085 connector.** The original single-row Type-C
(`HRO TYPE-C-31-M-12`) carries D+/D−/CC/VBUS on *interleaved, duplicated* pads in one row — a
routing nightmare (it needed a hand-placed VBUS bridge, and the autorouter split the D+/D− pair
around obstacles). Switching J1 to the **GCT USB4085** — a 2-row *through-hole* Type-C (LCSC
C7095263) — gives clean escapes, and going 4-layer lets the **D+/D− pair route together** on
B.Cu over the GND plane.

**Routing + plane recipe.** Freerouting routes on all four layers freely (no `LT_POWER`
designation, no pre-stitch vias). After the SES is imported, `route.py` pours +3V3 on In1 and
GND on In2 as copper-fill zones; the filler leaves clearance gaps around any signal traces
Freerouting placed on those layers. Result: **0 unconnected, 0 DRC**; no manually-placed vias.

**Floorplan** (`PCB_PLACE` in `gen_pcb.py`): the **ESP32-C3-WROOM-02 (U1, rot 90°)** sits
left-of-centre with its antenna overhanging the left edge; the **opto bell-sense block** (OC2/OC3,
the two 5.1 kΩ limiters, the shared emitter R) is centred in the **upper-left quadrant** just above
U1; the LDO (U2), boot/reset buttons, power LED and the decoupling/LDO caps cluster around U1
(caps along the bottom-left, R10 right of C3); **USB-C (J1) centred on the bottom edge**, mouth
overhanging downward, CC pulldowns flanking it; **bus interface on the right** (WF26 6-way terminal
on the top edge, relays + drivers). All four active GPIOs (IO20/IO10 relay drivers, IO3/IO1 bell sense) are on U1's **north** castellated row — IO20(pad 11)→K2 and IO10(pad 10)→K3; bell-sense routes straight up to OC2/OC3 (~7–11 mm). See the GPIO map.

**Edge overhang** (`EDGE_OVERHANG` in `doorbell_design.py`): J1 overhangs the bottom edge by
3.1 mm (the connector shell clears the PCB) and U1 overhangs the left edge by 5.9 mm (< the
WROOM-02's 7.42 mm antenna depth) so its **antenna sits off-board** while pins 1/18 stay ~1.5 mm
inside the edge — which is why the old copper antenna keep-out is gone (nothing on
the board to keep clear). `check_pcb.py` verifies each overhang and that the rest of every
footprint stays inside the outline.

**DRC** limits live in `kicad/doorbell.kicad_dru`, grounded in JLCPCB's published 2-layer
capabilities (e.g. 0.127 mm spacing inside J1's fine-pitch courtyard, 0.3 mm board-edge copper).

**Fiducials** (`gen_pcb.py`). Three global PCBA optical reference
marks — `Fiducial:Fiducial_1mm_Mask2mm` (1 mm copper / 2 mm mask) — forming an **asymmetric
triangle** so the pick-and-place camera can resolve board orientation unambiguously. The search
grows inward from three corners (top-left, bottom-left, bottom-right; top-right deliberately empty)
on a 0.5 mm grid and takes the first spot that sits ≥2 mm inside the board edge and clears every
**component courtyard** by ≥1.4 mm, every pad by ≥1.5 mm. JLCPCB adds its own
panel/rail fiducials during assembly regardless, so these are belt-and-suspenders local references;
on a board this dense they're optional, but they cost nothing and are good practice.

*Spread caveat:* this board is packed — the only large open region is the upper-left, the true
bottom-right corner is entirely under J1's USB-C shell, and the top-right is full of J2 + the
relays. So the achievable marks are FID1 top-left (1.9, 14.1), FID2 bottom-left (8.4, 56.1), FID3
bottom-centre (21.6, 56.6, just left of J1) — a tall triangle (43 mm) with a ~20 mm base, narrower
on the right than ideal but correct and DRC-clean. There is **no** spot on the right third with
≥1.4 mm body clearance (best candidate clears a part by only 1.28 mm, under the fiducial's own
1.3 mm courtyard half-extent → would overlap), so a fourth/right-side mark isn't placeable.

Five gotchas, all handled in code so DRC stays **0/0**:
- **A fiducial must not land under a component body.** The search clears each footprint's
  *courtyard*, not just its pads — an early version checked only pad distance and tucked FID3 into
  the gap *between* J1's two USB-C pad rows, i.e. under the connector shell (invisible to the
  camera). The fiducial's courtyard is **kept** (not stripped) so DRC courtyard-overlap catches any
  future regression of this kind; the ≥1.4 mm courtyard clearance (> the mark's 1.3 mm courtyard
  half-extent) keeps that check clean.
- The footprint is **bare copper, not a placed part** → `FP_EXCLUDE_FROM_POS_FILES` +
  `FP_EXCLUDE_FROM_BOM` so it never enters the CPL (`jlcpcb_cpl.py` skips that attribute; the
  panel CPL already filters to real refdes) or the BOM. Its netless pad is exempted from
  `check_pcb.py`'s "every pad in a net" check the same way.
- The stock fiducial pad carries a **0.6 mm local clearance override** that Freerouting (DSN) does
  not honour on a netless pad — it routes to the 0.2 mm board default and DRC then flags the gap.
  Fix: **drop the override** (inherit 0.2 mm) rather than fence the fiducial off — an all-layer
  keepout starves this dense autorouting and breaks a net.
- An autorouted F.Cu track can still run *under* the 2 mm mask window, exposing two nets in one
  aperture (a solder-mask bridge). Fix: a **minimal F.Cu-only keepout** (no tracks/vias, r =
  1.1 mm = mask radius + margin) around each fiducial — front-side only, so B.Cu/inner planes stay
  free and routing still completes 0 unrouted. The fiducial's own pad/footprint are explicitly
  allowed inside it.

### Build / test notes

- **Antenna:** the ESP32-C3-WROOM-02 antenna **overhangs the left board edge** (off-board), so no
  on-board copper/keep-out is needed under it — just keep no metal enclosure over it.
- **Programming/bring-up:** flash + view logs over the USB-C (native USB-Serial-JTAG); add
  BOOT + EN buttons (or pads) for recovery.
- **Test points:** P1–P5, +5 V, +3V3, the 4 GPIOs, UART0 — for bench validation against the
  real TV20/S (door pulse + chime suppress) before it goes in the wall.

### Audio — evaluated and deferred (2026-06-06) — ⚠️ partly superseded 2026-06-08 (see "Audio (revisited)" below)

Two-way intercom audio (press/hold talk + send/receive) was considered and **deliberately
left out of V4**:
- ESPHome can do it, but good **full-duplex** intercom (with echo cancellation) needs
  **ESP32-S3/P4 + PSRAM** (e.g. the community `esphome-intercom` component); core ESPHome
  is half-duplex and the C3 can't run the full-duplex stack.
- The analog bridging is fully **custom and unproven on this TV20/S**: tap/inject on the
  lines 2/3 speech pair (12 VAC-referenced → *Netzbrummgefahr*, likely needs an audio
  isolation transformer) and emulate the WF26's multi-pole S2 talk switch.
- If ever pursued, do it as a **separate ESP32-S3 daughterboard** tapping lines 2/3 — so the
  proven C3 core is never put at risk. The core board intentionally carries **no audio hooks**.

### Audio (revisited 2026-06-08) — half-duplex PTT path now on the board

Superseding the "evaluated and deferred" decision above. The board now carries the hooks for a
**half-duplex** intercom path: **U1 is an ESP32-C6-WROOM-1-N8** (swapped from the C3-WROOM-02 for
more GPIO + headroom) and **K1** (a third G6K-2F-Y relay + 2N7002/1N4148W driver on **GPIO3**) is
fitted as the **virtual PTT** relay (contacts currently N/C until the audio circuit is finalised).
`kicad/doorbell_design.py` is the authoritative net/BOM.

> ⚠️ Doc-sync debt: the MCU decision row, the "ESP32-C3 GPIO map (final)" table and the BOM still
> read **C3-WROOM-02**. The board is **C6-WROOM-1-N8** per the script — those sections need a
> separate C3→C6 sync pass (pad numbers, GPIO assignments, BOM line).
>
> ⚠️ **U1 LCSC mismatch (action needed):** `jlcpcb_files.py` `EXTRA_LCSC["U1"]` is still
> **C2934560** (commented "ESP32-C3-WROOM-02-N4"). The footprint/COMP are now C6-WROOM-1 — ordering
> as-is would assemble the **wrong module on the wrong pad layout**. Replace with the real
> C6-WROOM-1-N8 LCSC before fab. (Not auto-changed — an LCSC part # must not be guessed.)

**As-built after this change (build verified: ERC 0 err, DRC 0/0, routes 0 unrouted, `check_pcb` PASS):**

- **K1 wired as the virtual PTT** (pole A): **COM = IN-P4 (TV20/S/K3-NC side, J2.6), NC → P3 (listen/idle, default), NO → P2
  (talk)**. COM on K3 NC so PTT still works when K3 is energised (K3 NC retains the TV20/S signal even with the line broken).
  Default at boot = listen (gate pull-down holds K1 off). Driver Q1/D1 on **GPIO3**.
  Pole B (pads 5/6/7): hardware interlock — K3's spare pole-B contacts in series with Q1 gate drive;
  K1 physically cannot energise unless K3 is already on (IN-P4→P4 line already broken).
- **OC1 session-sense added**: LED across **P2↔P5** via **R_lim3** (5.1 k, value TBD), collector →
  **GPIO2 / pad 27** (non-strapping), emitter on the shared `OC_EMIT`. "Can send" = OC1 active AND K1 talk.
- **Phase 2 COMMITTED to the netlist (2026-06-08; ERC 0 err/DRC 0/routes 0-unrouted, board now
  ~90×68 mm).** Codec = **ES8311** (U3, **mono**, WQFN-20 3×3 0.4 mm pitch; LCSC **C962342**) —
  switched from the ES8388 because mono is the right fit for half-duplex (only one channel was ever
  used) and `easyeda2kicad` removed the footprint barrier. Isolation = **T1 = Bourns SM-LP-5001**
  (600:600 **1:1** line/audio transformer; LCSC **C7503474**), primary winding across **P1/P5** —
  *tap confirmed from `wf26/wf26.kicad_sch`*: LS1 (16 Ω speaker/mic) sits **directly across P1↔P5**
  (pin1=P5, pin2=P1; C1 22 µF parallel P1→P2), so tapping the transducer sidesteps the "speech=2/3"
  question. **T1 pinout:** winding A = pads **1,3** (across P1/P5), winding B = pads **4,6**
  (secondary), center taps **2,5 = NC**. U1 LCSC corrected to **C5366877**. *Symbol+footprint+3D for
  both ES8311 and SM-LP-5001 imported with `easyeda2kicad` into `kicad/lib_audio/`; registered in
  the project sym/fp-lib-tables.*
  - **Digital interface (wired to U1):** I²S **MCLK=GPIO18, BCLK=GPIO19, WS=GPIO11,
    DSDIN=GPIO10, ASDOUT=GPIO0**; I²C **SDA=GPIO6, SCL=GPIO7** (10 k pull-ups R18/R19);
    CE→GND (addr 0x18). MCLK is ESP-driven. Spare GPIO left: 1/4/5.
  - **Analog: ES8311 differential** OUTP/OUTN + MIC1P/MIC1N, AC-coupled (C_op/C_on/C_mp/C_mn) to
    T1 winding B (SEC_A=pads 4, SEC_B=pad 6). Out and mic share the secondary; **firmware mutes the
    idle direction** (standard ES8311 half-duplex) — so the **K1 pole-B audio switch was dropped**;
    K1 is back to PTT-only on pole A, pole B spare.
  - **Support net** (U3): PVDD/DVDD/AVDD→+3V3 with decoupling; DACVREF/ADCVREF/VMID reservoir caps;
    CE/DGND/AGND/EP→GND.
  - **EP grounding (deliberate no-via-in-pad exception):** the QFN-20 center thermal EP can't reach
    the inner GND plane via an offset via at 0.4 mm pitch, so `gen_pcb.py` drops a **2×2 GND via
    array inside the EP** (pre-route, so Freerouting sees it grounded). U3's imported package-silk is
    stripped (it crossed pads → silk_over_copper).
  - ⚠️ **Routing required relaxing clearance — see "Fine-pitch clearance" below.**
  - ⚠️ **Still bench-gated / open:** coupling-cap values, MIC1P/N input **biasing**, and whether to
    tie unused analog to AGND — all **provisional, datasheet-typical, unverified on hardware**.

#### Fine-pitch clearance (2026-06-08)

The ES8311's **0.40 mm pitch** would not autoroute under the board's conservative **0.2 mm**
net-class clearance: a 0.6 mm via can't sit beside a fine-pitch pin at 0.2 mm, so the power/GND
pins couldn't escape. Footprint was verified to **match the official KiCad land pattern** (not a bad
import) — the 0.2 mm clearance halo was the cause. **Fix:** relaxed routing clearance to JLCPCB's
published **0.127 mm** capability — globally, since the tighter spacing spreads board-wide once the
autorouter packs the escapes. `route.py` patches the DSN (`clearance 200→127`); a global DRU rule
makes KiCad's DRC consistent; hole-to-copper relaxed 0.25→0.2 mm to match. **Tracks stay 0.2 mm.**
Trade-off: the board's 0.2 mm copper-clearance *design margin* is spent (now routes at JLCPCB's
0.127 mm fab limit). Reverting to ES8388 is the alternative if that margin must be kept.

#### ESP32 antenna keepout (2026-06-08)

`gen_pcb.py` adds an all-copper rule area (no tracks/vias/plane pour) **±15 mm either side of the
WROOM-1 antenna**, from just below U1's south pad row to the bottom edge — clears the GND/+3V3 planes
around the antenna. Fiducial placement avoids it.

**The bus is half-duplex by design — this simplifies everything digital.** The WF26 has a
**single 16 Ω transducer (LS1, across P1/P5)** *reused* for both directions; the Sprechen/Hören
switch S2 (which K1 emulates) picks which:
- **PTT released → listen (P4↔P3):** LS1 is the **speaker** — door-station mic → handset → our **RX/capture** window.
- **PTT engaged → talk (P4↔P2):** LS1 is the **mic** — handset → door-station speaker → our **TX/inject** window.

Consequences:
- **One tap pair, not two.** RX and TX share P1/P5 and one codec, time-multiplexed; direction is owned by K1.
- **No acoustic echo cancellation.** You never tap both directions at once, so AEC is moot — which
  **supersedes the main reason audio was deferred** ("full-duplex needs ESP32-S3/P4 + PSRAM").
  Full-duplex is physically impossible on this bus regardless of MCU; the **half-duplex path the bus
  actually supports is within the C6's reach** (I²S codec + ESPHome half-duplex). Re-evaluate.
- **Sequencing, not mixing:** assert K1 → settle → stream one direction → release → stream the other (walkie-talkie cadence).

**Detecting "can we send" — OC1 session-sense.** Talk is **relay-gated inside the WF26**: its
internal relay coil (~320 Ω, across **P2↔P5**) is energised by the TV20/S only while a session is
live, and S2→K2_COM reaches P2 only while that coil is on. So OC1 + K1 fully define the audio state:

| OC1 (P2↔P5 coil energise) | K1 | State |
|---|---|---|
| inactive | – | session dead — neither RX nor TX |
| active | released | listen → **capture (RX)** |
| active | engaged | talk → **send (TX)** ✅ |

⇒ "can I send right now?" = **OC1 active AND K1 engaged.** Add **OC1** (third LTV-217/PC817,
identical to the OC2/OC3 bell front-end) + **R_lim3** limiter, LED across the session pair,
phototransistor → a spare C6 GPIO, firmware-debounced. *Bench-confirm the session voltage's
pair/level/AC-ness before fixing R_lim3 and whether an anti-parallel diode is needed for AC.*

**Is leaving LS1 connected electrically safe? — Yes.** LS1 is a passive 16 Ω transducer the TV20/S
is already designed to drive, so nothing is overstressed by merely leaving it in circuit, and a
**high-Z RX tap doesn't load it** (handset keeps working = free local monitoring). The only
constraints fall on **our injection stage**, not LS1: drive it **transformer-isolated,
series-current-limited, and high-Z/disabled except during talk**, and rate the amp to drive the
parallel **16 Ω**. Reasons to still **lift one LS1 lead** (the 1-wire mod) are **functional, not
safety**: (a) in TX the live mic mixes room ambient into what the door station hears; (b) in RX
incoming audio blares from the handset; (c) the amp wastes power into 16 Ω.

**Still bench-gated (unchanged):** the **P1/P5-vs-lines-2/3** tap-point reconciliation (see "Open /
inferred" above). LS1 sits on P1/P5 but the TV20/S models speech on 2/3; *where* TX is injected
depends on how the mic-on-P1/P5 reaches 2/3. Scope this before committing the codec/transformer front-end.

---

## Design review findings (2026-06-07)

Full adversarial review (datasheet-verified pinouts + routed-board parse). **No Critical/Major
defect in the PCB.** Automated: ERC 0 err, DRC 0/0, `check_pcb` PASS. Open items:

**Verified CLEAN (datasheet/board-confirmed):** relay contact mapping (G6K-2F-Y coil 1/8,
COM3/NC2/NO4 — K2 bridges P2+P3, K3 breaks IN-P4→P4); SGM2212 SOT-223 pinout + ~1 V headroom;
diode polarity (D4 reverse-protect, D2/D3 flyback, pad1=cathode); USB front-end (D+/D− not
swapped, SRV05-4 low-cap, CC 5.1 kΩ Rd, no UART bridge, internal D+ pull-up); 3V3 decoupling
adequacy (470 µF unnecessary); 2N7002 gate drive @3.3 V; bell-sense logic levels
(GPIO LOW ≈0.12–0.27 V); all U1 pads on-board despite the overhang; antenna keep-out; plane
connectivity; galvanic isolation (bus↔logic only via optos/relay gaps).

**To address:**
1. **[Resolved — firmware remapped]** `doorbell-v4.yaml` uses `board: esp32-c3-devkitm-1` and the V4 GPIO map (OC2/Türruf→IO3, OC3/Etagenruf→IO1, K2→IO10, K3→IO20); logs over USB_SERIAL_JTAG.
2. **[Resolved — switched to DC4.5 coil]** With the 5 V coil, must-operate (80% = 4.0 V) sat
   just under the post-Schottky ~4.5 V rail (coil ~4.31 V, 86%) — thin, and negative under VBUS
   sag. **Fixed:** K2/K3 are now the **G6K-2F-Y-TR DC4.5** (LCSC C397193, must-operate 3.6 V), so
   the same ~4.5 V rail clears pickup by ~0.7–0.9 V, with ~1.9 V headroom below the 6.75 V (150%)
   max coil voltage. Same footprint/pinout. Bench-confirm coil V under WiFi TX + long cable if paranoid.
3. **[Mitigated — inner planes swapped]** Inner planes are now In1=+3V3 / In2=GND, so the USB
   D+/D− pair (mostly on B.Cu) now references **GND**. For a guaranteed clean, coupled pair,
   hand-route D+/D− on B.Cu in the KiCad GUI and **lock** them out of the autoroute; FS USB
   (12 Mbps) doesn't strictly require it.
4. **[Minor]** GPIO2 floating — add 10 kΩ pull-up (Espressif fn 2), optional.
5. **[Resolved — limiters unshared]** The shared 5.1 kΩ opto limiter let a ringing channel
   reverse-bias the idle opto's LED ~10.8 V (>6 V VR). **Fixed:** split into one resistor per
   opto (R_lim1 = R1, R_lim2 = R2), so each idle cathode stays near P1. R_em (1 kΩ emitter)
   stays shared — it carries only µA and is not part of the reverse path.
6. **[Minor/process]** Promised UART0/test pads not on the board (GPIO20/21 = NC, 0 TP
   footprints); `ROT_FIX={}` — verify polarized-part rotations at the Confirm-Placement gate;
   no mounting holes. (THT J1/J2 in the CPL/BOM is **intended** — JLCPCB assembles them via THT
   assembly, `HANDSOLDER` stays empty; nothing is hand-soldered.)
7. **[Nit]** 2 of U1's 9 EPAD thermal cells unstitched (benign, monolithic EPAD); one 0.388 mm
   bus↔logic clearance (<0.5 mm aspiration, fine for 12 V); U2 comment says "1A" but SGM2212 is ~800 mA.

---

## Design changes since review (2026-06-08)

- **U1: ESP32-C3-MINI-1 → ESP32-C3-WROOM-02-N4** (LCSC C2934560), to make the **whole BOM
  Economic-PCBA-eligible** at JLCPCB — the MINI-1 is Standard-PCBA-only (forces the $25/side setup),
  whereas the WROOM-02, the G6K relays and the THT connectors are all Economic-eligible. Same C3
  SoC, so the ESPHome config is unchanged. The WROOM-02 is larger (18×20 vs 13×17 mm), so every U1
  net was remapped to its pad layout and the upper-left was re-floorplanned (opto block centred in
  the UL quadrant, U1 nudged up to clear the decoupling caps, R10 moved right of C3, product-name
  silk moved into the strip left of the optos). Antenna overhang retuned to 5.9 mm; board grew to
  ~40.5 × 47.7 mm. ERC 0 / DRC 0/0 / check_pcb PASS, routes 0 unrouted.
- **Bell-sense GPIOs IO6/IO7 → IO10/IO3** so they land on U1's *north* castellated row facing the
  optos: OC2/OC3 now route ~7 mm straight up instead of ~25 mm around the module. `doorbell-v4.yaml`
  updated to match (House GPIO6→GPIO10, Apartment GPIO7→GPIO3).
- **Relay-driver GPIOs IO4/IO5 → IO20/IO10; bell-sense IO10/IO3 → IO3/IO1** — consolidates all
  four active GPIOs onto U1's north row. Gate traces shorten by ~25 mm. IO20/U0RXD (pad 11)
  drives K2; IO10 (pad 10) drives K3. IO20/U0RXD as gate driver is safe: high-Z input at reset,
  10 kΩ pull-down holds K2 off during boot. IO21/U0TXD left N/C (ROM drives HIGH at boot).
  `doorbell-v4.yaml` updated (K2 GPIO4→GPIO20, K3 GPIO5→GPIO10, OC2 GPIO10→GPIO3,
  OC3 GPIO3→GPIO1).
- **Re-verify for the WROOM-02:** review finding 7's "9 EPAD thermal cells" was MINI-1-specific —
  the WROOM-02 has its own EPAD (pad 19, multi-rect), stitched the same way (one benign
  plane-stitch warning). All other CLEAN/Resolved items above are unaffected by the swap.
- **K1 hardware interlock (2026-06-09):** K3's spare pole-B contacts (pins 6/7) placed in series
  with Q1's gate drive path (net GATE1_PRE: R_g1 out → K3 pin 7; net GATE1: K3 pin 6 → Q1 gate).
  K1 physically cannot energise unless K3 is already on — the P2↔P3 short hazard (via WF26 S2 strap
  line4↔3) is now prevented in hardware, not just firmware. R_g1 moved to (13.5, 34, 90°) to shorten
  the GATE1_PRE trace.
- **P4/IN_P4 documentation fix + K1 COM move (2026-06-09):** IN_P4 = TV20/S-incoming side
  (J2.6 → K3 NC; OC2 and K1 COM sit here); P4 = WF26-handset side (J2.4 → K3 COM). J2 pinout
  unchanged. OC2 was already correct (K3 NC retains TV20/S signal when K3 is energised). K1 COM
  moved from P4 (K3 COM/J2.4) to IN_P4 (K3 NC/J2.6) so PTT is visible to the TV20/S when K3 is on.
