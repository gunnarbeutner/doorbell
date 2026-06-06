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

**Connector:** 6-way, 3.5 mm pitch **screw terminal**, THT (hand-soldered after SMT).
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
| P1 | Line 1 | Common reference (all bell/speech ref to line 1) | Both opto LED cathodes → R_lim (5.1 kΩ) → P1 |
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

| GPIO | ESPHome entity | Direction | Hardware |
|------|---------------|-----------|----------|
| 32 | `"Apartment Doorbell"` — binary sensor, pullup, inverted | Input | OC2 collector (senses P5 / Etagenruf) |
| 33 | `"House Doorbell"` — binary sensor, pullup, inverted | Input | OC1 collector (senses P4 / Türruf) |
| 26 | `front_door_buzzer_bin` — output, inverted | Output | Relay K1 (bridges P2+P3 = ÖT door opener) |
| 25 | `suppress_doorbell_sound_bin` — output, inverted | Output | Relay K2 (switches P4 = chime suppress) |

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
front-end (2× PC817, R2 = 5.1 kΩ shared cathode→P1 limiter, R1 = 1 kΩ shared emitter→GND)
and the relay contact arrangement (K1 COM=P2/NO=P3, K2 COM=P4/NC=IN-P4) are reproduced
**unchanged** — including how the Türruf AC tone is handled (it is debounced in firmware via
`delayed_on`/`delayed_off`, not rectified). The only genuinely new work is **integration**:
an ESP32-C3 MCU, USB-C power, and **discrete relay coil drivers** replacing the SONGLE
module — all on one JLCPCB-assembled PCB. No low-level "what works" is re-engineered.

### Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C3-MINI-1** | Modern, ESPHome-supported, JLCPCB-stocked, native USB |
| Connectivity | **Wi-Fi only** | No Ethernet; matches deployment |
| Assembly | **JLCPCB SMT** (full fab assembly) | No soldering required |
| Relay | **SMD signal relay, 5 V coil, gold/bifurcated contacts** (e.g. Omron G6K / HF) | Dry, ≤12 VDC, mA-level switching; gold contacts are *more* reliable than the V3 SONGLE's silver at these low "wetting" currents |
| Relay driver | **Discrete: logic-level NMOS + flyback diode + gate pull-down** | The SONGLE module did this for us; now on-board. Pull-down ⇒ relays default OFF at boot |
| WF26 connector | **6-way screw terminal, 3.5 mm** (THT, hand-soldered) | Bus wire ~26–28 AWG is below Wago push-in/lever min (0.2 mm²); screws clamp fine stranded reliably. 6-way because line 4 needs **in + out** for the series chime-break |
| Power | **USB-C** (5 V) → AMS1117-3.3 | USB-C connector + native-USB flashing/logging on the C3 |
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
| IO20 / IO21 | UART0 RX/TX | — | broken out to test pads (optional debug) |

Avoided: IO2 / IO8 / IO9 (strapping), IO11+ (internal flash). IO4–IO7 are all
non-strapping; relay outputs are deliberately on non-strapping pins.

### Relay driver subcircuit (per channel)

```
GPIO ──100Ω── gate │ NMOS (2N7002)        coil ── +5V
              gate ──10kΩ── GND            coil ── drain
                  source ── GND      flyback D (1N4148W): cathode→+5V, anode→drain
```
5 V coils run off the USB rail (keeps the 3V3 LDO unloaded). The 10 kΩ gate pull-down
holds each relay **off** while the GPIO floats during boot — so the door opener can't
pulse and the chime can't be silenced by a booting/dead board.

### Power tree

```
USB-C VBUS (5V) ──┬── 470µF bulk (WiFi current bursts) ──┬── relay coils (+5V)
                  │                                       └── AMS1117-3.3 ── +3V3 ── ESP32-C3
CC1/CC2 ── 5.1kΩ each to GND (sink Rd)        +3V3: 10µF + 100nF decoupling
USB D±  ── IO18/IO19 (native USB)             AMS1117: 10µF in / 22µF out
```

### Galvanic isolation (preserve in layout)

