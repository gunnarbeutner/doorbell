# Doorbell controller (Klingel V3) — design reference

Source of truth: `KlingelV4.fzz` (Fritzing schematic), `doorbell.yaml` (ESPHome),
`STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` (intercom system wiring diagram).
Netlist extracted by `scripts/extract_netlist.py` → `build/netlist.txt`.

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

## WF26 connector — 5-pin spring-cage pluggable terminal block

**Connector:** 5-way, 3.5mm pitch, spring-cage pluggable
(e.g. Wago 2604-1105 plug + matching PCB socket).
Bare stranded wire (26–28 AWG from flat Ethernet cable) inserts directly — no crimping.

### Pin functions (confirmed from TV20/S Verdrahtungsplan)

| Pin | TV20/S line | Signal | Role in our circuit |
|-----|-------------|--------|---------------------|
| P1 | Line 1 | Common reference | Both opto LED cathodes → R2 (5.1kΩ) → P1 |
| P2 | Line 2 | Audio (Sprechen/Hören) | Relay K1 **COM (MAIN1)** |
| P3 | Line 3 | Audio + ÖT door-opener trigger | Relay K1 **NO (NO1)** |
| P4 | Line 4 | Türruf — ~12VDC door bell signal | Relay K2 COM (MAIN2); the NC2 side (IN-P4) → OC1 anode (house bell sense) |
| P5 | Line 5 | Etagenruf — apartment call signal | → OC2 anode (apartment bell sense) |

**Relay K1** (P2 on COM/MAIN1, P3 on NO1) simulates pressing the ÖT button: energising
K1 closes COM1→NO1, **bridging P2+P3** → TV20/S activates the door opener. (The PDF's
own door-opener test confirms this: *"Klemmen 2 u. 3 brücken"*.) **Relay K2** (P4 on
COM/MAIN2, IN-P4 on NC2) breaks the Türruf line when energised to suppress the chime.

> **Invariant to keep:** `build/netlist.txt` must show `[WF26-P2] … U2.MAIN1` and
> `[WF26-P3] … U2.NO1`, with U2's NC1 unconnected (it must not appear in any net).

### Wire colour map (existing flat Ethernet cable, confirmed)

| Colour | WF26 pin |
|--------|----------|
| Orange | P1 |
| Green | P2 |
| Blue/white stripe | P3 |
| Blue | P4 |
| Black | P5 |

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

The apartment handset (Sprechstelle **WF26/G**, PCB silk "PCS-Sprechstelle / WF26") is a
passive unit — no MCU. Its hand-traced internal schematic shows:

- **Speaker/Mic** — a single **16 Ω** transducer used for both Türruf/Etagenruf tone
  output and half-duplex speech.
- **S2** — multi-pole **Sprechen/Hören (Lautsprechertaste)** changeover switch: routes
  the transducer between the tone path and the speech path (talk vs. listen).
- **S3** — the **Türöffner (ÖT)** / call buttons (momentary), bridging bus lines as above.
- **R1 ≈ 2.2 kΩ**, **C1 (50 V)** — RC network on the tone/speech path (values read from the
  image; confirm against the board if exact values matter).
- A **5-pin connector** = the bus tap our board plugs into (pins 1–5 ↔ WF26 P1–P5).

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

## Redesign (V4) — decisions made

| Decision | Choice | Reason |
|----------|--------|--------|
| MCU | **ESP32-C3-MINI-1** | Smaller, modern, ESPHome-supported, JLCPCB-stocked |
| Assembly | **JLCPCB SMT** (full fab assembly) | No soldering required |
| Relay | **SMD signal relay** (e.g. HFD4 or Omron G6K) | Contacts only carry ≤12VDC, milliamps; no need for SONGLE-class parts |
| WF26 connector | **5-pin spring-cage pluggable, 3.5mm pitch** | Locking, no-tool wire insertion for bare stranded Ethernet wire |
| Power | USB (to be confirmed) | Matches existing setup |
| Form factor | Single PCB, no daughter boards | Eliminates all inter-board jumpers |

### GPIO remapping for ESP32-C3 (to be finalised in schematic)
ESP32-C3 has different GPIO numbering. The same 4 signals are needed:
2× opto inputs (with internal pull-ups), 2× relay drive outputs.
Avoid: GPIO2 (strapping), GPIO8/9 (boot), GPIO11 (flash on some modules).
Safe choices include GPIO0, GPIO1, GPIO3, GPIO4, GPIO5, GPIO6, GPIO7, GPIO10.
