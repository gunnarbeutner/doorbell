"""Reference data for the doorbell placement check (check_pcb.py).

The KiCad files (`doorbell.kicad_sch` / `doorbell.kicad_pcb`) are the authoritative
source -- refdes, nets and pinout live there, not here. This module holds only the
few constants `check_pcb.py` needs to verify the board:
  * EDGE_FLUSH, EDGE_OVERHANG -- connector edge-placement spec
  * MOUNTING_HOLES + CAP_HOLE_* -- MLCC flex keep-out around the fasteners

There is no hand-maintained no-connect list: intended no-connects carry KiCad's
`unconnected-(...)` net (from the schematic NC flags), so check_pcb.py flags only a pad
left with an *empty* net -- a pin dropped from the netlist. The schematic stays the one
source of NC intent.
"""

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
