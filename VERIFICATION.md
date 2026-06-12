# Schematic Verification Report

Independent pre-fabrication review of `kicad/doorbell.kicad_sch`, performed blind
(without consulting DESIGN.md or the generator scripts). Connectivity was extracted
from the routed PCB netlist, every pin assignment was checked against the official
manufacturer datasheets, and the intercom-side logic was cross-checked against the
STR TV20S service documentation (`STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`) and the
reverse-engineered WF26 station schematic (`wf26/wf26.kicad_sch`).

**Verdict: no polarity errors, no pin-mapping errors, no unusable-pin problems.**
Schematic and PCB agree on all 74 components; ERC reports 0 errors (64 warnings, all
benign "Unspecified pin type" noise from the converted JLCPCB symbols plus
library-path warnings). Three lower-severity items are listed at the end.

## WF26 internal model (basis for the system-level checks)

From `wf26/wf26.kicad_sch` (reverse-engineered apartment station):

- **LS1 Speaker/Mic (16 Ω) sits directly across P5–P1** — the same pair the board's
  transformer bridges. The speaker doubles as the microphone during talk.
- **Internal relay K1** (HJR-4102-N, 12 V coil between **P5 and P2**): the TV20S
  arms it with ~12 VDC on P5–P2 during the speech window; its contact connects
  K1_COM → P2.
- **S2 (Sprechen/Hören)**: at rest straps P4 ↔ P3 (LISTEN); pressed connects
  P4 → K1_COM, so **TALK = P4 ↔ P2** through the armed relay.
- **S1 (Türöffner) + R1: pressing bridges P2 — 2.2 kΩ — P3.**
- **C1 22 µF/50 V across P1(+)–P2(−)** — P1 rides at the relay-feed DC level, so
  the speaker pair P5–P1 stays DC-free even during the speech window.

## Verified correct

### Relay drivers (K1–K3, Q1–Q3, D1–D3)

- **Coil polarity** — the G6K-2F-Y is a polarized relay that will not pull in if the
  coil is reversed. The Omron datasheet puts coil **+** on pin 1, − on pin 8. All
  three relays have pin 1 on +5V and pin 8 on the 2N7002 drain. Correct.
- **Coil drive level** — 4.5 V coil (194 Ω, 23.2 mA, max allowable 6.75 V) on a
  ~4.65 V rail (5 V minus SS14 drop); must-operate ≤ 3.6 V. Within spec.
- **Contact mapping** (datasheet: pole A COM=3 / NC=2 / NO=4; pole B COM=6 / NC=7 /
  NO=5):
  - K3 passes IN_P4 ↔ P4 through its **NC** contact — the existing doorbell line
    works whenever the board is unpowered or idle (fail-safe).
  - K1 (IN_P4 → P2 via NO) **replicates the WF26 talk path** (TALK = P4 ↔ P2),
    bridging directly instead of waiting for the TV20S to arm the WF26's internal
    relay.
  - K3 pole B routes the GPIO21 gate signal to Q1 through its **NO** contact, so K1
    physically cannot connect IN_P4 → P2 unless K3 has first isolated the WF26.
    This interlock is **load-bearing**: the WF26 at rest straps P4 ↔ P3, so closing
    K1 with the WF26 still attached would chain line 2 → line 4 → line 3 — the
    door-opener trigger condition. K3 breaking the WF26's line-4 connection first
    makes a phantom door-release impossible by construction.
  - K2 bridges P2 → 2.2 kΩ (R16) → P3 — an **exact replica of the WF26's own
    door-release circuit** (S1 + R1 2.2 kΩ), and consistent with the TV20S service
    note ("Klemmen 2 u. 3 brücken"). The TV20S demonstrably triggers through
    2.2 kΩ, since that is how the original button works.
  - Contact ratings (1 A / 30 VDC) are ample for signaling currents.
- **Flyback diodes** D1–D3: cathode (pin 1) on +5V, anode on the drain. Correct.
- **Boot safety** — relay gate GPIOs (20/21/22) are Hi-Z at reset and held off by
  the 10 k pull-downs (R7/R8/R9); no relay chatter at power-up.

### Diode orientations (all instances)

The JLCPCB symbols draw pin 1 as cathode, matching the KiCad footprint convention
(verified from the embedded symbol graphics). Per instance:

