# JLCPCB Basic-parts review

Which BOM parts assemble for free versus which carry JLCPCB's per-type setup fee, and which
of the fee-bearing parts could move to a free one.

JLCPCB charges a one-time setup fee (≈ $3) per *unique* **Extended** part number, regardless
of quantity. **Basic** *and* **Preferred** parts both assemble for free — only **Extended**
costs the fee. Classification and alternatives were taken by querying the local JLCPCB
catalog mirror (616,593 in-stock parts) directly by SQL, per LCSC number in
`kicad/fab/doorbell-bom-jlcpcb.csv`.

The free-assembly pool is small and curated: **351 Basic + 1,216 Preferred = 1,567 parts**.
For most categories there is simply no free option — notably the catalog mirror has **no
free Connectors and no free Relays at all**.

## Bottom line

- **15 Basic + 1 Preferred** of the 31 distinct parts already assemble for free. The board is
  already heavily free-leaning: every MLCC, every resistor (bar one high-value), the diodes,
  the indicator LED, the BOOT switch, **and the LTV-217 optocoupler** are Basic; the SMF5.0A
  bus TVS is Preferred.
- **15** distinct parts are Extended → up to **≈ $45** in one-time setup fees.
- **3** of those 15 can realistically move to a free part: the **6.8 MΩ resistor** (cleanest —
  same footprint), the **dual MOSFET**, and the **USB ESD clamp**.
- The other **12** have **no free substitute anywhere in the catalog** — they are Extended
  because they are specialized (RF module, audio codec, low-dropout LDO, PhotoMOS SSRs,
  signal relay, USB-C jack, bus terminal, 50 V electrolytic, fast fuse, panel door-switch).
