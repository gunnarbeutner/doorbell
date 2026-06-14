#!/usr/bin/env python3
"""Re-layout + fully wire wf26/wf26.kicad_sch with real inter-component wiring.

Builds a proper 5-rail bus: P1..P5 are horizontal trunk wires terminating at the
connector J1; every component pin is wired onto its rail with orthogonal drops and
junctions (NOT just a stub to a floating net-label). The two internal nodes
(K1_COM = relay COM <-> S2 talk throw, S1_COM = S1 commons <-> R1) are drawn as
direct wires between the components. Crossing wires without a junction are not
electrically connected (KiCad), so bus crossovers are safe.

Netlist is the authoritative one from DESIGN.md; DESIGN.md's relay "K2" == this
schematic's K1 (HJR-4102-N-12V), pin-for-pin.

Run:  .venv/bin/python wf26/wire_wf26.py
"""
import os, uuid
from kiutils.schematic import Schematic
from kiutils.items.schitems import Connection, LocalLabel, NoConnect, Text, Junction
from kiutils.items.common import Position, Effects, Stroke, Justify, Property

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "wf26.kicad_sch")
def U(): return str(uuid.uuid4())

# pin local geometry per lib symbol (rotation 0): number -> (lx, ly)
PINS = {
    "Device:Speaker": {"1": (-5.08, 0), "2": (-5.08, -2.54)},
    "Switch:SW_DPDT_x2": {"1": (5.08, 2.54), "2": (-5.08, 0), "3": (5.08, -2.54),
                          "4": (5.08, 2.54), "5": (-5.08, 0), "6": (5.08, -2.54)},
    "Device:R": {"1": (0, 3.81), "2": (0, -3.81)},
    "Device:C_Polarized": {"1": (0, 3.81), "2": (0, -3.81)},
    "wf26:HJR-4102-N-12V": {"1": (-7.62, 12.7), "5": (0, 12.7), "6": (7.62, 12.7),
                            "12": (-7.62, -12.7), "8": (0, -12.7), "7": (7.62, -12.7)},
    "Connector_Generic:Conn_01x05": {"1": (-5.08, 5.08), "2": (-5.08, 2.54),
                                     "3": (-5.08, 0), "4": (-5.08, -2.54), "5": (-5.08, -5.08)},
}
REF_LIB = {"LS1": "Device:Speaker", "C1": "Device:C_Polarized", "K1": "wf26:HJR-4102-N-12V",
           "S2": "Switch:SW_DPDT_x2", "S1": "Switch:SW_DPDT_x2", "R1": "Device:R",
           "J1": "Connector_Generic:Conn_01x05"}

# clean placement: (ref, unit) -> origin, all rotation 0, on 1.27 grid
ORIGIN = {
    ("LS1", 1): (74.93, 85.09),
    ("C1", 1):  (96.52, 88.9),
    ("K1", 1):  (133.35, 86.36),
    ("S2", 1):  (180.34, 80.01), ("S2", 2): (180.34, 97.79),
    ("S1", 1):  (96.52, 127.0),  ("S1", 2): (96.52, 146.05),
    ("R1", 1):  (156.21, 134.62),
    ("J1", 1):  (250.19, 109.22),
}

def unit_of(ref, pin):
    if REF_LIB[ref] == "Switch:SW_DPDT_x2" and pin in ("4", "5", "6"):
        return 2
    return 1

def P(ref, pin):
    lx, ly = PINS[REF_LIB[ref]][pin]
    ox, oy = ORIGIN[(ref, unit_of(ref, pin))]
    return (round(ox + lx, 2), round(oy - ly, 2))

# ---- builders --------------------------------------------------------------
WIRES, JUNCTS, LABELS, NCS = [], [], [], []
def w(*pts):
    # KiCad wires are single 2-point segments; split a polyline into segments.
    for a, b in zip(pts, pts[1:]):
        WIRES.append(Connection(type="wire",
            points=[Position(round(a[0], 2), round(a[1], 2)),
                    Position(round(b[0], 2), round(b[1], 2))],
            stroke=Stroke(width=0, type="default"), uuid=U()))
def j(x, y):
    JUNCTS.append(Junction(position=Position(round(x, 2), round(y, 2))))
