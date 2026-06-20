# Schematic Verification Report — Klingel V4

Independent **blind** pre-fabrication review of the **current** `kicad/doorbell.kicad_sch`.

## Method / scope

The review was performed blind: the board's intent was reconstructed **only** from (a) the netlist
exported from the schematic (`kicad-cli sch export netlist`), (b) the manufacturer datasheets,
(c) the reverse-engineered handset `wf26/wf26.kicad_sch` (+ `wf26/wf26-schematic.md`), and
(d) the STR TV20/S service plan (`docs/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`) — **without**
consulting `DESIGN.md`, `REQUIREMENTS.md`, `TODO.md`, `ORDERING.md` or `kicad/doorbell_design.py`.
Every active and polarity-sensitive part was checked against its datasheet for three failure classes:
**polarity, pin-mapping, pin-usability**. Pinouts were confirmed from datasheet images where the text
was image-only (ESP32-C6-MINI-1U, ES8311, SGM2212, TPD2S017, G6K-2F-Y, GAQY212GS/412EH, PC817-family
for the optos).

Notes in **[brackets]** reconcile a blind finding with the as-built design decision after the fact —
they are *not* part of the blind pass. The independent pass converged with `DESIGN.md` on every
system-level conclusion (including, this time, the **correct** WF26 seal-in model — see below).

## Verdict

- **Polarity errors: 0** — all diode, electrolytic, SSR-LED, opto-LED and relay-coil orientations check out.
- **Pin-mapping errors: 0** — MCU, codec, LDO, USB-ESD, USB-C, the three SSRs and the latch relay.
- **Pin-usability errors: 0** — strapping pins held to valid states; no input-only/flash pins misused.
- **ERC: 0 errors, 17 warnings** — all benign (pin-type "unspecified vs passive/power" on the screw
  terminals / buttons / LDO; one informational `GND`/`P1` same-net note; three cosmetic
  `lib_symbol_mismatch` on K1/K2/K3).
- **~70 placed components**; schematic and PCB connectivity agree.
- No blocking error found. Four decision-worthy items and a few minor notes are listed at the end.

## WF26 handset model (independent derivation from `wf26.kicad_sch`)

Seven passive parts on a 5-wire bus P1–P5, no semiconductors:

- **Relay (HJR-4102, 1 Form C SPDT):** coil pin 8 → **P1**, pin 5 → **P4**; contact common → K1_COM;
  **NO (pin 6) → P4**, NC unconnected. The coil is driven by the **P4–P1** voltage and its NO contact
  feeds the common **back to P4** — a self-feeding **seal-in** steered by S1. *(This matches the
  on-board G6K replica; it is also the corrected model — the coil is across P4↔P1, not the speech pair.)*
- **C1 (22 µF):** across **P5↔P4**, AC-coupling the door gong onto the speaker.
- **LS1 (16 Ω):** across **P1↔P5** (doubles as the talk microphone).
- **S1 (door release):** common P2; **pressed = direct P2↔P3 short** (the ÖT trigger), released parks
  P2 on K1_COM.
- **S2 (talk):** common R1_BRIDGE; **pressed = R1_BRIDGE↔P3**, putting **R1 (2.2 kΩ) between P4 and P3**.

Cross-checked against the TV20/S plan: terminal 4 (Türruf) carries **~12 VDC standby (Klemmen 4 & 1)**;
the door opener (ÖT) bridges **terminals 2 & 3**; the Etagenruf (ET) series-interrupts **line 5**; the
door ring is a 3-chime gong, the floor call a continuous tone.

## Verified correct (by subsystem)

### Switches / SSRs / on-board latch relay

- **GAQY212GS (K1, K2)** — confirmed from the datasheet: SOP-4, **1 Form A (NO)**, pin 1 = LED anode,
  pin 2 = LED cathode, pins 3/4 = MOSFET contact. Footprint pads match.
  - **K2** contact bridges **P2↔P3** → the **door opener**, exactly the TV20/S "Klemmen 2 u. 3" trigger
    and the handset S1 direct short. ✓
  - **K1** contact bridges **TALK_BRIDGE↔P4** (talk handshake); LED anode ← R4 (300 Ω) ← GPIO20. ✓