- **Separately from the fee:** a few parts have cheaper *same-function* equivalents — biggest
  are the **USB-C jack** (≈ −$0.64/unit) and the **door-release switch** (≈ −$0.47 each). See
  [Cheaper equivalents](#cheaper-equivalents-same-function). Most other parts are already at
  or near catalog-floor price, and several tempting "cheaper" parts are **not** true
  equivalents (high-dropout LDOs, normally-*open* SSRs) — those are flagged, not recommended.

---

## Already free to assemble — no action

| Ref(s) | Value / part | LCSC | Type |
|---|---|---|---|
| C2,C3,C4,C10,C11 | 10 µF 0603 | C19702 | Basic |
| C5,C12–C18,C20 | 1 µF 0603 | C15849 | Basic |
| C6–C9 | 100 nF 0603 | C14663 | Basic |
| D1,D8,D9,D11 | 1N4148W | C81598 | Basic |
| D4 | SS14 Schottky | C2480 | Basic |
| D6 | Red LED 0603 | C2286 | Basic |
| D10 | SMF5.0A bus TVS | C19077497 | **Preferred** |
| OC1,OC2 | LTV-217 (PC817) optocoupler | C115450 | Basic |
| R1,R2,R13,R14 | 5.1 k 0603 | C23186 | Basic |
| R3,R15 | 1 k 0603 | C21190 | Basic |
| R4,R5,R6,R21,R24 | 300 Ω 0603 | C23025 | Basic |
| R7–R11,R18–R20,R22,R23 | 10 k 0402 | C25744 | Basic |
| R12 | 3.3 k 0603 | C22978 | Basic |
| R16,R28,R29 | 2.2 k 0603 | C4190 | Basic |
| R17 | 22 k 0603 | C31850 | Basic |
| SW1,SW2 | BOOT tact switch | C720477 | Basic |

---

## Extended → can move to a free part

| Ref | Current part | LCSC | Free replacement | Notes |
|---|---|---|---|---|
| R25 | 6.8 MΩ 0603 (watchdog timing) | C23213 (Ext) | **Single free 0603 value, same footprint** — 5.1 MΩ `C13320` (Pref) or 10 MΩ `C7250` (Basic); or **4.7 MΩ `C23163` + 2.2 MΩ `C22938`** in series ≈ 6.9 MΩ | A single 6.8 MΩ 0603 only stocks as Extended, but the R25·C20 one-shot is hugely tolerant — DESIGN.md already quotes a 2.5–10 s release spread from the 2N7002 Vgs(th). So 5.1 MΩ (~5 s) or 10 MΩ (~10 s) drops straight in with no board change; the series pair holds ~6.9 s if you want the nominal. **Cleanest win.** |
| Q3 | 2N7002DW dual N-FET, SOT-363 | C83571 (Ext) | **2× 2N7002**, SOT-23 — `C8545` (Basic) | No free dual-FET exists, but the two halves are already used independently (unit 1 = break-before-make RC delay, unit 2 = watchdog one-shot), so two singles are equivalent. Costs a footprint change: one SOT-363 → two SOT-23 (more board area). |
| D5 | TPD2S017 USB ESD clamp | C880115 (Ext) | **Preferred ESD array** — SRV05-4 `C85364` or SMF05C `C15879` (both SOT-23-6) | A free 4-/5-line rail-clamp ESD array covers the USB2.0 D± ESD job. **Caveat:** the TPD2S017 is a *flow-through* device biased from fused VBUS (back-drive / short-to-VBUS aware), which a plain rail-clamp array is not, and the pinout differs (pad remap). Verify it meets the protection intent before swapping. |

Doing all three removes 3 of the 15 fees (≈ −$9), but R25 is the only one with no board/pad penalty.

---

## Extended → keep (no free part exists in the catalog)

Confirmed against the full 616k-part mirror — these have **zero** Basic/Preferred options:

| Ref | Part | LCSC | Why it stays Extended |
|---|---|---|---|
| U1 | ESP32-S3-MINI-1U-N8 | C2980299 | No RF/WiFi module is ever free-library. Core part. |
| U3 | ES8311 audio codec | C962342 | No free audio codec. Tied to the firmware I²S path. |
| U2 | SGM2212-3.3 LDO | C3294699 | Needs ~350 mA at **low dropout** (~0.45 V). The only free 3.3 V LDOs are AMS1117-3.3 (`C6186`, 1.1 V dropout — DESIGN.md rejects it: browns out under WiFi-TX), XC6206 (200 mA) and HT7533 (100 mA) — all inadequate. |
| C19 | 22 µF / **50 V** electrolytic | C98744 | The catalog has **no free aluminium electrolytics at all**, and free 22 µF MLCCs top out at 25 V < the required 50 V. |
| F1 | Littelfuse 0466 1 A fast fuse, 1206 | C151135 | **No free fuses** in the catalog (the free "circuit protection" parts are all TVS/ESD diodes). F1 is the sacrificial fast-blow ahead of all other protection — don't compromise it anyway. |
| J1 | GCT USB4105 USB-C receptacle | C3025063 | **No free Connectors of any kind** in the catalog. (Also worth a separate look: current part is down to ~578 in stock.) |
| J2 | DORABO DB125-3.5 5P screw terminal | C3646874 | Same — no free Connectors. |
| K1 | GAQW212GS PhotoMOS (dual 1-Form-A) | C7435123 | **No free Relays/SSRs** in the catalog. |
| K2 | GAQY212GS PhotoMOS (1-Form-A) | C7435107 | As above. |
| K3,K4 | GAQY412EH PhotoMOS (1-Form-B NC) | C7435135 | As above; the idle-closed (NC) behaviour is fail-safe-critical. |
| K5 | Omron G6K-2F-Y DC12 signal relay | C397194 | As above. |
| SW3,SW4 | ALPS SPPJ322300 door-release switch | C398940 | Only two free switches exist, both small tactile types — no free panel DPDT. (Stock low: ~445.) |

---

## Cheaper equivalents (same function)

Unit prices are the **≤100-piece tier** (the small-order price you'd actually pay), from the
catalog mirror. "Δ/unit" is the saving versus the current part; **fee** notes whether the
swap also changes the $3 setup fee. None of these is a guaranteed drop-in — read the caveat.

| Ref | Current → cheaper equivalent | $/unit (cur → new) | Δ/unit | Caveat |
|---|---|---|---|---|
| J1 | USB4105 `C3025063` → generic 16P Type-C `C2927038` (157k stk) | 0.680 → 0.040 | **−$0.64** | Footprint change (verify against USB4105 pad layout). Both Extended — no fee change. Also relieves the current part's ~578-pc stock. |
| SW3,SW4 | SPPJ322300 `C398940` → momentary DPDT `C194401` | 0.541 → 0.073 | **−$0.47** ea (×2) | Mechanical part: match plunger height, actuation force and mounting to the enclosure. Both Extended. |
| D5 | TPD2S017 `C880115` → SRV05-4 `C85364` (Preferred) | 0.296 → 0.169 | **−$0.13** + **−$3 fee** | Also the free-assembly swap above — rail-clamp array, not flow-through; verify protection intent + pin remap. |
| F1 | Littelfuse 0466 `C151135` → `C136343` (41k stk) | 0.078 → 0.038 | **−$0.04** | Safety part: confirm fast-blow characteristic + breaking capacity before trusting it. |
| K3,K4 | GAQY412EH `C7435135` → NC PhotoMOS `C5357970` | 1.025 → 0.919 | −$0.11 ea (×2) | **Must stay 1-Form-B (NC)** — the cheap SMD-4P PhotoMOS (TLP240A, OR-406AS) are normally-*open* and would break the fail-safe. The NC parts that exist are SOP-4 (≠ SMD-4P footprint) and low-stock. Marginal — probably not worth it. |
| C19 | 22 µF/50 V elec. `C98744` → `C72505` (53k stk) | 0.034 → 0.030 | −$0.004 | Same 22 µF/50 V can size; negligible saving, better stock. |

**Checked and left alone — no genuine cheaper equivalent:**

- **U2 SGM2212-3.3 LDO** ($0.366): the $0.03 SOT-223 "3.3 V LDOs" are all 1.1–1.5 V@1A
  **high-dropout** AMS1117-class parts — the very thing DESIGN.md rejects. Not equivalent.
- **K5 G6K-2F-Y relay** ($0.655): already the **cheapest** DPDT-12V SMD signal relay in the
  catalog; the next-nearest are dearer.
- **K1/K2 PhotoMOS SSRs**: the few cheaper SOP-8/SOP-4 parts are either undocumented (no
  spec sheet in the mirror) or lower-current / higher-Ron — not verified equivalents.
- **U1 ESP32-S3-MINI-1U-N8** and **U3 ES8311**: single catalog listing each; no cheaper twin
  (the ESP32 PCB-antenna `-1-` variants are a *different* part, not a drop-in).
- **Passives, diodes, LED, optocoupler** (all Basic): already at sub-cent / catalog-floor
  pricing — any "cheaper" swap saves a fraction of a cent and risks a known-good Basic part.

---

## Method & caveats

- **Source:** local SQLite mirror of JLCPCB's in-stock catalog (`cdfer`, 616,593 parts;
  351 Basic / 1,216 Preferred / 615,026 Extended), queried directly by SQL. The MCP catalog
  tools were too coarse for this: their keyword search matches only manufacturer-part-name
  tokens, and `suggest_jlcpcb_alternatives` ranks by *same package + lower price* ignoring
  function and library type (it proposed MCUs for the codec, crystals for the USB-C jack) and
  never returned a single Basic/Preferred result — so the analysis above is from direct SQL,
  not those tools.
- **Free pool only = in-stock subset.** A part absent here could exist in JLCPCB's full
  (incl. out-of-stock) catalog; for a real order, confirm in the cart.
- **Prices** are each part's `price_json` tier applicable to a ≤100-piece order (small-order
  pricing). At higher volume the per-unit gaps narrow but the $3-per-Extended-type fee
  weighs more heavily; re-judge against your actual build quantity.
- **Footprints:** Q3 and D5 imply a footprint/pad change; R25's single-value option does not.
  Re-run `./build.sh all-route` and DRC after any change.
- **Fee waivers:** JLCPCB periodically waives the setup fee for high-stock Extended parts —
  check the cart at order time before treating a fee as fixed.
- Snapshot taken 2026-06-21; stock and library status drift over time.