def lbl(x, y, text, ang):
    e = Effects(); e.font.width = 1.0; e.font.height = 1.0
    LABELS.append(LocalLabel(text=text, position=Position(round(x, 2), round(y, 2), ang), effects=e, uuid=U()))
def nc(ref, pin):
    x, y = P(ref, pin); NCS.append(NoConnect(position=Position(x, y)))

# ---- horizontal bus trunks (net -> y), each spans xL..xR=J1 pin -------------
RAIL = {"P1": 104.14, "P2": 106.68, "P3": 109.22, "P4": 111.76, "P5": 114.30}
XR = 245.11
TRUNK_XL = {"P1": 67.31, "P2": 93.98, "P3": 99.06, "P4": 170.18, "P5": 63.5}
for net, y in RAIL.items():
    w((TRUNK_XL[net], y), (XR, y))
    lbl(TRUNK_XL[net], y, net, 180)            # name the rail at its left end

def tap(net, *via):
    """Wire from a pin, through optional bend points, ending on its rail (+junction)."""
    pts = list(via)
    end = (pts[-1][0], RAIL[net])
    pts.append(end)
    w(*pts)
    j(*end)

# P1 : LS1.2, C1.1(+), J1.1
tap("P1", P("LS1", "2"))                                   # straight down
tap("P1", P("C1", "1"), (93.98, P("C1", "1")[1]))          # jog left, then down
# P2 : C1.2(-), K1.8(coil), K1.7(NO), R1.1, J1.2
tap("P2", P("C1", "2"))
tap("P2", P("K1", "8"))
tap("P2", P("K1", "7"))
tap("P2", P("R1", "1"))                                     # up from below
# P3 : S2.3, S2.4, S1.3, S1.4, J1.3
# NB: pole-1 throws are pads 1<->3 swapped vs the generic symbol, so the U-numbered
# C&K footprint matches the real part (both poles' P3 throws on the same physical side).
tap("P3", P("S2", "3"), (190.5, P("S2", "3")[1]))
tap("P3", P("S2", "4"), (200.66, P("S2", "4")[1]))
tap("P3", P("S1", "3"), (104.14, P("S1", "3")[1]))         # jog right, up; clears S1.1 (now n/c)
w(P("S1", "4"), P("S1", "3"))                              # tie both S1 throws onto P3
# P4 : S2.1, S2.2, S2.5, J1.4
tap("P4", P("S2", "2"))                                     # down; passes through S2.5 pin
tap("P4", P("S2", "1"), (195.58, P("S2", "1")[1]))
j(*P("S1", "3"))   # S1.3: pin + P3 tap + the S1.4 tie
j(*P("S2", "5"))   # S2.5 sits mid-wire on the S2.2->P4 drop -> junction
# P5 : LS1.1, K1.5(coil), J1.5
tap("P5", P("LS1", "1"), (66.04, P("LS1", "1")[1]))        # jog left, down
tap("P5", P("K1", "5"), (133.35, 71.12), (146.05, 71.12))  # up, right of K1, down

# K1_COM : K1.1, K1.12, S2.6  (relay COM tie + run to talk throw)
c1, c12, c6 = P("K1", "1"), P("K1", "12"), P("S2", "6")
w(c1, (118.11, c1[1]), (118.11, c12[1]), c12)              # C-tie down the left of K1
w(c1, (c1[0], 66.04), (205.74, 66.04), (205.74, c6[1]), c6)  # over the top to the talk throw
j(*c1)                                                     # COM1: pin + tie + over-top
j(118.11, c12[1]); j(c12[0], c12[1])
lbl(118.11, 86.36, "K1_COM", 180)
# S1_COM : S1.2, S1.5, R1.2
s2b, s5b, r2 = P("S1", "2"), P("S1", "5"), P("R1", "2")
w(s2b, (86.36, s2b[1]), (86.36, s5b[1]), s5b)              # common bar on the left of S1
w((86.36, r2[1]), r2)                                      # branch across to R1
j(86.36, r2[1])
lbl(86.36, 132.0, "S1_COM", 180)

# no-connects: unused contacts
for ref, pin in (("S1", "1"), ("S1", "6"), ("K1", "6")):
    nc(ref, pin)

