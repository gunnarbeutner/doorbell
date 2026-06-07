"""Single source of truth for the doorbell V4 board.

Both `gen_schematic.py` and `gen_pcb.py` import this module, so the schematic and
the PCB always describe the same circuit. Edit here, then run `./build.sh`.
"""
import os

# internal key -> KiCad reference designator
REF = {
    "U1":"U1","U2":"U2","J1":"J1","J2":"J2","K1":"K1","K2":"K2","Q1":"Q1","Q2":"Q2",
    "D1":"D1","D2":"D2","D_vbus":"D4","D_esd":"D5","OC1":"OK1","OC2":"OK2","LED1":"D3",
    "R_lim1":"R1","R_em":"R2","R_g1":"R3","R_g2":"R4","R_pd1":"R5","R_pd2":"R6",
    "R_en":"R7","R_boot":"R8","R_cc1":"R9","R_cc2":"R10","R_led":"R11",
    "C_in":"C2","C_3v3":"C3","C_out":"C4","C_en":"C5","C_dec":"C6","R_io8":"R12",
    "R_lim2":"R13",
    "SW_boot":"SW1","SW_en":"SW2","FLAG5":"#FLG1","FLAG3":"#FLG2","FLAGG":"#FLG3",
}

# component table: internal key -> (symbol-lib nickname, symbol entry, value)
COMP = {
    "U1": ("PCM_Espressif", "ESP32-C3-MINI-1", "ESP32-C3-MINI-1"),
    "U2": ("PCM_JLCPCB-Power", "LDO, 3.3V, 1A", "SGM2212-3.3"),   # low-dropout; LCSC C3294699 (EXTRA_LCSC)
    "J1": ("Connector", "USB_C_Receptacle_USB2.0_16P", "USB-C (USB4085)"),
    "J2": ("Connector_Generic", "Conn_01x06", "WF26 (6-way screw)"),
    "K1": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),   # 4.5V coil: must-operate 3.6V, margin on the ~4.5V post-Schottky rail
    "K2": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),
    "Q1": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "Q2": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "D1": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D2": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D_vbus": ("PCM_JLCPCB-Diodes", "Schottky,SS14", "SS14"),                       # VBUS reverse-protection (LCSC C2480)
    "D_esd": ("PCM_JLCPCB-Diode-Packages", "Package, SRV05-4_C7420376", "SRV05-4"), # USB D+/D- ESD array (LCSC C7420376)
    "OC1": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "OC2": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "R_lim1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_lim2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),   # OC2's own LED limiter (unshared)
    "R_em": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_g1": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_g2": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_pd1": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pd2": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_en": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_boot": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_cc1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_cc2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_led": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_io8": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "C_in": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_3v3": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_out": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),    # SGM2212 wants COUT 1-10uF (was 22uF for AMS1117)
    "C_en": ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),
    "C_dec": ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),
    "LED1": ("PCM_JLCPCB-Diodes", "LED,0603,Red", "PWR"),
    "SW_boot": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "BOOT"),
    "SW_en": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "EN"),
    "FLAG5": ("power", "PWR_FLAG", ""),
    "FLAG3": ("power", "PWR_FLAG", ""),
    "FLAGG": ("power", "PWR_FLAG", ""),
}

# footprint per component (lib:name). Power flags carry no footprint.
FOOTPRINT = {
    "U1": "PCM_Espressif:ESP32-C3-MINI-1",
    "U2": "PCM_JLCPCB:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR",
    "J1": "Connector_USB:USB_C_Receptacle_GCT_USB4085",  # 2-row THT Type-C (LCSC C7095263)
    "J2": "TerminalBlock_4Ucon:TerminalBlock_4Ucon_1x06_P3.50mm_Vertical",
    "K1": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "K2": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "Q1": "PCM_JLCPCB:Q_SOT-23", "Q2": "PCM_JLCPCB:Q_SOT-23",
    "D1": "PCM_JLCPCB:D_SOD-123", "D2": "PCM_JLCPCB:D_SOD-123",
    "D_vbus": "PCM_JLCPCB:D_SMA",
    "D_esd": "PCM_JLCPCB:SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BL-1",
    "OC1": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm", "OC2": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm",
    "LED1": "PCM_JLCPCB:D_0603",
    "SW_boot": "PCM_JLCPCB:SW_TS-1088-AR02016", "SW_en": "PCM_JLCPCB:SW_TS-1088-AR02016",
}
for _r in ("R_lim1","R_lim2","R_em","R_g1","R_g2","R_pd1","R_pd2","R_en","R_boot","R_cc1","R_cc2","R_led","R_io8"):
    FOOTPRINT[_r] = "PCM_JLCPCB:R_0603"