The **bus side** (P1–P5 and IN-P4) is galvanically separate from the **logic side**
(GND / +3V3 / +5V). The only crossings are *through* the optocouplers (input) and the
relay coil↔contact air gap (output). **P1 is the bus common, not board GND.** Keep a
clearance gap / slot between the two domains on the PCB. (Voltages are low — 12 VAC bus —
so this is about hum/ground-loops more than shock, but it's a property worth keeping.)

### BOM (draft — confirm JLCPCB/LCSC stock at order time)

| Ref | Part | Footprint |
|-----|------|-----------|
| U1 | ESP32-C3-MINI-1 | module |
| U2 | AMS1117-3.3 | SOT-223 |
| J1 | USB-C receptacle, USB 2.0 | SMD 16-pin |
| J2 | 6-way screw terminal, 3.5 mm (e.g. 4Ucon / generic KF128-3.5 6P) | THT — hand-solder |
| K1, K2 | Signal relay, 5 V coil, SPDT, gold contacts | SMD |
| Q1, Q2 | 2N7002 (logic-level NMOS) | SOT-23 |
| D1, D2 | 1N4148W (flyback) | SOD-123 |
| OC1, OC2 | PC817 / EL817S (SMD opto) | SOP-4 |
| R_lim | 5.1 kΩ (opto LED limiter, shared) | 0603 |
| R_em | 1 kΩ (opto emitter, shared) | 0603 |
| R_g1, R_g2 | 100 Ω (gate series) | 0603 |
| R_pd1, R_pd2 | 10 kΩ (gate pull-down) | 0603 |
| R_en, R_boot | 10 kΩ | 0603 |
| R_cc1, R_cc2 | 5.1 kΩ (USB-C CC) | 0603 |
| C_bulk | 470 µF | electrolytic/SMD |
| C_* | 22 µF, 10 µF×2, 100 nF×4 | 0603 |
| LED_pwr + R | power indicator (+3V3) | 0603 |

> J2 (the screw terminal) is THT → **hand-solder it** after SMT. Prefer LCSC *Basic* parts
> elsewhere; give K1/K2 a second source.

### PCB routing — J1 USB-C VBUS bridge

The `USB_C_Receptacle_HRO_TYPE-C-31-M-12` footprint is a single-row 16-pad part: each
position carries both the A- and B-row contact, so **VBUS lands on two pad-stacks at
opposite ends of the pin field** (A4/B9 high, A9/B4 low) with the CC/D± pads between them.
On this 2-layer board, with J1 flush to the left edge, there is no front-copper path across
that field — and, unlike GND (which the four shield thru-holes bridge front↔back for free),
VBUS has no thru-hole. So the autorouter connects one stack and strands the other (the
classic "1 unconnected pad, J1.B4").

**Fix (pre-placed in `kicad/gen_pcb.py` before routing):** drop one **off-pad** via in the
open copper just **east of each NPTH mounting peg** (pegs at x≈2.4 box the VBUS pads in on
the inboard side), route each VBUS pad out to its via on F.Cu, and **join the two vias on
B.Cu (layer 2)**. Freerouting then only has to reach this +5V island for the rest of the
rail. Trace/bridge width 0.2 mm, vias 0.5 mm; coordinates derive from the placed pads + pegs.

- **No via-in-pad** (design rule): vias are offset into clear copper, never on a pad.
- The **lower** stack (A9/B4) is pinched between its peg and the **CC2** lane just south of
  it. Its via is tucked down near the peg and the escape *threads* the gap (≥0.25 mm to the
  peg hole, ≥0.2 mm under CC2's lane) rather than cutting straight across — otherwise it
  blocks CC2 (J1.B5→R10). "Move the 5V closer to the NPTH, don't use a direct route."
- The **data pair** (D+ on A6/B6, D− on A7/B7) has the same interleaved-duplicate-pad
  problem, but Freerouting bridges it on its own as long as the VBUS bridge stays out of the
  central back-copper (hence the bridge hugs x≈3.0–3.25, east of the pegs).
- J1's reference silk is moved to the bottom of the connector (rotated 90° CW); the flush
  left edge would otherwise clip it.

Result: `./build.sh route` → **0 unconnected pads, 0 DRC violations.**

### Build / test notes

- **Antenna keep-out:** ESP32-C3-MINI-1 antenna at board edge; no copper/pour under it; no
  metal enclosure over it.
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
