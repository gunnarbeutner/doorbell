# Codec analog‑supply rework (ES8311 AVDD) — board change spec

**Scope:** next spin of the V4 board (`kicad/doorbell.kicad_sch` / `.kicad_pcb`). Fixes the broadband
white‑noise floor on the codec output by giving the ES8311 a clean, isolated analog supply, per the
ES8311 datasheet + the ES8388/ESP32‑LyraT reference architecture.

This is a forward‑looking change list, not a description of the current board — keep it out of
DESIGN.md until the change is made.

---

## 1. Problem & root cause

- **Symptom (V4.0 proto):** continuous broadband **white noise** on the DAC output; in‑band SNR
  ≈ 3 dB (`osci/v40-tx-audio-3`). Not underruns (music was continuous), not low source level, and
  **48 kHz did not help** → it is *not* quantization.
- **Root cause:** `AVDD` is fed from the **shared, WiFi‑loaded +3V3** through **FB1 (600 Ω@100 MHz)
  only**. A ferrite is ~0 Ω at audio/LF, so the "FB1 + C10" filter has a corner ~50 kHz and gives
  **zero rejection in the audio band**. The +3V3 carries the LDO noise + the ~90 mV WiFi‑TX droop +
  digital hash, all of which land on AVDD.
- **Why it hits the output:** on the ES8311 the **output driver and the references (VMID/DAC/ADC
  VREF) all run off AVDD** (see §3), so AVDD noise is output noise directly.

## 2. Reference basis

- **ES8311 datasheet** (`docs/ES8311_datasheet.pdf`, §2 pinout, §3 typical application):
  - **PVDD (pin 3) = digital input/output supply; DVDD (pin 4) = digital core; AVDD (pin 11) =
    analog supply** (feeds the HP driver + references). VMID/DACVREF/ADCVREF (16/15/14) are
    filter‑cap pins.
  - "In the layout, **chip is treated as an analog device**"; system ground ties to **AGND through a
    single 0 Ω** (star point). Filter caps **on the same layer, as close to the pins as possible**.
    EPAD/PGND (pin 21 underside) tied to ground.
- **ES8388 user guide / ESP32‑LyraT V4.3** (the requested reference design):
  - "**One LDO is recommended** to power the codec because it is an analog device sensitive to noise."
  - LyraT uses a **dedicated codec LDO** (LP2985‑33 class) with "an **inductor and double decoupling
    capacitors on both the input and output** of the LDO."

> Note: the ES8388's "10 Ω between AVDD and HPVDD" guidance does **not** map to the ES8311 — the
> ES8311 has no separate output‑driver supply pin (the driver is on AVDD), so there is nothing to
> split off. Earlier "move PVDD onto the LDO + 10 Ω" plan is **dropped**; PVDD/DVDD stay digital.

## 3. The changes (exact)

| # | Change | Detail |
|---|--------|--------|
| 1 | **Add a dedicated low‑noise LDO** for AVDD | `LP5907MFX‑3.3` (SOT‑23‑5, low‑noise/high‑PSRR). **Vin = +5V** (post F1/SS14), **Vout = 3.3 V → AVDD net only**. (LP2985‑3.3 = the LyraT‑equivalent alt.) |
| 2 | **Relocate FB1** to the **LDO input** | `+5V → FB1 (600 Ω@100 MHz) → Cin → LDO_IN`. FB1's job is now HF polish on +5V (the LDO PSRR rolls off at HF); the LDO does the LF isolation FB1 never could. |
| 3 | **Add Cin** at the LDO input | 1 µF (after FB1). |
| 4 | **LDO output decoupling** | `Cout` per LP5907 datasheet (1 µF) **at the LDO pin**; then the existing **C9 (100 nF) + C10 (10 µF)** stay **at the codec AVDD pin** as local bypass. |
| 5 | **Optional output π‑filter** | Reserve land for a 2nd ferrite between Cout and C10 (`LDO → Cout(at pin) → FBout → C10`). **Default: DNP** — fit only if bench shows residual HF on AVDD. Keep Cout at the LDO pin (LDO stability) — never a bead between the LDO and its output cap. |
| 6 | **PVDD (pin 3) + DVDD (pin 4): NO CHANGE** | Stay on **+3V3** with 0.1 µF + 1 µF. They are digital — do **not** move to the analog LDO. |
| 7 | **VMID / DACVREF / ADCVREF: NO CHANGE** | C12 / C11 / C13 (≥ 1 µF each) already meet the datasheet (1 µF min). Keep, place tight to pins. |
| 8 | **Grounding** | Make the codec's **AGND a local analog‑ground pour**, single‑point tied to main GND near the codec via **0 Ω (or a bead)** per the datasheet; keep it **off the WiFi/digital return path**. EPAD/PGND → GND stays. (See §6 for the P1↔GND‑bond reconciliation.) |