for _c in ("C_in","C_3v3","C_out","C_en","C_dec"):
    FOOTPRINT[_c] = "PCM_JLCPCB:C_0603"

# FP override used by the schematic generator (stock symbols carry no footprint)
FP_OVERRIDE = {r: FOOTPRINT[r] for r in ("J1", "J2", "K1", "K2")}

# nets: name -> [(ref, pad), ...]    (G6K-2 relay: coil 1,8 | COM=3 NC=2 NO=4)
NETS = {
    # USB VBUS (raw, pre-Schottky): J1 power pins + Schottky anode + ESD-array clamp rail (VP).
    "VBUS": [("J1","A4"),("J1","B4"),("J1","A9"),("J1","B9"),("D_vbus","2"),("D_esd","5")],
    # +5V rail = everything downstream of the reverse-protection Schottky D4 (cathode).
    "+5V": [("D_vbus","1"),("C_in","1"),
            ("U2","3"),("K1","1"),("K2","1"),("D1","1"),("D2","1"),("FLAG5","1")],
    "+3V3": [("U2","2"),("U2","4"),("C_out","1"),("C_3v3","1"),("C_dec","1"),("U1","3"),
             ("R_en","1"),("R_boot","1"),("R_led","1"),("R_io8","2"),("FLAG3","1")],
    # U1 (ESP32-C3-MINI-1) has 21 GND pins + the EPAD (pad 49) -- ALL must tie to GND, not just pin 1.
    "GND": [("J1","A1"),("J1","B1"),("J1","A12"),("J1","B12"),("J1","SH"),
            ("C_in","2"),("C_out","2"),("C_3v3","2"),("C_dec","2"),("U2","1"),
            ("Q1","2"),("Q2","2"),("R_pd1","2"),("R_pd2","2"),("R_em","2"),("C_en","2"),
            ("R_cc1","2"),("R_cc2","2"),("LED1","1"),("SW_boot","2"),("SW_en","2"),
            ("D_esd","2"),("FLAGG","1")]
           + [("U1", str(_gp)) for _gp in
              (1,2,11,14,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53)],
    "USB_DM": [("J1","A7"),("J1","B7"),("U1","26"),("D_esd","3")],
    "USB_DP": [("J1","A6"),("J1","B6"),("U1","27"),("D_esd","1")],
    "USB_CC1": [("J1","A5"),("R_cc1","1")],
    "USB_CC2": [("J1","B5"),("R_cc2","1")],
    "EN": [("U1","8"),("R_en","2"),("C_en","1"),("SW_en","1")],
    "BOOT": [("U1","23"),("R_boot","2"),("SW_boot","1")],
    "GPIO8": [("U1","22"),("R_io8","1")],   # strapping pin: 10k pull-up (download-mode robustness)
    "GATE1_DRV": [("U1","18"),("R_g1","1")],
    "GATE1": [("R_g1","2"),("Q1","1"),("R_pd1","1")],
    "K1_DRAIN": [("Q1","3"),("K1","8"),("D1","2")],
    "GATE2_DRV": [("U1","19"),("R_g2","1")],
    "GATE2": [("R_g2","2"),("Q2","1"),("R_pd2","1")],
    "K2_DRAIN": [("Q2","3"),("K2","8"),("D2","2")],
    "P1": [("J2","1"),("R_lim1","2"),("R_lim2","2")],
    "P2": [("J2","2"),("K1","3")],
    "P3": [("J2","3"),("K1","4")],
    # Line 4 (Türruf) is BROKEN INTO the board for chime suppression: P4 = bus/TV20S side
    # (-> K2 COM), IN_P4 = WF26-handset side (-> K2 NC, -> OC1 sense, -> J2.6 jumper back to
    # the WF26's terminal 4). K2 at rest passes P4->IN_P4 (gong rings + OC1 senses); energised
    # it opens the line (gong silenced). This is the V3 series-break, restored on a 6-pin J2.
    "P4": [("J2","4"),("K2","3")],
    "IN_P4": [("K2","2"),("OC1","1"),("J2","6")],
    "P5": [("J2","5"),("OC2","1")],
    # opto LED limiters UNSHARED: each opto gets its own cathode->P1 resistor. The single
    # shared limiter let one ringing channel lift the common cathode node ~10.8 V and reverse-bias
    # the idle opto's LED beyond its 6 V VR; per-opto resistors keep each idle cathode near P1.
    "OC1_CATH": [("OC1","2"),("R_lim1","1")],
    "OC2_CATH": [("OC2","2"),("R_lim2","1")],
    "OC1_OUT": [("OC1","4"),("U1","20")],
    "OC2_OUT": [("OC2","4"),("U1","21")],
    "OC_EMIT": [("OC1","3"),("OC2","3"),("R_em","1")],
    "LED_A": [("R_led","2"),("LED1","2")],
}