# reasonable THT footprints (all standard KiCad libs; pad numbers match the symbol pins)
FP = {
    "LS1": "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",  # 2 leads to off-board 16R speaker
    "C1":  "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm",                # 22uF/50V radial electrolytic
    "K1":  "Relay_THT:Relay_SPDT_HJR-4102",                         # exact part; pads 1/5/6/7/8/12
    "S2":  "Button_Switch_THT:SW_CK_JS202011CQN_DPDT_Straight",     # DPDT, pads 1-6
    "S1":  "Button_Switch_THT:SW_CK_JS202011CQN_DPDT_Straight",
    "R1":  "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal",  # 1/4W axial
    "J1":  "TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-5-3.5-H_1x05_P3.50mm_Horizontal",  # 5-way 3.5mm screw
}

# ---- apply to the schematic -------------------------------------------------
sch = Schematic.from_file(SCH)
TEXT = {  # ref -> (ref_dx,ref_dy, val_dx,val_dy, justify) clear of the wiring
    "LS1": (8.89, -2.54, -2.54, 6.35, "left"),
    "C1":  (5.08, -2.54, 5.08, 2.54, "left"),
    "K1":  (12.7, -1.27, 12.7, 1.27, "left"),
    "S2":  (-6.35, -2.54, -6.35, 2.54, "right"),
    "S1":  (10.16, -1.27, 10.16, 1.27, "left"),
    "R1":  (5.08, -2.54, 5.08, 2.54, "left"),
    "J1":  (8.89, -2.54, 8.89, 2.54, "left"),
}
for sym in sch.schematicSymbols:
    ref = next(p.value for p in sym.properties if p.key == "Reference")
    unit = sym.unit or 1
    ox, oy = ORIGIN[(ref, unit)]
    sym.position = Position(ox, oy, 0)
    sym.inBom = True; sym.onBoard = True; sym.dnp = False
    rdx, rdy, vdx, vdy, jst = TEXT[ref]
    for p in sym.properties:
        if p.key in ("Reference", "Value"):
            dx, dy = (rdx, rdy) if p.key == "Reference" else (vdx, vdy)
            p.position = Position(ox + dx, oy + dy, 0)
            p.showName = False
            p.effects = Effects(); p.effects.font.width = 1.0; p.effects.font.height = 1.0
            p.effects.justify = Justify(horizontally=jst)
        elif p.key in ("Datasheet", "Description"):
            p.showName = False
            p.effects = Effects(); p.effects.hide = True
    # assign the footprint (hidden property); add or update so re-runs stay idempotent
    fp = next((p for p in sym.properties if p.key == "Footprint"), None)
    if fp is None:
        fp = Property(key="Footprint", value="", position=Position(ox, oy, 0), effects=Effects())
        sym.properties.append(fp)
    fp.value = FP[ref]
    fp.position = Position(ox, oy, 0)
    fp.effects = Effects(); fp.effects.hide = True

sch.graphicalItems = WIRES
sch.junctions = JUNCTS
sch.labels = LABELS
sch.noConnects = NCS

# concise notes, bottom-left
sch.texts = []
NX, NY = 40.64, 158.0
LINES = [
    "WF26/G intercom handset - internal wiring (reverse-engineered)",
    "5-wire bus to TV20/S central unit:  J1.1..5 = lines P1..P5",
    "  P1 common/ref (speech+ring return)   P2 speech-TALK node",
    "  P3 speech-LISTEN / on-hook            P4 Tuerruf ring (~12V) + PTT common",
    "  P5 Etagenruf floor-call + speaker + relay-coil feed",
    "S2 rest: P4-P3 listen/on-hook (gong sounds).  S2 pressed: P4-K1_COM-(K1 NO)-P2 talk.",
    "S1 (OT) pressed: P2-R1(2.2k)-P3 door-release bridge.",
]
for i, t in enumerate(LINES):
    e = Effects(); e.font.width = 1.4; e.font.height = 1.4; e.justify = Justify(horizontally="left")
    sch.texts.append(Text(text=t, position=Position(NX, NY + i * 3.0, 0), effects=e, uuid=U()))

sch.to_file(SCH)
print(f"wires:{len(WIRES)} junctions:{len(JUNCTS)} labels:{len(LABELS)} no-connects:{len(NCS)} notes:{len(sch.texts)}")