## 4. Net changes (before → after)

| Net | Before | After |
|-----|--------|-------|
| **AVDD** | `+3V3 → FB1 → AVDD` | `+5V → FB1 → Cin → LDO → Cout → AVDD` |
| **PVDD** (pin 3) | +3V3 | +3V3 (unchanged) |
| **DVDD** (pin 4) | +3V3 | +3V3 (unchanged) |
| new: **+5V_AF** (LDO in, after FB1) | — | FB1 → Cin → LDO_IN |

## 5. BOM delta

| Action | Ref | Part / value | Notes |
|--------|-----|--------------|-------|
| **Add** | U_x | **LP5907MFX‑3.3** LDO, SOT‑23‑5 | confirm JLCPCB stock; alt LP2985‑3.3 |
| **Add** | C_in | 1 µF (≥ 10 V, X7R) | LDO input, after FB1 |
| **Add** | C_out | 1 µF (per LDO datasheet) | at LDO output pin |
| **Move** | FB1 | 600 Ω@100 MHz (existing) | from AVDD line → LDO input |
| **Keep** | C9, C10 | 100 nF, 10 µF | now local decouple at codec AVDD pin |
| **DNP land** | FB_out | ferrite | optional output π; fit only if needed |
| **Not needed** | — | 10 Ω AVDD↔PVDD | ES8311 output driver is on AVDD — no separate pin |

Net new parts: **1 LDO + 2 caps** (+ one optional DNP ferrite land).

## 6. Layout / grounding (the part that makes or breaks it)

- A clean LDO over a noisy ground buys nothing. Per the datasheet, **treat U3 as an analog device**:
  local analog‑ground pour under/around the codec + its decoupling, **single‑point tie** to the main
  GND plane (0 Ω/bead), routed away from WiFi/SMPS/digital return currents.
- **Reconcile with the P1↔GND bond:** the bus bond stays where it is for the transformer‑less bus
  coupling; the codec AGND star is a *local* discipline within the shared plane, not a second
  galvanic split. Place the LDO + Cin/Cout close to U3, short AVDD trace.
- Keep all AVDD/VREF/VMID filter caps on the same layer, hard against the pins.

## 7. Confirm before fab

- [ ] **ES8311 AVDD operating range** vs 3.3 V (datasheet recommended operating conditions) — 3.3 V
      is the standard ES8311 analog rail; verify min/max.
- [ ] **Analog supply current** → LDO sizing (mono codec into a 2.2 kΩ strap = a few mA; LP5907's
      250 mA is far more than enough — thermals trivial, 1.7 V × few mA).
- [ ] **LP5907MFX‑3.3 stock + footprint** at JLCPCB (else LP2985‑3.3).
- [ ] **AGND star point** drawn on the 4‑layer stack with the P1↔GND bond.
- [ ] Decide whether to **populate the output‑side ferrite** (default DNP).

## 8. Verification (next bench bring‑up)

- Scope **AVDD (U3 pin 11)** ripple/noise before vs after — broadband ripple should drop markedly.
- Re‑capture TX at **≥ 125 kS/s** (`osci/`), re‑run the speaker‑band filter, compare the in‑band
  noise floor against the V4.0 numbers (≈ 3 dB SNR / ~1100‑RMS floor). Target: program well above
  the floor; the band‑limited `-speaker.wav` clean.

## 9. References

- ES8311 datasheet — `docs/ES8311_datasheet.pdf` (§2 pin out, §3 typical application circuit).
- [ES8388 User Guide](https://dl.radxa.com/rock2/docs/hw/ds/ES8388%20user%20Guide.pdf) — codec LDO + decoupling + ground guidance.
- [ESP32‑LyraT V4.3 Hardware Reference](https://docs.espressif.com/projects/esp-adf/en/latest/design-guide/dev-boards/board-esp32-lyrat-v4.3.html) and [schematic](https://dl.espressif.com/dl/schematics/esp32-lyrat-v4.3-schematic.pdf) — dedicated codec LDO, LC on both LDO sides.
