# WF 26 — Neutral Schematic Readout

A factual, connectivity-level readout of `wf26.kicad_sch` (the reverse-engineered internals of
the STR WF 26 handset). Connectivity is taken from the netlist exported by `kicad-cli`. This file
describes only what the schematic **contains and connects** — no functional interpretation. For
the functional / inferred model, see `../DESIGN.md` ("WF26 internal circuit").

## Scope

Seven components plus one 5-position connector that represents the wires to the rest of the
system. There are no active devices (no ICs, no semiconductors).

## Components

| Ref     | Value (schematic field)      | Type                         | Footprint                                  |
| ------- | ---------------------------- | ---------------------------- | ------------------------------------------ |
| J1      | "WF26 -> TV20 S bus"         | 1×5 connector                | TerminalBlock_Phoenix PT-1,5-5-3.5-H, 1×05 |
| LS1     | "Speaker/Mic 16R"            | 2-terminal transducer        | PinHeader_1×02 (modelled)                  |
| C1      | "22uF/50V"                   | polarized capacitor          | CP_Radial_D5.0mm_P2.00mm                   |
| R1      | "2.2k"                       | resistor                     | R_Axial_DIN0207                            |
| S1      | "Tueroeffner (door release)" | DPDT slide switch            | SW_CK_JS202011CQN_DPDT                     |
| S2      | "Sprechen/Hoeren (talk)"     | DPDT slide switch            | SW_CK_JS202011CQN_DPDT                     |
| WF26_K1 | "HJR-4102-N-12V"             | SPDT (1 Form C) signal relay | Relay_SPDT_HJR-4102                        |

Relay note (from the symbol's datasheet field): 6-pin DIL SPDT; coil on pins 5 & 8 (~320 Ω);
contact commons 1 & 12 tied; pin 6 = NO, pin 7 = NC; no internal flyback diode.

## Nets

J1 brings out five nets, **P1–P5** (J1 pin N → net P*N*). Two further nets, **K1_COM** and
**R1_BRIDGE**, are internal (not on the connector).

| Net          | Nodes                                              |
| ------------ | -------------------------------------------------- |
| P1           | J1.1, LS1.1, WF26_K1.8 (coil)                      |
| P2           | J1.2, S1.2, S1.5, S1.6                             |
| P3           | J1.3, S1.3, S1.4, S2.3, S2.4                       |
| P4           | J1.4, C1.2, R1.1, WF26_K1.5 (coil), WF26_K1.6 (NO) |
| P5           | J1.5, C1.1, LS1.2                                  |
| K1_COM       | WF26_K1.1 (COM), WF26_K1.12 (COM), S1.1            |
| R1_BRIDGE    | R1.2, S2.2, S2.5                                   |
| (no-connect) | S2.1, S2.6, WF26_K1.7 (NC)                         |

## Connectivity (component by component)

- **LS1** — between **P1** (pin 1) and **P5** (pin 2).
- **C1** — between **P5** (pin 1, +) and **P4** (pin 2).
- **R1** — between **P4** (pin 1) and **R1_BRIDGE** (pin 2).
- **WF26_K1** (relay):
  - Coil: pin 8 → **P1**; pin 5 → **P4**.
  - Contact common (pins 1 & 12, tied) → **K1_COM**.
  - NO contact (pin 6) → **P4**; NC contact (pin 7) → unconnected.
- **S1** (DPDT, *door release*): pins 2, 5, 6 → **P2**; pins 3, 4 → **P3**; pin 1 → **K1_COM**.
- **S2** (DPDT, *talk*): pins 2, 5 → **R1_BRIDGE**; pins 3, 4 → **P3**; pins 1, 6 → unconnected.
- **J1**: pins 1–5 → nets **P1–P5**.

### Topology summary

- Between **P1 and P5**: the transducer LS1.
- Between **P5 and P4**: capacitor C1.
- Between **P1 and P4**: the relay coil.
- Between **P4 and R1_BRIDGE**: resistor R1; **S2** connects R1_BRIDGE to **P3** (two S2 pins unused).
- **S1** connects **P2** to either **P3** or **K1_COM**; **K1_COM** is the relay contact common,
  whose NO side returns to **P4** and whose NC side is unconnected.
- **P3** is shared by both switches and the connector.

## Switch positions

A switch's position is **not** stored in the netlist (every pin maps to its net regardless of
state). The specific throw pins follow from the DPDT pole geometry.

- **S1 (door release) — measured:** common **P2** (pins 2 & 5).
  - **Pressed (closed):** **P2 ↔ P3** (pins 3, 4) — a **direct** short, **no resistor**; the
    door-opener trigger.
  - **Released (open/rest):** **P2 ↔ K1_COM** (pin 1). The other pole's throw on this side (pin 6)
    is P2 itself, so it makes no connection.
- **S2 (talk) — confirmed:** common **R1_BRIDGE** (pins 2 & 5).
  - **Released (not pressed):** **R1_BRIDGE ↔ NC** (the unconnected throws, pins 1 & 6) ⇒
    R1_BRIDGE open, R1's far end floats, no P4↔P3 path.
  - **Pressed:** **R1_BRIDGE ↔ P3** (pins 3, 4) ⇒ **P4 ↔ P3 through R1 (2.2 kΩ)**.

## External connection (not in this schematic)

An external, normally-open **ET (Etagenruf / door) button** series-interrupts the Etagenruf bus
line *outside* the handset, so that line reaches the bus only when pressed. **Which net / J1 pin
that corresponds to should be confirmed on the actual unit** — no specific net is asserted here.