- **GAQY412EH (K3)** — confirmed **1 Form B (NC)**: pin 1 = anode, pin 2 = cathode, pins 3/4 = contact.
  NC contact sits **P4↔CHIME_C1**, in series with the 22 µF gong cap. De-energised = gong passes;
  energised = opens the C1 path and **mutes the gong without breaking line 4** (P4 stays on the bus via
  the relay / OC1 / D1). ✓
- **SSR LED drive:** R4/R5/R6 = 300 Ω from +3V3 → IF ≈ (3.3 − 1.2)/300 ≈ **7 mA**, inside the GAQY
  window (IF 5–30 mA). R7/R8/R9 (10 kΩ) gate pull-downs hold the SSRs off while the GPIOs float at boot. ✓
- **On-board G6K-2F-Y (WF26_K1)** — internal-connection diagram read directly: coil = pins 1(+) & 8(−);
  one pole COM = pin 3, NC = pin 2, NO = pin 4. Board: coil **pin 1 → P4 / pin 8 → GND (P1)** (+ on the
  +12 VDC P4 side ✓), COM → WF26_K1_COM, NO → P4, NC open, second pole unused. **Faithfully replicates
  the handset HJR-4102 seal-in.** ✓

### Diodes / polarity (library convention pin 1 = K, pin 2 = A; verified per symbol)

| Ref | Part | K (pin 1) | A (pin 2) | Role | Verdict |
|-----|------|-----------|-----------|------|---------|
| D1 | 1N4148W | P4 | GND | flyback across the WF26_K1 coil (P4+ / GND−) | ✓ reverse-biased in normal op |
| D8 | 1N4148W | P4 | OC1_CATH | anti-parallel across the OC1 LED | ✓ clamps reverse to ~0.7 V |
| D9 | 1N4148W | P5 | OC2_CATH | anti-parallel across the OC2 LED | ✓ |
| D4 | SS14 | +5V | VBUS_F | series reverse-polarity protect | ✓ ~0.45 V drop |
| D10 | SMF5.0A | VBUS_F | GND | unidirectional VBUS TVS (5.0 V stand-off) | ✓ |
| D6 | LED | GND | LED_A (← R15 ← +3V3) | power indicator (~1.5 mA) | ✓ |

### USB-C + ESD (J1 / D5 / D4 / D10 / F1)

- **J1 (USB4105, 16P):** VBUS on A4/A9/B4/B9; GND on A1/A12/B1/B12/SH; **CC1 = A5 → R13 5.1 kΩ → GND,
  CC2 = B5 → R14 5.1 kΩ → GND** (correct **Rd** sink/UFP advertisement, both cable orientations);
  D+ on A6/B6, D− on A7/B7 (both rows tied); SBU unused. ✓
- **D5 TPD2S017 (SOT-23-6)** — confirmed: pin 1 Ch1_Out → USB_ESP_DN, pin 3 Ch1_In → USB_DN; pin 6
  Ch2_Out → USB_ESP_DP, pin 4 Ch2_In → USB_DP; pin 5 VCC → VBUS_F; pin 2 GND. **Flow-through orientation
  correct** (connector on the _In side, ESP on _Out); VCC ≤ 5.5 V satisfied; series R ~1 Ω, transparent to USB FS. ✓
- **No D+/D− swap** anywhere (connector → TPD2S017 → GPIO13/GPIO12 = D+/D−). ✓
- **F1 (1 A fast)** is upstream of the TVS and LDO — a clamping D10 blows the fuse (fail-safe). ✓

### Power (U2 SGM2212-3.3, SOT-223-3) — confirmed from datasheet

pin 1 GND → GND, pins 2 & 4 (VOUT + tab) → +3V3, pin 3 VIN → +5V. Fixed 3.3 V. CIN 10 µF / COUT 10 µF
within the stable range. Input ~4.65 V (5 V − SS14) leaves ample dropout headroom for the C6 Wi-Fi-TX peak. ✓

### MCU (U1 ESP32-C6-MINI-1U) — full pad map confirmed against the datasheet

- Power / USB / I²S / I²C / GATE / sense pads all map to the correct module pads; GPIO12 (pad 17) = USB_D−,
  GPIO13 (pad 18) = USB_D+ → native USB-Serial-JTAG. ✓