| Ref | Part | Connection | Status |
|-----|------|-----------|--------|
| D4 | SS14 | cathode → +5V, anode → VBUS_F | correct reverse-protection |
| D1–D3 | 1N4148W | cathode → +5V, anode → relay drain | correct flyback |
| D7–D9 | 1N4148W | anti-parallel across opto LEDs | correct (clamps reverse < LTV-217's 6 V limit) |
| D10 | SMF5.0A | cathode → VBUS_F, anode → GND | correct TVS orientation |
| D6 | LED | cathode → GND, anode ← R15 ← 3V3 | correct |

### USB-C and ESD protection (J1, D5, R13/R14, F1, D10, D4)

- GCT USB4105 pad map confirmed (A5=CC1, B5=CC2, D+ on A6/B6, D− on A7/B7); both
  rows correctly paralleled, SBU unused.
- CC1/CC2 have **separate** 5.1 k pull-downs — correct UFP sink advertisement.
- **No D+/D− swap anywhere**: connector D− → TPD2S017 CH1 → GPIO12 (USB_D−),
  D+ → CH2 → GPIO13 (USB_D+), confirmed against both GCT and Espressif datasheets.
- TPD2S017 orientation correct: IN pins (3/4) face the connector, OUT pins (1/6)
  face the ESP, exactly as TI's application schematic shows. Series resistance is
  only 1 Ω (not a 100 Ω-class part) — USB full-speed signaling is unaffected; the
  part is rated for USB 2.0 high-speed. VCC on VBUS_F is within its 5.5 V range.
- Protection ordering VBUS → F1 (1 A fast) → TVS (D10) → Schottky (D4) → +5V is
  correct (fuse protects the TVS clamping path).

### Power (U2, C2–C4)

- SGM2212-3.3 SOT-223 pinout is AMS1117-compatible (1=GND, 2/tab=VOUT, 3=VIN) —
  matches the netlist, including the tab on +3V3.
- Headroom: input ~4.65 V, dropout ≤ 280 mV @ 500 mA → ample margin; 800 mA rating
  covers the ESP32-C6's 382 mA Wi-Fi TX peak (Espressif requires ≥ 0.5 A supply).

### ESP32-C6-WROOM-1 (U1)

- All 28 module pin numbers match Espressif datasheet v1.4 exactly.
- Strapping: GPIO9 (BOOT) pulled up via R11 + button ✓; GPIO8 pulled up via R12
  (required high for USB download boot) ✓; GPIO15 floating is safe with default
  eFuses (JTAG source is USB-Serial-JTAG, GPIO15 ignored); GPIO4/5 only matter for
  SDIO slave — unused.
- EN reset circuit: 10 k (R10) + 1 µF (C5) + button — fine (~10 ms delay).
- All I2S/I2C/GPIO pin choices are legal via the GPIO matrix; no module pins are
  consumed by the in-package flash (flash uses non-bonded chip pins GPIO24–30).
- UART0 (GPIO16/17) not broken out — USB-Serial-JTAG is the only flash/debug path;
  acceptable since the strapping that enables USB download boot is in place.

### Audio codec and line coupling (U3, T1, C11–C17, R20)

- The custom ES8311 symbol's pin order matches the Everest datasheet pin-for-pin
  (QFN-20: 1 CCLK … 20 CE, EP=PGND).
- I2S directions correct: ASDOUT (pin 7) → ESP GPIO10 input; DSDIN (pin 9) ← ESP
  GPIO7 output; MCLK ← GPIO6; SCLK ← GPIO11; LRCK ← GPIO0. No swaps.
- CE with 10 k to GND is literally the datasheet reference circuit → I2C address
  0x18. Exposed pad grounded ✓. VMID/ADCVREF 1 µF match the reference design
  (DACVREF is 10 µF vs. the reference 1 µF — harmless). 3.3 V on
  PVDD/DVDD/AVDD is a listed typical; same-rail sequencing satisfies the 10 ms
  PVDD/DVDD requirement.
- SM-LP-5001: pins 2/5 are NC per Bourns (correctly left open); windings 1–3
  (codec side) and 4–6 (line side) used as winding ends; part is symmetric, 600:600,
  2 kVrms isolation. OUTP/OUTN driving 600 Ω is far above the codec's 16 Ω minimum
  load.
- **No DC-saturation risk**: the WF26's 16 Ω speaker hangs directly and permanently
  across P5–P1 (confirmed in `wf26.kicad_sch`), so that pair cannot carry standing
  DC — even during the speech window, when the 12 V relay-arm voltage sits on P5–P2
  (P1 follows P5, corroborated by the WF26's polarized C1 across P1(+)–P2(−)). The
  transformer's 115 Ω winding across P5–P1 is safe.

### Bell sense (OK1–OK3, SW3–SW5, D7–D9, R1/R2/R17, R3)

- LTV-217 SOP-4 pinout confirmed (1=anode, 2=cathode, 3=emitter, 4=collector) and
  matches usage.
- Sense pairs match the TV20S/WF26 documentation: OC2 on lines 1 ↔ IN_P4 (door-call
  ring, ~12 VDC on 4↔1 — sensed on the **riser side** of K3's break, so ring
  detection still works while the local gong is muted); OC3 on 1 ↔ 5 (floor call);
  OC1 on 2 ↔ 5 — this is the pair the TV20S puts ~12 VDC on to arm the WF26 talk
  relay, so **OC1 detects the speech window opening**.
- Firmware disambiguation (hardware is fine; handled in `doorbell-v4.yaml`):
  - OC3 sits across the speaker pair, so it fires on *any* loud speaker audio —
    door gong, floor-call tone, and speech alike. The Apartment Doorbell sensor is
    masked while House Doorbell / session / PTT are active, and uses a
    stretch-then-require filter chain because the opto output pulses at audio rate
    (a plain `delayed_on` never latches on a tone).
  - When line 4 is bridged to P2 — by the board's K1 *or* by a resident pressing
    the WF26 talk button during an armed window — OC2 sees the P1↔P2 standing
    voltage and lights without a ring. The House Doorbell sensor is masked during
    PTT and for the whole armed session.
- LED current at 12 VDC: (12 − 1.2) / 5.1 k ≈ 2.1 mA; with ≥ 130 % CTR this
  comfortably saturates against the ESP's internal pull-up. Resistor dissipation
  ~23 mW (0603 OK).
- CAS-220 polarity switches: commons are terminals 2/5 (Nidec datasheet); the
  cross-wiring produces a true polarity swap in both positions and never shorts the
  sensed pair. Contact ratings (24 VDC / 25 mA switching, 50 VDC / 100 mA carry)
  cover the 12 V / 2 mA sense loop.

## Findings (decide before ordering)

1. **Opto outputs have no pull-up resistors.** *(Addressed: R21–R23, 10 k collector
   pull-ups to +3V3 — the sense inputs no longer depend on the ESP32's internal
   pull-ups.)* OC1_OUT/OC2_OUT/OC3_OUT collectors go
   straight to GPIO23/GPIO3/GPIO2 with nothing else on the net (emitters share R3,
   1 k, to GND). The circuit works *only* if firmware enables the internal ~45 k
   pull-ups — otherwise the inputs float. `doorbell-v4.yaml` sets `pullup: true` on
   all three inputs, so the dependency is satisfied; three 10 k pull-ups to 3V3
   would still make the hardware self-sufficient. (R3 contributes little — it adds
   ~70 mV to the low level.)

2. **ES8311 input headroom on loud signals.** *(Addressed: R26/R27, 10 k series
   in the mic legs — a −12.7 dB divider against the 6 kΩ input.)* Confirmed relevant by the WF26
   schematic: the transformer pair P5–P1 *is* the amp-driven 16 Ω speaker line. The
   MIC1 PGA's minimum gain is 0 dB (it cannot attenuate) and full-scale input is
   2 Vrms differential; a loud gong (~0.5–2 W ≈ 2.8–5.7 Vrms across the speaker)
   arrives at the mic pins above ADC full-scale and beyond the absolute-maximum pin
   excursion. Two series resistors between the transformer and C16/C17 (e.g. ~12 k
   each, forming a divider with the 6 kΩ input impedance) would buy ~10 dB of
   headroom. (At extreme volume the SM-LP-5001 core itself — rated 10 dBm — will
   also distort; harmless to hardware, audible only at gong peaks.) Everest's user
   guide also formally notes the mic input "isn't recommended for line input" (it
   works at 0 dB; this is vendor hedging).

3. **Shared-winding hybrid quality (transmit corner + DAC shunting).** *(Addressed:
   R24/R25, 1 k series in the DAC legs — TX corner ~160 Hz, idle-DAC shunting gone.)* Transmit
   level is *not* a problem — during talk the WF26 speaker acts as a dynamic
   microphone, so the TV20S expects mV-level signals on P5–P1, and even the ~24 dB
   loss through the 2 × 115 Ω winding DCR into the 16 Ω speaker leaves the DAC
   output far hotter than a real mic. Two quality items remain:
   - C14/C15 (1 µF each, 0.5 µF effective) against the ~16 Ω-dominated line give a
     high-pass corner above 1 kHz — transmitted voice will sound thin. Larger caps
     (10 µF) or series resistors fix this.
   - The DAC outputs are low-impedance even when idle and shunt the same winding
     nodes the ADC taps (C16/C17), shelving received audio down by ~5–12 dB toward
     4 kHz. A few hundred ohms in series with the C14/C15 legs addresses both
     points at once; the transmit path can easily afford the extra loss.

### Minor notes (no action strictly needed)

- Only ~20 µF bulk on the 5 V side; a 100 µF electrolytic would help Wi-Fi TX bursts
  ride through cable/fuse drop. Worst-case simultaneous peak (~470 mA) is right at
  the USB 2.0 default 500 mA budget, though real averages are far lower.
- Power LED runs at ~1.3 mA — dim (possibly deliberate for a doorbell).
- C11 on DACVREF is 10 µF vs. the datasheet's 1 µF — harmless, slightly slower
  start-up settling.
- I2C pull-ups are 10 k where the ES8311 user guide suggests 1–4.7 k — fine at
  100 kHz with short traces.
- SMF5.0A standoff is 5.0 V against a nominal 5.25 V max VBUS — µA-level leakage at
  the extreme, standard practice.
- Module 3V3 bulk (C3) is 10 µF where the WROOM-1 datasheet's peripheral schematic
  shows 22 µF (Fig. 9-1, `docs/esp32-c6-wroom-1_wroom-1u_datasheet_en.pdf` p. 40);
  however the DevKitC-1 reference board itself uses 10 µF + 0.1 µF (C1/C2,
  `docs/esp32-c6-devkitc-1-schematics_v1.4.pdf` p. 2), which our C3 + C6 match
  exactly. No minimum is stated anywhere.
- GPIO8 strap pull-up (R12) is 3.3 kΩ, matching the DevKitC-1 (R6 3.3K 1%, devkit
  schematic p. 2); the module datasheet's Fig. 9-1 (p. 40) shows 10 kΩ — both are
  valid, GPIO8 only needs a defined high level at boot.
- EN reset RC (R10 10 k + C5 1 µF) matches both the datasheet recommendation
  (Fig. 9-1 note, p. 40: "usually R = 10 kΩ and C = 1 µF") and the DevKitC-1
  (R5 10K + C6 1 µF, devkit p. 2).
- Button debounce caps: datasheet Fig. 9-1 (p. 40) shows an optional 0.1 µF (C4)
  across the reset button; the DevKitC-1 footprints these on both buttons but does
  not populate them (C13/C14 0.1 µF "NC", devkit p. 2). Our EN button sits next to
  C5 (1 µF), which covers the role; the BOOT button has no cap — same as the
  DevKit as shipped.
- BOOT/IO9 external pull-up (R11 10 k): neither the datasheet reference circuit
  (p. 40) nor the DevKitC-1 fit one (internal weak pull-up, default 1 — datasheet
  Table 4-1, p. 12). Ours is a harmless safety margin.
- Power LED runs ~1.3 mA via R15 1 k — the DevKitC-1's red power LED uses 5.1 k
  (R11, devkit p. 2), i.e. ~0.25 mA, so ours is brighter than the reference design.
- ES8311 user guide recommends ferrite beads on AVDD/DVDD (sec. 5.1, p. 6,
  `docs/ES8311.user.Guide.pdf`) and 33 Ω + 20 pF R-C filters on SDA/SCL (Fig. 7,
  p. 7, "strongly suggested"); neither is implemented (EMI hardening, not
  functional). I2C pull-up range 1–4.7 kΩ is from sec. 6, p. 9; DACVREF/ADCVREF/
  VMID values from the sec. 5.1 table, p. 6.
- SGM2212 CIN/COUT (10 µF each) comply: COUT range 1–10 µF effective (Recommended
  Operating Conditions, `docs/sgm2212_datasheet.pdf` p. 3), ≥2.2 µF ceramic
  recommended (p. 10); 1 µF effective minimum holds even after 0603 DC-bias
  derating. The DevKitC-1 runs the same regulator with 10 µF + 0.1 µF on each side
  (C7–C10, devkit p. 2) — the extra 100 nF HF companions are the only difference.

## Datasheet sources

- Omron G6K relay: <https://omronfs.omron.com/en_US/ecb/products/pdf/en-g6k.pdf>
- Everest ES8311: <http://www.everest-semi.com/pdf/ES8311%20PB.pdf> (user guide:
  <https://files.waveshare.com/wiki/common/ES8311.user.Guide.pdf>)
- TI TPD2S017: <https://www.ti.com/lit/ds/symlink/tpd2s017.pdf>
- Bourns SM-LP-5001: <https://www.bourns.com/docs/Product-Datasheets/SMLP5001.pdf>
- Nidec Copal CAS-220: <https://www.nidec-components.com/e/catalog/switch/cas.pdf>
- Lite-On LTV-2x7: <https://optoelectronics.liteon.com/upload/download/ds70-2009-0016/ltv-2x7%20sereis%20201610.pdf>
- Espressif ESP32-C6-WROOM-1: <https://www.espressif.com/sites/default/files/documentation/esp32-c6-wroom-1_wroom-1u_datasheet_en.pdf>
- SG Micro SGM2212: <https://www.sg-micro.com/rect/assets/54089b71-cc25-4f36-af2e-34b07f00a108/SGM2212.pdf>
- GCT USB4105: <https://gct.co/files/drawings/usb4105.pdf>
