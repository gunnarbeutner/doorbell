# STR WF 26 G — Pin / Terminal Reference & Functional Notes

> Provenance is marked per item. Confidence tags:
> **[measured]** = measured/observed directly on the unit (high);
> **[forum/installer]** = field-reported by installers/owners (medium-high);
> **[inferred]** = deduced by combining the above, pending confirmation (medium).
> The only fully authoritative source is STR's scanned schematic (see end).

## 1. Device identity

- **Device:** STR WF 26 G — "Wohnungssprechstelle WF 26 Gong" (apartment-side indoor intercom station).
- **Manufacturer:** STR-Elektronik (Josef Schlechtinger GmbH), Wenden, Germany.
- **Type:** Analog **half-duplex** intercom station (*Wechselsprechen* = push-to-talk), with a
  built-in multi-tone generator ("3-Klang") played onto the station's **16 Ω** loudspeaker —
  **not** a mechanical gong.
- **Replacement part number (whole station):** STR art. ~20370 *(forum/installer)*.

## 2. System context

- Part of STR's **older analog multi-wire (*Mehrdraht*) Wechselsprechanlage**, NOT the digital
  QwikBus 2-wire system. Consequence: there is **no continuous powered bus rail** at the station —
  the wires carry signals on demand, not a standing supply.
- Typical install: **TV 20/S central amplifier** (*Zentralverstärker*, STR art. 20360) + **8 V
  AC pre-transformer** (*Vorschalttrafo*) + one or more WF 26 stations + door station.
- All switching/tone generation lives in the **TV 20/S central unit**; the WF 26 is a
  comparatively "dumb" station hung off discrete wires. **No digital protocol** between station and
  central unit — just per-function analog conductors referenced to a common.

## 3. Terminal map

| Terminal | Function | Electrical character | Provenance |
|---|---|---|---|
| **1** | **Common / signal return** — shared 0 V reference; also the loudspeaker's return leg | Isolated **SELV common** (floats behind the safety transformer; **NOT** mains neutral/earth) | [inferred] — consistent with the loudspeaker wired across 1–5; confirm by measurement |
| **2 + 3** | *Türöffner* — door-release trigger; the button bridges **2 ↔ 3 through a 2.2 kΩ series resistor** | **Current-limited signaling closure** into the TV 20/S (the central unit drives the actual strike) — not a power switch | [measured] |
| **4** | *Türruf* — street/front-door call; **triggers** the WF26's internal tone generator | ~**12 V DC** vs pin 1, present **only while ringing** (~11.5–12.5 V). A **DC trigger**, carries no audio | value [forum/installer]; "pin 4 = + leg vs pin 1" [inferred] |
| **5** | *Etagenruf* (floor/apartment-door call) **and** the loudspeaker's hot node | **Audio (AC)** vs pin 1 — varying tone/voice on a **low-impedance 16 Ω** node, active only when driven, idles silent. Etagenruf is injected here as a raw tone | wire 5 = Etagenruf [forum/schematic]; **loudspeaker on 1–5, 16 Ω [measured]**; audio-node reading [inferred] |
| **Speech + common** | *Wechselsprechen* audio path | Analog, **half-duplex**, low-level; talk/listen switched at the TV 20/S by the "Sprechen" button | [inferred] — exact terminal numbers not yet mapped |
| **Supply → TV 20/S** | System feed (at the central unit, not necessarily present at the station) | **8 V AC**, SELV, from the kurzschlussfest Vorschalttrafo | unit label |

