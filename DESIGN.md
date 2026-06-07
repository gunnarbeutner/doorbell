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
| P2 | Line 2 | Speech (Sprechen/Hören); bridged to 3 = ÖT | Relay K1 **COM (MAIN1)** |
| P3 | Line 3 | Speech; bridged to 2 = ÖT door-opener trigger | Relay K1 **NO (NO1)** |
| P4 | Line 4 (TV20/S side) | Türruf — ~12 VDC house-door gong, **in** | Relay K2 **COM** |
| IN-P4 | Line 4 (WF26 side) | Türruf return, **out** to the handset | Relay K2 **NC** → OC1 anode (house-bell sense) **and** jumper → WF26 terminal 4 (gong). K2 opens this to suppress the chime |
| P5 | Line 5 | Etagenruf — floor/apartment call (tone) | → OC2 anode (apartment bell sense) |

**Relay K1** (P2 on COM/MAIN1, P3 on NO1) simulates pressing the ÖT button: energising
K1 closes COM1→NO1, **bridging P2+P3** → TV20/S activates the door opener. (The PDF's
own door-opener test confirms this: *"Klemmen 2 u. 3 brücken"*.) **Relay K2** (P4 on
COM/MAIN2, IN-P4 on NC2) breaks the Türruf line when energised to suppress the chime.

**Why line 4 needs two pins.** K1 (door opener) *adds* a contact across P2+P3 — a parallel
closure, fine from a parallel bus tap. K2 (chime suppress) must *break* the Türruf so it
stops reaching the WF26 gong — a **series** operation, so line 4 is split at the board:
**P4** = bus/TV20-S side (→ K2 COM), **IN-P4** = WF26-handset side (→ K2 NC, OC1 sense, and
J2.6 jumper back to WF26 terminal 4). At rest K2 passes P4→IN-P4 (gong rings, OC1 senses);
energised it opens the line (gong silenced) — this is the proven V3 topology. V4 originally
collapsed IN-P4 to an internal-only node (no jumper back to the WF26), silently breaking
chime suppression; restored here on the 6-way J2 (pad 6).

> **Invariant to keep:** `build/netlist.txt` must show `[WF26-P2] … U2.MAIN1` and
> `[WF26-P3] … U2.NO1`, with U2's NC1 unconnected (it must not appear in any net).

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | J2 pin |
|--------|----------|
| Orange | P1 |
| Green | P2 |
| Blue/white stripe | P3 |
| Blue | P4 (line 4, **in**) |
| Black | P5 |
| — (short jumper) | IN-P4 (J2.6) → back into WF26 terminal 4 |

> To wire the series break: move the **blue** (line-4) wire off WF26 terminal 4 onto **J2.P4**,
> and run a short jumper from **J2.IN-P4 (pad 6)** back to WF26 terminal 4. P1/P2/P3/P5 stay
> parallel taps on WF26 terminals 1/2/3/5.

---

## GPIO map (ESPHome ↔ hardware)

> ⚠️ **V3 (ESP32 dev board) mapping — kept for reference only.** These pins (25/26/32/33)
> **do not exist on the ESP32‑C3** and must NOT be used for V4. `doorbell.yaml` still carries
> these stale pins and `board: esp32dev`; remap it to the C3 pins below before flashing the V4
> board. See "ESP32‑C3 GPIO map (final)" for the authoritative V4 assignment.

| GPIO (V3) | ESPHome entity | Direction | Hardware | → V4 C3 pin |
|------|---------------|-----------|----------|----|
| 32 | `"Apartment Doorbell"` — binary sensor, pullup, inverted | Input | OC2 collector (senses P5 / Etagenruf) | **IO7** |
| 33 | `"House Doorbell"` — binary sensor, pullup, inverted | Input | OC1 collector (senses P4 / Türruf) | **IO6** |
| 26 | `front_door_buzzer_bin` — output, inverted | Output | Relay K1 (bridges P2+P3 = ÖT door opener) | **IO4** |
| 25 | `suppress_doorbell_sound_bin` — output, inverted | Output | Relay K2 (switches P4 = chime suppress) | **IO5** |

---

## Circuit description