# intentionally-unused pins -> No-Connect markers (schematic) / unconnected (PCB)
NOCONN = [("K1","2"),("K1","5"),("K1","6"),("K1","7"),
          ("K2","4"),("K2","5"),("K2","6"),("K2","7"),
          ("J1","A8"),("J1","B8"),
          ("D_esd","4"),("D_esd","6"),   # SRV05-4 unused I/O channels
          # U1: every pin is now accounted for -- nets, GND, or here. Unused GPIOs:
          ("U1","5"),("U1","6"),("U1","12"),("U1","13"),("U1","16"),("U1","30"),("U1","31"),
          # U1 manufacturer NC pins (NC1..NC14):
          ("U1","4"),("U1","7"),("U1","9"),("U1","10"),("U1","15"),("U1","17"),("U1","24"),
          ("U1","25"),("U1","28"),("U1","29"),("U1","32"),("U1","33"),("U1","34"),("U1","35")]

# placement grid (units of 2.54mm), shared cluster layout for schematic + PCB
GRID = {
    "J1": (16, 20), "R_cc1": (10, 24), "R_cc2": (10, 28), "R_io8": (74, 52),
    "D_vbus": (24, 16), "D_esd": (10, 16),
    "U2": (36, 20), "C_in": (30, 30), "C_out": (42, 30), "C_3v3": (48, 30), "C_dec": (54, 30),
    "FLAG5": (28, 14), "FLAG3": (48, 16), "FLAGG": (36, 36),
    "U1": (82, 46), "R_en": (60, 28), "C_en": (64, 34), "SW_en": (56, 32),
    "R_boot": (60, 64), "SW_boot": (56, 68),
    "R_g1": (104, 30), "Q1": (109, 30), "R_pd1": (109, 36), "D1": (116, 26), "K1": (126, 30),
    "R_g2": (104, 64), "Q2": (109, 64), "R_pd2": (109, 70), "D2": (116, 60), "K2": (126, 64),
    "OC1": (36, 82), "OC2": (36, 96), "R_lim1": (50, 85), "R_lim2": (50, 90), "R_em": (50, 96), "J2": (16, 86),
    "R_led": (66, 84), "LED1": (66, 90),
}

# footprint library nickname -> .pretty directory
_DOC = os.path.expanduser("~/Documents/KiCad/10.0/3rdparty/footprints")
_STOCK = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
FP_LIB_DIRS = {
    "PCM_JLCPCB": f"{_DOC}/com_github_CDFER_JLCPCB-Kicad-Library/JLCPCB.pretty",
    "PCM_Espressif": f"{_DOC}/com_github_espressif_kicad-libraries/Espressif.pretty",
    "Relay_SMD": f"{_STOCK}/Relay_SMD.pretty",
    "Connector_USB": f"{_STOCK}/Connector_USB.pretty",
    "TerminalBlock_4Ucon": f"{_STOCK}/TerminalBlock_4Ucon.pretty",
}

def footprint_path(libname):
    """'lib:name' -> absolute path of the .kicad_mod file."""
    nick, name = libname.split(":", 1)
    return os.path.join(FP_LIB_DIRS[nick], name + ".kicad_mod")


# --- PCB edge constraints (enforced by gen_pcb.py, verified by check_pcb.py) ---
ANTENNA_REF = "U1"          # module whose antenna keep-out must reach a board edge
EDGE_FLUSH = {              # component ref -> board edge its outer face sits flush on (or overhangs)
    "J1": "bottom",        # USB-C receptacle, middle of bottom edge (overhangs, see EDGE_OVERHANG)
    "J2": "top",           # WF26 spring terminal
    "U1": "left",          # ESP32 antenna edge (U1 rotated 90° CW -> antenna faces left)
}
# component ref -> mm it extends BEYOND its EDGE_FLUSH board edge (THT connector overhang).
# The board edge stays at the flush line; the part is pushed out past it so e.g. the USB-C
# shell sticks out and a cable seats fully without the PCB blocking it.
EDGE_OVERHANG = {"J1": 3.1, "U1": 5.4}   # U1: antenna depth 5.96mm - 0.5mm edge clearance -> pads stay 0.5mm off the edge