- **Strapping:** GPIO8 (pad 22) ↑ R12 3.3 kΩ = **1 → SPI boot** ✓; GPIO9 (pad 23, BOOT) ↑ R11 10 kΩ +
  SW1 → GND = default 1, button = download boot ✓; EN ↑ R10 10 kΩ + C5 1 µF + SW2 ✓; GPIO15 (pad 20,
  the JTAG-source strap) used as I²C_SCL with the R19 pull-up — held high at reset, the wanted state ✓;
  MTMS/MTDI (pads 9/10) left NC ✓.
- **No flash-pin conflict** — the C6-MINI flash is internal; none of the exposed GPIOs touch it. No
  input-only pins exist on the C6. ✓

### Codec + audio coupling (U3 ES8311, WQFN-20) — full pinout confirmed against the datasheet

All 20 pins + EP map correctly (CCLK/MCLK/SCLK/LRCK/ASDOUT/DSDIN; PVDD/DVDD/AVDD → +3V3; all GNDs;
OUTP/OUTN; the three VREF/VMID reservoir caps; MIC1P/MIC1N; CDATA; **CE → R20 10 kΩ → GND = I²C 0x18**).
I²S direction correct (ASDOUT → ESP DIN; DSDIN ← ESP DOUT). **Transformer-less** — there is no isolation
transformer in the path (see Finding 1).

- **TX:** OUTP → C14 (1 µF) → **TALK_BRIDGE** → **R28 (2.2 kΩ) → P3**; OUTN → C15 → R16 (2.2 kΩ) → GND
  (single-ended drive, AC-terminated). **R28's 2.2 kΩ onto P3 reproduces the handset's R1 talk strap
  exactly**, so codec TX reaches the door by the same path the WF26 used; **K1** closed adds the
  TALK_BRIDGE↔P4 handshake. ✓
- **RX:** **P2 (listen leg)** → C16 (1 µF) → MIC1P; MIC1N → C17 (1 µF) → GND. Listens on P2-vs-common,
  matching the TV20/S listen leg. ✓

### Bell sense (OC1 / OC2 + clamps + pull-ups)

- **OC1** anode → **P4** → senses **Türruf (P4↔P1)**; cathode → R1 5.1 kΩ → GND (≈ 2 mA at 12 V);
  emitter → R3 1 kΩ → GND; collector → **R22 10 kΩ → +3V3** + GPIO3. ✓
- **OC2** anode → **P5** → senses **Etagenruf (P5↔P1)**; R2 5.1 kΩ, **R23 10 kΩ → +3V3** + GPIO2. ✓
  *[The opto collectors are held high by the external pull-ups R22/R23 — the firmware uses `mode: input`
  (no internal pull-up needed).]*
- Both confirmed against the TV20/S plan (Türruf = line 4, Etagenruf = line 5, common = line 1).
  Anti-parallel D8/D9 clamp the reverse LED voltage. ✓

### On-board passive WF26 core

WF26_R1 (2.2 kΩ), WF26_C1 (22 µF/50 V), WF26_S1/S2 (SPPJ322300 DPDT), LS1 (16 Ω) and WF26_K1 reproduce
the handset's door-release / talk / gong / seal-in topology, so the board behaves like a plain WF26 when
unpowered (the SSRs/codec/optos are additive on top).

## Findings (decide before ordering)