### Bell sense (inputs)
Each bell line drives a PC817 LED **referenced to the bus common P1** (the ~12 VDC bell
voltage sits across line 4↔1 / 5↔1, per the PDF), and the phototransistor pulls the
GPIO low. R2 and R1 are **shared** between both optos.
```
P4-IN ──► OC1 LED anode ;  P5 ──► OC2 LED anode
OC1/OC2 LED cathodes ──┬── R2 (5.1kΩ, shared) ──► P1 (bus common)   [LED loop is bell↔P1]
OC1 collector ──► GPIO33 ;  OC2 collector ──► GPIO32   (ESP32 internal pull-up to 3V3)
OC1/OC2 emitters ──┬── R1 (1kΩ, shared) ──► GND
Bell present → LED conducts → phototransistor pulls GPIO low → ESPHome inverted:true ⇒ "on"
```
> R2 (5.1 kΩ) is the **LED series limiter on the cathode→P1 return**; R1 (1 kΩ) is the
> **phototransistor emitter resistor to GND** — the LED itself never connects to GND.
> Verified against `build/netlist.txt` (nets `WF26-IN-P4`/`WF26-P5`, `N9`, `N10`/`N11`, `N12`).

### Relay outputs
```
K1 (GPIO26, front door buzzer):  COM(MAIN1)→P2, NO→P3  — energise to bridge P2+P3 (ÖT)
K2 (GPIO25, chime suppress):     COM(MAIN2)→P4, NC→IN-P4 — energise to break Türruf line
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
- K1 (door opener) bridges lines 2+3 for 1750ms. The TV20/S interprets this short as an ÖT button press, not audio — momentary conversation disruption is unavoidable but acceptable.
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
  appears at 8/9. This is exactly what relay **K1** does (COM1=P2, NO1=P3).
- **ET (Etagenruftaster):** floor-call button on the WF26; **ÖT** is the *additional*
  door-opener button. Both are momentary contacts across the 5-wire bus.
- **Speech:** only enabled *after* a bell; lines 1/2/3 carry audio (also 6/7 internally),
  ~25 s talk window, auto-off after ~60 s — consistent with the Audio section above.

## WF26 internal circuit (from teardown photos / `m53n9gtxg41f1.png`)

The apartment handset (Sprechstelle **WF26/G**, PCB silk "…WF26") has **no MCU**, but it is
**not purely passive**: the teardown photo (`IMG_5082.jpg`) shows an **internal signal relay
(Siemens V23100-…)** plus an RC network and the two switches. We deliberately do **not**
reverse-engineer it further — the existing V3 board works against the real TV20/S, so V4
reproduces its proven sense / ÖT-bridge / line-4 series-break topology rather than modelling
the handset. The hand-traced internal schematic shows:

- **Speaker/Mic** — a single **16 Ω** transducer used for both Türruf/Etagenruf tone
  output and half-duplex speech.
- **Relay (Siemens V23100-…)** — internal; switched function **not traced** (see note above).
- **S2** — multi-pole **Sprechen/Hören (Lautsprechertaste)** changeover switch: routes
  the transducer between the tone path and the speech path (talk vs. listen).
- **S3** — the **Türöffner (ÖT)** / call buttons (momentary), bridging bus lines as above.
- **R1 ≈ 2.2 kΩ**, **C1 (50 V)** — RC network on the tone/speech path (values read from the
  image; confirm against the board if exact values matter).
- A **5-pin terminal block** = the bus interface (terminals 1–5 ↔ lines/P1–P5). Our board's
  6-way J2 taps P1–P5 here and jumpers IN-P4 back onto terminal 4.

> Takeaway: nothing in the WF26 is "smart" — our board simply emulates its button presses
> (ÖT = bridge 2+3) and senses the tone-drive lines (4, 5). No firmware handshake exists.

> Note on labels: **K1/K2 are the relays' own designators** on the 2-channel module
> (channel 1 / channel 2), driven by GPIO26 / GPIO25 respectively.

---

## Current build (V3, on perfboard — for reference)

| Ref | Part | Role |
|-----|------|------|
| U1 | LuaNode32 / ESP32 DevKit (ESP-WROOM-32, 30-pin), socketed | MCU |
| U2 | 2-ch relay module (SONGLE SRD-05VDC-SL-C), separate board | K1 + K2 |
| OC1 | PC817 optocoupler | House bell sense |
| OC2 | PC817 optocoupler | Apartment bell sense |
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
and the relay contact arrangement (K1 COM=P2/NO=P3, K2 COM=P4/NC=IN-P4) are reproduced
**unchanged** — with one deliberate fix: the V3 *single shared* LED limiter is split into one
5.1 kΩ resistor per opto (**R_lim1, R_lim2**) so a ringing channel can't reverse-bias the idle
opto's LED past its 6 V VR (review finding 5). The Türruf AC tone is still debounced in firmware (via
`delayed_on`/`delayed_off`, not rectified). The only genuinely new work is **integration**:
an ESP32-C3 MCU, USB-C power, and **discrete relay coil drivers** replacing the SONGLE
module — all on one JLCPCB-assembled PCB. No low-level "what works" is re-engineered.

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C3-MINI-1** | Modern, ESPHome-supported, JLCPCB-stocked, native USB |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **Full JLCPCB assembly** (SMT + THT) | SMT parts reflowed; J1/J2 (USB-C, WF26 terminal) are through-hole but **also assembled by JLCPCB** (THT assembly) — nothing hand-soldered |
| Relay | **SMD signal relay, 4.5 V coil, gold/bifurcated contacts** (Omron G6K-2F-Y-TR DC4.5, LCSC C397193) | Dry, ≤12 VDC, mA-level switching; gold contacts are *more* reliable than the V3 SONGLE's silver at these low "wetting" currents. **4.5 V** (not 5 V) coil so the post-Schottky ~4.5 V rail clears the 3.6 V must-operate with margin (see review finding 2) |
| Relay driver | **Discrete: logic-level NMOS + flyback diode + gate pull-down** | The SONGLE module did this for us; now on-board. Pull-down ⇒ relays default OFF at boot |
| WF26 connector | **6-way screw terminal, 3.5 mm** (THT, JLCPCB-assembled) | Bus wire ~26–28 AWG is below Wago push-in/lever min (0.2 mm²); screws clamp fine stranded reliably. 6-way because line 4 needs **in + out** for the series chime-break |
| USB-C connector | **GCT USB4085** (2-row THT) | The cheap single-row SMD Type-C (HRO) carries interleaved/duplicated D+/D−/CC/VBUS pads that fight routing; USB4085's two TH rows escape cleanly. LCSC C7095263 |
| Layers | **4-layer** (F.Cu / GND / +3V3 / B.Cu) | Solid GND + power planes; lets the USB D+/D− pair route together and keeps signals off the planes |
| Power | **USB-C** (5 V) → **SGM2212-3.3** (low-dropout LDO, LCSC C3294699) via a series SS14 VBUS reverse-protection Schottky | native-USB flashing/logging on the C3; +5V & +3V3 distributed on the planes. Low-dropout part chosen so the ~0.45 V Schottky drop still leaves ~1 V headroom (an AMS1117's 1.3 V dropout would have browned out under WiFi TX) |
| Form factor | **Single PCB**, no daughter boards | Eliminates all inter-board jumpers (the V3 failure mode) |
| Audio | **Out of scope** (evaluated, deferred — see below) | Needs S3+PSRAM + custom analog bridging; not worth the risk to the proven core |

### ESP32-C3 GPIO map (final)

| GPIO | Signal | Dir | Notes |
|------|--------|-----|-------|
| IO4 | K1 relay driver — front door buzzer / ÖT (bridge P2+P3) | out | gate pull-down ⇒ off at boot |
| IO5 | K2 relay driver — chime suppress (break P4) | out | gate pull-down ⇒ off at boot ⇒ chime passes |
| IO6 | OC1 collector — house bell sense (Türruf, P4) | in | internal pull-up (firmware) |
| IO7 | OC2 collector — apartment bell sense (Etagenruf, P5) | in | internal pull-up (firmware) |
| IO18 / IO19 | USB D− / D+ | — | native USB-Serial-JTAG: flashing + logs |
| IO9 | BOOT strap | — | 10 kΩ pull-up + button to GND |
| EN | Reset | — | 10 kΩ pull-up + 100 nF to GND (+ optional button) |
| IO20 / IO21 | UART0 RX/TX | — | currently **No-Connect** (DESIGN intent was test pads — not yet on the board; native USB-Serial-JTAG is the primary log path) |

Avoided: IO2 / IO8 / IO9 (strapping), IO11+ (internal flash). IO4–IO7 are all
non-strapping; relay outputs are deliberately on non-strapping pins. IO8 carries a 10 kΩ
pull-up (R10, download-mode robustness); **IO2 is left floating** — Espressif's datasheet
(Table 3-3 fn 2) recommends a 10 kΩ pull-up there to harden boot against glitches (optional).

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

The **bus side** (P1–P5 and IN-P4) is galvanically separate from the **logic side**
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
| U1 | ESP32-C3-MINI-1 | module |
| U2 | AMS1117-3.3 | SOT-223 |
| J1 | **GCT USB4085** USB-C 2.0 (LCSC C7095263) | THT, 2-row — JLCPCB-assembled |
| J2 | 6-way screw terminal, 3.5 mm (e.g. 4Ucon / generic KF128-3.5 6P) | THT — JLCPCB-assembled |
| K1, K2 | Signal relay, **4.5 V coil**, SPDT, gold contacts (G6K-2F-Y-TR DC4.5, C397193) | SMD |
| Q1, Q2 | 2N7002 (logic-level NMOS) | SOT-23 |
| D1, D2 | 1N4148W (flyback) | SOD-123 |
| OC1, OC2 | PC817 / EL817S (SMD opto) | SOP-4 |
| R_lim1, R_lim2 | 5.1 kΩ (opto LED limiter, one per opto) | 0603 |
| R_em | 1 kΩ (opto emitter, shared) | 0603 |
| R_g1, R_g2 | 100 Ω (gate series) | 0603 |
| R_pd1, R_pd2 | 10 kΩ (gate pull-down) | 0603 |
| R_en, R_boot | 10 kΩ | 0603 |
| R_cc1, R_cc2 | 5.1 kΩ (USB-C CC) | 0603 |
| C_* | 10 µF×3 (C_in, C_out, C_3v3), 100 nF×2 (C_en, C_dec) | 0603 |
| LED_pwr + R | power indicator (+3V3) | 0603 |

> J1/J2 are through-hole but **assembled by JLCPCB** (THT assembly), not hand-soldered. Prefer LCSC *Basic* parts
> elsewhere; give K1/K2 a second source.

### PCB — stackup, floorplan & routing

**4-layer stack:** `F.Cu` (signals + parts) / `In1.Cu` = solid **GND** plane / `In2.Cu` = solid
**+3V3** plane / `B.Cu` (signals). +5V is a short surface trace. Set in `gen_pcb.py`
(`SetCopperLayerCount(4)`); fab gerbers include the inner layers.

**Why 4-layer + the USB4085 connector.** The original single-row Type-C
(`HRO TYPE-C-31-M-12`) carries D+/D−/CC/VBUS on *interleaved, duplicated* pads in one row — a
routing nightmare (it needed a hand-placed VBUS bridge, and the autorouter split the D+/D− pair
around obstacles). Switching J1 to the **GCT USB4085** — a 2-row *through-hole* Type-C (LCSC
C7095263) — gives clean escapes, and going 4-layer lets the **D+/D− pair route together** on
B.Cu over the GND plane.

**Keeping the planes solid (the codegen recipe).** Freerouting (driven from KiCad's DSN) does
not natively reserve power planes, so:
- `In1`/`In2` are marked **`LT_POWER`** → the autorouter keeps all *signals* on F.Cu/B.Cu.
- It then won't via to the planes, so `gen_pcb.py` **pre-stitches** every surface (SMD) GND/+3V3
  pad to its plane with an offset via + short F.Cu stub (≈27 vias; **no via-in-pad**). THT
  power/GND pads already pass through the planes and are skipped.
- The planes are **filled in `route.py` *before* the DSN export** — not in `gen_pcb.py`, where
  `ZONE_FILLER` on a freshly-built board segfaults pcbnew — so the stitch vias tie together and
  GND/+3V3 are complete before routing.

Result: signals only on F.Cu/B.Cu, In1/In2 clean solid planes, **D+/D− routed together** on
B.Cu → **0 unconnected, 0 DRC**.

**Floorplan** (`PCB_PLACE` in `gen_pcb.py`): logic/power in the **lower-left** — the ESP32-C3
(U1, rot 90°, antenna overhanging the left edge), its LDO (U2) in the U1↔J1 gap, with the
boot/reset buttons, power LED, decoupling and LDO caps clustered around it; **USB-C (J1) centred
on the bottom edge**, mouth overhanging downward, CC pulldowns flanking it; **bus interface on
the right** (WF26 6-way terminal on the top edge, optos, bell-sense R, relays + drivers).

**Edge overhang** (`EDGE_OVERHANG` in `doorbell_design.py`): J1 overhangs the bottom edge by
3.1 mm (the connector shell clears the PCB) and U1 overhangs the left edge by 5.4 mm so its
**antenna sits off-board** — which is why the old copper antenna keep-out is gone (nothing on
the board to keep clear). `check_pcb.py` verifies each overhang and that the rest of every
footprint stays inside the outline.

**DRC** limits live in `kicad/doorbell.kicad_dru`, grounded in JLCPCB's published 2-layer
capabilities (e.g. 0.127 mm spacing inside J1's fine-pitch courtyard, 0.3 mm board-edge copper).

### Build / test notes

- **Antenna:** the ESP32-C3-MINI-1 antenna **overhangs the left board edge** (off-board), so no
  on-board copper/keep-out is needed under it — just keep no metal enclosure over it.
- **Programming/bring-up:** flash + view logs over the USB-C (native USB-Serial-JTAG); add
  BOOT + EN buttons (or pads) for recovery.
- **Test points:** P1–P5, +5 V, +3V3, the 4 GPIOs, UART0 — for bench validation against the
  real TV20/S (door pulse + chime suppress) before it goes in the wall.

### Audio — evaluated and deferred (2026-06-06)

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

---

## Design review findings (2026-06-07)

Full adversarial review (datasheet-verified pinouts + routed-board parse). **No Critical/Major
defect in the PCB.** Automated: ERC 0 err, DRC 0/0, `check_pcb` PASS. Open items:

**Verified CLEAN (datasheet/board-confirmed):** relay contact mapping (G6K-2F-Y coil 1/8,
COM3/NC2/NO4 — K1 bridges P2+P3, K2 breaks P4); SGM2212 SOT-223 pinout + ~1 V headroom;
diode polarity (D4 reverse-protect, D1/D2 flyback, pad1=cathode); USB front-end (D+/D− not
swapped, SRV05-4 low-cap, CC 5.1 kΩ Rd, no UART bridge, internal D+ pull-up); 3V3 decoupling
adequacy (470 µF unnecessary); 2N7002 gate drive @3.3 V; bell-sense logic levels
(GPIO LOW ≈0.12–0.27 V); all U1 pads on-board despite the overhang; antenna keep-out; plane
connectivity; galvanic isolation (bus↔logic only via optos/relay gaps).

**To address:**
1. **[Major — firmware]** `doorbell.yaml` still uses `board: esp32dev` and pins 25/26/32/33
   (nonexistent on C3). Remap to the C3 GPIO map above (32→IO7, 33→IO6, 26→IO4, 25→IO5),
   `board: esp32-c3-devkitm-1`, before flashing.
2. **[Resolved — switched to DC4.5 coil]** With the 5 V coil, must-operate (80% = 4.0 V) sat
   just under the post-Schottky ~4.5 V rail (coil ~4.31 V, 86%) — thin, and negative under VBUS
   sag. **Fixed:** K1/K2 are now the **G6K-2F-Y-TR DC4.5** (LCSC C397193, must-operate 3.6 V), so
   the same ~4.5 V rail clears pickup by ~0.7–0.9 V, with ~1.9 V headroom below the 6.75 V (150%)
   max coil voltage. Same footprint/pinout. Bench-confirm coil V under WiFi TX + long cable if paranoid.
3. **[Minor]** USB D+/D− run ~85% on B.Cu, which references the **+3V3** plane (In2), not GND;
   reference flips at the vias. Fine for FS USB; to fix, route on F.Cu or swap inner planes
   (GND→In2) so B.Cu sees GND.
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
