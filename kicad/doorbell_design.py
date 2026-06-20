"""Reference data for the doorbell placement check (check_pcb.py).

The KiCad files (`doorbell.kicad_sch` / `doorbell.kicad_pcb`) are the authoritative
source. This module holds the few constants `check_pcb.py` needs to verify the board:
  * REF -- internal-key -> KiCad refdes map
  * NOCONN, EDGE_FLUSH, EDGE_OVERHANG -- no-connect + placement spec
"""

# internal key -> KiCad reference designator
REF = {
    "U1":"U1","U2":"U2","U3":"U3","T1":"T1","J1":"J1","J2":"J2","K2":"K2","K3":"K3","K1":"K1",
    "Q2":"Q2","Q3":"Q3","Q1":"Q1",
    "D2":"D2","D3":"D3","D1":"D1","D_vbus":"D4","D_esd":"D5","OC1":"OK1","OC2":"OK2","OC3":"OK3","LED1":"D6",
    "D_tvs":"D10",   # VBUS surge clamp TVS
    "SW_OC1":"SW3","SW_OC2":"SW4","SW_OC3":"SW5",
    "D_oc1":"D7","D_oc2":"D8","D_oc3":"D9",   # opto LED reverse-voltage clamps (1N4148W anti-parallel)
    # resistors grouped by function (pairs adjacent): opto / relay drivers / MCU straps / USB CC / LED
    "R_lim1":"R1","R_lim2":"R2","R_em":"R3","R_g2":"R4","R_g3":"R5","R_g1":"R6",
    "R_pd2":"R7","R_pd3":"R8","R_pd1":"R9",
    "R_en":"R10","R_boot":"R11","R_io8":"R12","R_cc1":"R13","R_cc2":"R14","R_led":"R15","R_ot":"R16",
    "R_lim3":"R17","R_sda":"R18","R_scl":"R19","R_ce":"R20",
    "R_pu1":"R21","R_pu2":"R22","R_pu3":"R23",   # opto collector pull-ups to +3V3
    # audio front-end series resistors (one per transformer leg, both directions)
    "R_op":"R24","R_on":"R25","R_mp":"R26","R_mn":"R27",
    # --- audio codec (ES8311) support caps ---
    "C_dv":"C7","C_pv":"C8","C_av":"C9","C_avb":"C10","C_vref":"C11",
    "C_vmid":"C12","C_aref":"C13","C_op":"C14","C_on":"C15","C_mp":"C16","C_mn":"C17",
    "C_in":"C2","C_3v3":"C3","C_out":"C4","C_en":"C5","C_dec":"C6",
    "SW_boot":"SW1","SW_en":"SW2","F_vbus":"F1","FLAG5":"#FLG1","FLAG3":"#FLG2","FLAGG":"#FLG3",
}

# intentionally-unused pins -> No-Connect markers (schematic) / unconnected (PCB)
NOCONN = [("K2","2"),("K2","5"),("K2","6"),("K2","7"),
          ("K3","4"),("K3","7"),           # K3 pole-A NO (4) and pole-B NC (7) unused; pole-B NO (5) used for interlock
          # K1 = virtual PTT on pole A. NC (pin 2) open — not wired to P3 — so K1 de-energised
          # does not strap P4<->P3 and cannot block WF26's physical S2. Pole B (5/6/7) spare.
          ("K1","2"),("K1","5"),("K1","6"),("K1","7"),
          ("J1","A8"),("J1","B8"),
          # ES8311 (U3): all 20 pins + EP are used — no NC pins.
          ("T1","2"),("T1","5"),   # SM-LP-5001 winding center taps — unused for 1:1 isolation

          # U1 (C6-WROOM-1): remaining unused GPIOs.
          # Pads 4-5: GPIO4, GPIO5 (JTAG MTMS/MTDI) — spare
          # Pad 9: GPIO1 — spare
          # Pad 22: NC (module marking); Pad 23: GPIO15 (strapping, float)
          # Pads 24-25: GPIO17(U0RXD), GPIO16(U0TXD) — leave N/C
          # (pads 6/7/8/11/12/16/17 now = codec I2C/I2S; pads 18-20 = relay gates; pads 21/26/27 = opto outputs)
          ("U1","4"),("U1","5"),("U1","9"),
          ("U1","22"),("U1","23"),("U1","24"),("U1","25"),
]

# --- PCB edge constraints (verified by check_pcb.py against the KiCad board) ---
EDGE_FLUSH = {              # component ref -> board edge its outer face sits flush on / is offset from
    "J1": "left",          # USB-C receptacle on the left edge (overhangs, see EDGE_OVERHANG)
    "J2": "top",           # WF26 bus terminal (DB125-3.5-5P, pins 1-5 = P1-P5), top-edge strip
}
# component ref -> signed mm offset of its footprint bbox from the EDGE_FLUSH edge:
#   positive = overhangs past the edge (part pushed out); negative = set back inside it.
# J1 (USB4105): the courtyard overhangs the left edge 0.505 so the USB-C shell mouth protrudes and a
#   cable seats fully (front courtyard 4.18 minus the footprint's "PCB Edge" marker line 3.675).
# J2 (DB125-5P): the terminal courtyard sits 0.95 mm in from the top edge -- the screw/wire mouths
#   face out over it.
EDGE_OVERHANG = {"J1": 0.505, "J2": -0.95}

# --- mounting-hole flex keepout (MLCC crack avoidance) -------------------------
# Driving a fastener flexes the board around the hole; ceramic chip caps in that
# flex field crack at their solder fillets (often a latent, invisible failure).
# check_pcb.py enforces two rules per hole:
#   * no ceramic cap center within CAP_HOLE_HARD_MM (too close at any orientation), and
#   * a cap within CAP_HOLE_CAUTION_MM must sit TANGENTIALLY -- its pad-to-pad axis
#     across the radius, not pointing at the hole. A radial cap (axis within
#     CAP_HOLE_RADIAL_DEG of the radius) takes the full fillet-separating strain.
# Caps that are tangential within the caution band are reported as a note, not a fail.
MOUNTING_HOLES = ("H1", "H2")
CAP_HOLE_HARD_MM = 6.0
CAP_HOLE_CAUTION_MM = 9.0
CAP_HOLE_RADIAL_DEG = 30.0
CAP_HOLE_EXEMPT = ()        # non-ceramic caps (electrolytic/tantalum/film) -- flex-tolerant, e.g. ("C19",)