1. **No bus↔logic isolation — P1 is hard-bonded to board GND** (ERC: "GND and P1 attached to the same
   items"). The whole TV20/S 5-wire bus shares the board's ground, which is also the USB-C shield/GND and
   the host-PC ground during programming; there is **no transformer or opto barrier in the audio or sense
   path** (the sense optos isolate only their own LEDs; the listen/talk lines P2/P3 connect galvanically
   through C16/C14/R28 to the codec and GND). Confirm the TV20/S common is safe to bond to USB/PC ground
   and that no part of the bus floats at a mains-referenced potential.
   *[As-built: this is a **deliberate, documented** transformer-less choice (SAFE-3 isolation knowingly
   not met; P1 measured ~0.5 V from earth). Containment rests on per-tap protection + the F1 sacrificial
   fuse. The blind pass also flagged four cap **`Description` fields still reading "T1 secondary"** — a
   transformer that is not in the netlist; **corrected** to the transformer-less wording.]*

2. **WF26_C1 electrolytic orientation differs from the handset readout — and the board is the correct
   one.** The handset readout marks C1 "+" toward P5; the board places WF26_C1 "+" toward the P4 side
   (CHIME_C1, via K3). The TV20/S note proves **P4 = +12 VDC standby**, so "+ toward P4" is the
   electrically-correct polarity. Verify P4 is the +12 V line on the install and that the gong drive
   never swings C1 net-negative; if confirmed, ship as drawn. *[Matches the intended polarity.]*

3. **LTV-217 opto pinout confirmed only by PC817-family convention, not its own datasheet.** The
   gated LTV-217 sheet could not be retrieved; the **PC817-family convention (pin 1 = A, 2 = K,
   3 = Emitter, 4 = Collector)** was confirmed instead, and the board wires exactly that (pin 3 → R3 →
   GND emitter, pin 4 → pull-up/GPIO collector). LTV-217 is a pin-compatible PC817-family part, so this
   is almost certainly correct — but **confirm against the actual Lite-On LTV-2X7 datasheet before fab**;
   an emitter/collector swap would break OC1/OC2. *[The same opto family ran in V3 and sensed reliably.]*

4. **TX is single-ended off OUTP only.** OUTN is merely AC-terminated to GND (C15 + R16); the ES8311's
   differential negative half is discarded (~half the swing, no common-mode rejection). Functionally
   fine; it is the lever if the line-3 drive level proves marginal. Analog values (R28/R16 = 2.2 kΩ,
   the 1 µF couplers) are concrete, not placeholders. *[Whether the TV20/S forwards line-3 audio to the
   door once it sees the R28 handshake is the open **TX-out reach** bench question.]*

## Minor notes

- **ERC `lib_symbol_mismatch` on K1/K2/K3** — the placed GAQY symbols differ from the cached library
  copy. Cosmetic, but re-sync the symbols and re-run ERC before fab so the schematic pin numbering
  provably equals the footprint.
- **OC1 and OC2 share one emitter resistor R3 (1 kΩ)** on the common OC_EMIT node — independent
  collector sensing still works; a simultaneous Türruf + Etagenruf slightly lifts the shared emitter.
  Negligible.
- **SSR load ratings** (GAQY212GS 1.0 A / GAQY412EH 0.6 A, 60 V) far exceed the mA-class bus signals.
  The 8–12 VAC / 1 A door strike is **not** switched by any SSR — K2 only bridges the signal pair P2↔P3
  to trigger the TV20/S's own opener; the strike current stays inside the central unit. The netlist
  supports this.
- **GPIO0/GPIO1 (I²S DOUT/WS)** are general-purpose on the C6 (not boot straps) — no conflict.
- ESP32-C6 sourcing ~7 mA × 3 SSR LEDs is well within the 40 mA/pin limit.

## Datasheet sources consulted

- ESP32-C6-MINI-1/1U — `docs/esp32-c6-mini-1_mini-1u_datasheet_en.pdf` (pad map + strapping tables).
- ES8311 mono codec — `docs/ES8311_datasheet.pdf` (pinout) + `docs/ES8311.user.Guide.pdf`.
- SG Micro SGM2212 LDO — `docs/sgm2212_datasheet.pdf` (SOT-223-3 pin config).
- TI TPD2S017 USB ESD — `docs/tpd2s017_datasheet.pdf` (SOT-23-6 pinout).
- Omron G6K relay — `docs/g6k_datasheet.pdf` (G6K-2F-Y internal-connection diagram).
- Panasonic GAQY412E/EH PhotoMOS — `docs/GAQY412E_EH_datasheet.pdf` ("1 Form B"; pin 1 = A / 2 = K / 3,4 = contact).
- GAQY212GS PhotoMOS ("1 Form A") — <https://uploadcdn.oneyac.com/attachments/files/brand_pdf/supsic/E9/36/GAQY212GSX.pdf>.
- PC817-family opto pin convention (proxy for LTV-217) — <https://www.farnell.com/datasheets/73758.pdf>.
- STR TV20/S Verdrahtungsplan + Fehlersuchhilfe — `docs/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`
  (P4 = +12 VDC Klemmen 4 & 1; ÖT bridges 2 & 3; ET interrupts line 5).
- SS14, SMF5.0A, 1N4148W, USB-C reasoned from standard pin conventions, cross-checked against the
  project's JLCPCB symbol pads.