**Not independently verified (measure to confirm):**
- That **pin 1 is the common**: measure pin 1 → system/transformer common, and DC volts **pin 5 → pin 1 ≈ 0 V** (not 12 V).
- *Türruf* polarity: that **pin 4 is +12 V vs pin 1** during a ring.
- **Pin 5 → loudspeaker coupling**: direct or via a series capacitor (relevant when tapping pin 5).
  With **16 Ω**, a healthy direct-coupled node should read **≈ 0 V DC (tens of mV)** at pin 5 → 1;
  even ~0.5–1 V DC there (= 30–60 mA, near the speaker's rating) points to a **series coupling cap**.
- **Open-circuit voltage across 2 ↔ 3** and the resulting trigger current through the 2.2 kΩ.
- Exact terminal numbers for the speech wire(s) and common/return.

## 4. Türruf vs Etagenruf — different mechanisms

Pins 4 and 5 are **different wires doing different jobs**, both referenced to common pin 1. "1–4 is
DC" and "1–5 is AC" are not contradictory: they are separate conductors that share one reference.

- ***Türruf* (pin 4): a 12 V DC trigger.** It carries no audio — it tells the WF26's internal tone
  generator to fire, and the generator drives the speaker. Result: a shaped "3-Klang" tone at a
  controlled level.
- ***Etagenruf* (pin 5): a raw audio tone injected directly** onto the speaker node (loudspeaker is
  wired **1–5**). It bypasses the internal generator, so it reproduces immediately, loud, with no
  shaping or volume limiting.
- **The DC and the audio never share a conductor.** The 12 V DC lives on pin 4; the audio lives on
  pin 5; pin 1 is the common to both. The **1–5 loudspeaker sees no sustained DC** — a steady 12 V
  across a **16 Ω** speaker would dissipate ~9 W (tens of times its fraction-of-a-watt rating) and
  cook the voice coil — so from the speaker's standpoint pin 5 is essentially AC.

Note on the "8 V vs 12 V" values: the central unit is stamped **8 V** (the **AC** transformer
feed); the ~**12 V DC** is the trigger rail the amplifier generates. Different nodes; both normal.

## 5. Functional behavior

- **Ring sequence:** street-door button → ~12 V DC appears on **pin 4** (vs 1) → internal tone
  generator fires → a **~25-second** *Wechselsprech* window opens automatically.
- **Talk (half-duplex):** during the window, **hold** "Sprechen" to speak, **release** to listen.
  One direction at a time; the TV 20/S does the switching.
- **Floor call (*Etagenruf*):** audio tone on **pin 5** → loudspeaker (1–5) directly; distinct,
  louder/unshaped vs the street-door ring.
- **Door release:** button bridges **2 ↔ 3 via 2.2 kΩ**, signaling the TV 20/S to energize the
  door-release buzzer/strike. The station sends only a current-limited trigger; the central unit
  does the switching/power.

## 6. Interfacing notes (sensing / automation)

- **Ring sense (pin 4, Türruf) → optocoupler.** Already DC and (expected) polarity-correct
  (4 = +, 1 = −): a series resistor into the opto LED, sized to its current, gives a clean ring event.
- **Floor-call / audio (pin 5) → harder.** It is a varying audio waveform, not a DC level. For a
  simple "is it ringing" signal, envelope-detect on the intercom side and opto the resulting DC; for
  the actual audio across the barrier, use an audio isolation transformer / iso-amp.
- **Door release (2 ↔ 3) → relay dry contact, or an opto-MOSFET/SSR, in series with the 2.2 kΩ.**
  Coil/LED on the MCU side, contact on the intercom side = inherently isolated. Retain the 2.2 kΩ to
  reproduce the trigger signature; do not hard-short 2 ↔ 3.
- **Isolation by default.** Pin 1 is a *floating* SELV common; bonding it to the MCU ground creates
  ground loops and the "Anlage brummt" hum this system is prone to. Couple via optos/relays so there
  is **no shared copper**. Keep the intercom side passive or on its own rail; do not back-feed MCU
  power across the barrier, which re-bonds the grounds and removes the isolation.
- **SELV / kurzschlussfest supply:** low-energy and tolerant of momentary shorts on the
  switched-power lines — but the **audio stage is not** covered by that tolerance.

## 7. Measurement / safety guidance

- Verify every value on the actual installation with a multimeter before relying on it.
- **STR wire colors are NOT standardized** — do not infer function from color; ring out / measure,
  or copy a known-good neighboring station.
- In multi-party buildings, obtain owner/management permission before modifying shared wiring, and
  confirm any added load does not degrade tenants' service.
- These stations are **hum-prone** ("Anlage brummt") if the speech return or supply routing is
  wrong — see the STR fault-finding sheet.

## 8. Authoritative source

- STR-Elektronik download portal → **"Schaltpläne und Fehlersuche → Wechselsprechanlagen"**
  (analog Wechselsprechanlagen): the `TV20S` Schaltplan + Fehlersuchhilfe.
- This is a **scanned image PDF** (no extractable text) and must be read visually; it contains the
  complete per-terminal map plus the "Anlage brummt" troubleshooting section.

---
*Compiled from STR product listings and an STR-Elektronik central-amplifier/station pairing, two
German installer/owner forum threads (elektrikforen.de, wer-weiss-was.de), and direct measurement
on the unit. Measured/observed directly: the door-release mechanism (2 + 3 via a 2.2 kΩ series
resistor) and the 16 Ω loudspeaker wired across pins 1 and 5 — from which pin 1 = common, pin 4 =
DC trigger, and pin 5 = audio node are inferred. Field-sourced where the manufacturer schematic is
image-only; confirm against that schematic and on-site measurements.*
