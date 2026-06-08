"""Single source of truth for the doorbell V4 board.

Both `gen_schematic.py` and `gen_pcb.py` import this module, so the schematic and
the PCB always describe the same circuit. Edit here, then run `./build.sh`.
"""
import os

# internal key -> KiCad reference designator
REF = {
    "U1":"U1","U2":"U2","U3":"U3","T1":"T1","J1":"J1","J2":"J2","K1":"K1","K2":"K2","K3":"K3",
    "Q1":"Q1","Q2":"Q2","Q3":"Q3",
    "D1":"D1","D2":"D2","D3":"D3","D_vbus":"D4","D_esd":"D5","OC1":"OK1","OC2":"OK2","OC3":"OK3","LED1":"D6",
    # resistors grouped by function (pairs adjacent): opto / relay drivers / MCU straps / USB CC / LED
    "R_lim1":"R1","R_lim2":"R2","R_em":"R3","R_g1":"R4","R_g2":"R5","R_g3":"R6",
    "R_pd1":"R7","R_pd2":"R8","R_pd3":"R9",
    "R_en":"R10","R_boot":"R11","R_io8":"R12","R_cc1":"R13","R_cc2":"R14","R_led":"R15","R_ot":"R16",
    "R_lim3":"R17","R_sda":"R18","R_scl":"R19",
    # --- audio codec (ES8388) support caps ---
    "C_dv":"C7","C_pv":"C8","C_hv":"C9","C_av":"C10","C_avb":"C11",
    "C_vref":"C12","C_vmid":"C13","C_aref":"C14","C_lin":"C15","C_lout":"C16",
    "C_in":"C2","C_3v3":"C3","C_out":"C4","C_en":"C5","C_dec":"C6",
    "SW_boot":"SW1","SW_en":"SW2","FLAG5":"#FLG1","FLAG3":"#FLG2","FLAGG":"#FLG3",
}

# component table: internal key -> (symbol-lib nickname, symbol entry, value)
COMP = {
    "U1": ("PCM_Espressif", "ESP32-C6-WROOM-1", "ESP32-C6-WROOM-1-N8"),  # 28-pad + EPAD; pads 1-14 = left col, 15-28 = right col
    "U2": ("PCM_JLCPCB-Power", "LDO, 3.3V, 1A", "SGM2212-3.3"),   # low-dropout; LCSC C3294699 (EXTRA_LCSC)
    "U3": ("Audio", "ES8388", "ES8388"),                          # stereo audio codec (ADC+DAC); LCSC C365736 (EXTRA_LCSC). PROVISIONAL audio front-end.
    "T1": ("SM_LP_5001", "SM-LP-5001", "SM-LP-5001"),   # Bourns 600:600 1:1 line/audio iso xfmr; LCSC C7503474. Symbol+fp imported via easyeda2kicad -> kicad/lib_audio/
    "J1": ("Connector", "USB_C_Receptacle_USB2.0_16P", "USB-C (USB4085)"),
    "J2": ("Connector_Generic", "Conn_01x06", "WF26 (6-way screw)"),
    "K1": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),   # 4.5V coil: must-operate 3.6V, margin on the ~4.5V post-Schottky rail
    "K2": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),
    "K3": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),   # PTT relay — contacts TBD (audio circuit not yet defined)
    "Q1": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "Q2": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "Q3": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "D1": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D2": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D3": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D_vbus": ("PCM_JLCPCB-Diodes", "Schottky,SS14", "SS14"),                       # VBUS reverse-protection (LCSC C2480)
    "D_esd": ("PCM_JLCPCB-Diode-Packages", "Package, SRV05-4_C7420376", "SRV05-4"), # USB D+/D- ESD array (LCSC C7420376)
    "OC1": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "OC2": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "OC3": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),   # session-active sense (P2<->P5 WF26 coil energise) = "can we send audio"
    "R_lim1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_lim2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),   # OC2's own LED limiter (unshared)
    "R_lim3": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),   # OC3 session-sense limiter; VALUE TBD pending measured session voltage on P2<->P5
    "R_em": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_g1": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_g2": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_g3": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_pd1": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pd2": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pd3": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_en": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_boot": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_cc1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_cc2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_led": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_ot": ("PCM_JLCPCB-Resistors", "0603,2.2kΩ", "2.2k"),  # ÖT door-opener bridge series R; matches genuine WF26 R1 (2.2k, confirmed by colour bands red-red-red-gold)
    "R_io8": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_sda": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),   # I2C SDA pull-up to +3V3 (codec)
    "R_scl": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),   # I2C SCL pull-up to +3V3 (codec)
    "C_in": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_3v3": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_out": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),    # SGM2212 wants COUT 1-10uF (was 22uF for AMS1117)
    "C_en": ("PCM_JLCPCB-Capacitors", "0603,1uF", "1uF"),   # EN reset RC: Espressif spec value (was 100nF)
    "C_dec": ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),
    # --- ES8388 support network (values provisional, per datasheet typical app) ---
    "C_dv":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # DVDD decouple
    "C_pv":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # PVDD decouple
    "C_hv":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # HPVDD decouple
    "C_av":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # AVDD decouple
    "C_avb": ("PCM_JLCPCB-Capacitors", "0603,10uF",  "10uF"),   # AVDD bulk
    "C_vref":("PCM_JLCPCB-Capacitors", "0603,10uF",  "10uF"),   # VREF reservoir
    "C_vmid":("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # VMID
    "C_aref":("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # ADCVREF
    "C_lin": ("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # line-in AC coupling (listen)
    "C_lout":("PCM_JLCPCB-Capacitors", "0603,10uF",  "10uF"),   # line-out AC coupling (talk)
    "LED1": ("PCM_JLCPCB-Diodes", "LED,0603,Red", "PWR"),
    "SW_boot": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "BOOT"),
    "SW_en": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "EN"),
    "FLAG5": ("power", "PWR_FLAG", ""),
    "FLAG3": ("power", "PWR_FLAG", ""),
    "FLAGG": ("power", "PWR_FLAG", ""),
}

# footprint per component (lib:name). Power flags carry no footprint.
FOOTPRINT = {
    "U1": "PCM_Espressif:ESP32-C6-WROOM-1",
    "U2": "PCM_JLCPCB:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR",
    "U3": "Package_DFN_QFN:QFN-28-1EP_5x5mm_P0.5mm_EP3.35x3.35mm",   # ES8388 (no thermal vias in EPAD — respects no-via-in-pad)
    "T1": "SM_LP_5001:XFMR-SMD_SM-LP-5001E",   # Bourns SM-LP-5001: winding A=1,3 (CT=2) / winding B=4,6 (CT=5)
    "J1": "Connector_USB:USB_C_Receptacle_GCT_USB4085",  # 2-row THT Type-C (LCSC C7095263)
    "J2": "TerminalBlock_4Ucon:TerminalBlock_4Ucon_1x06_P3.50mm_Vertical",
    "K1": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "K2": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "K3": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "Q1": "PCM_JLCPCB:Q_SOT-23", "Q2": "PCM_JLCPCB:Q_SOT-23", "Q3": "PCM_JLCPCB:Q_SOT-23",
    "D1": "PCM_JLCPCB:D_SOD-123", "D2": "PCM_JLCPCB:D_SOD-123", "D3": "PCM_JLCPCB:D_SOD-123",
    "D_vbus": "PCM_JLCPCB:D_SMA",
    "D_esd": "PCM_JLCPCB:SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BL-1",
    "OC1": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm", "OC2": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm",
    "OC3": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm",
    "LED1": "PCM_JLCPCB:D_0603",
    "SW_boot": "PCM_JLCPCB:SW_TS-1088-AR02016", "SW_en": "PCM_JLCPCB:SW_TS-1088-AR02016",
}
for _r in ("R_lim1","R_lim2","R_lim3","R_em","R_g1","R_g2","R_g3","R_pd1","R_pd2","R_pd3","R_en","R_boot","R_cc1","R_cc2","R_led","R_io8","R_ot","R_sda","R_scl"):
    FOOTPRINT[_r] = "PCM_JLCPCB:R_0603"
for _c in ("C_in","C_3v3","C_out","C_en","C_dec",
           "C_dv","C_pv","C_hv","C_av","C_avb","C_vref","C_vmid","C_aref","C_lin","C_lout"):
    FOOTPRINT[_c] = "PCM_JLCPCB:C_0603"

# FP override used by the schematic generator (stock symbols carry no footprint)
FP_OVERRIDE = {r: FOOTPRINT[r] for r in ("J1", "J2", "K1", "K2", "U3", "T1")}

# nets: name -> [(ref, pad), ...]    (G6K-2 relay: coil 1,8 | COM=3 NC=2 NO=4)
NETS = {
    # USB VBUS (raw, pre-Schottky): J1 power pins + Schottky anode + ESD-array clamp rail (VP).
    "VBUS": [("J1","A4"),("J1","B4"),("J1","A9"),("J1","B9"),("D_vbus","2"),("D_esd","5")],
    # +5V rail = everything downstream of the reverse-protection Schottky D4 (cathode).
    "+5V": [("D_vbus","1"),("C_in","1"),
            ("U2","3"),("K1","1"),("K2","1"),("K3","1"),("D1","1"),("D2","1"),("D3","1"),("FLAG5","1")],
    "+3V3": [("U2","2"),("U2","4"),("C_out","1"),("C_3v3","1"),("C_dec","1"),("U1","2"),
             ("R_en","1"),("R_boot","1"),("R_led","1"),("R_io8","2"),("FLAG3","1"),
             # ES8388 supplies (DVDD/PVDD/HPVDD/AVDD) + their decoupling + I2C pull-ups
             ("U3","2"),("U3","3"),("U3","16"),("U3","17"),
             ("C_dv","1"),("C_pv","1"),("C_hv","1"),("C_av","1"),("C_avb","1"),
             ("R_sda","1"),("R_scl","1")],
    # U1 (ESP32-C6-WROOM-1) GND: castellated pads 1, 28 + EPAD (pad 29) -- all must tie to GND.
    "GND": [("J1","A1"),("J1","B1"),("J1","A12"),("J1","B12"),("J1","SH"),
            ("C_in","2"),("C_out","2"),("C_3v3","2"),("C_dec","2"),("U2","1"),
            ("Q1","2"),("Q2","2"),("Q3","2"),("R_pd1","2"),("R_pd2","2"),("R_pd3","2"),("R_em","2"),("C_en","2"),
            ("R_cc1","2"),("R_cc2","2"),("LED1","1"),("SW_boot","2"),("SW_en","2"),
            ("D_esd","2"),("FLAGG","1"),
            # ES8388 grounds (DGND/HPGND/AGND/EPAD) + CE addr-select to GND + ref-cap grounds + xfmr sec cold
            ("U3","4"),("U3","13"),("U3","18"),("U3","26"),("U3","29"),("T1","6"),
            ("C_vref","2"),("C_vmid","2"),("C_aref","2"),
            ("C_dv","2"),("C_pv","2"),("C_hv","2"),("C_av","2"),("C_avb","2")]
           + [("U1","1"),("U1","28"),("U1","29")],  # WROOM-1: GND pad 1 + pad 28 + EPAD (pad 29, multi-rect)
    "USB_DM": [("J1","A7"),("J1","B7"),("U1","13"),("D_esd","3")],   # C6: GPIO12/USB_D- on pad 13
    "USB_DP": [("J1","A6"),("J1","B6"),("U1","14"),("D_esd","1")],   # C6: GPIO13/USB_D+ on pad 14
    "USB_CC1": [("J1","A5"),("R_cc1","1")],
    "USB_CC2": [("J1","B5"),("R_cc2","1")],
    "EN": [("U1","3"),("R_en","2"),("C_en","1"),("SW_en","1")],        # C6 pad 3 = EN
    "BOOT": [("U1","15"),("R_boot","2"),("SW_boot","1")],  # GPIO9/BOOT on C6 pad 15
    "GPIO8": [("U1","10"),("R_io8","1")],  # C6 strapping pin GPIO8 on pad 10; 10k pull-up
    "GATE1_DRV": [("U1","18"),("R_g1","1")],   # GPIO20 / pad 18 (right col, north-facing)
    "GATE1": [("R_g1","2"),("Q1","1"),("R_pd1","1")],
    "K1_DRAIN": [("Q1","3"),("K1","8"),("D1","2")],
    "GATE2_DRV": [("U1","19"),("R_g2","1")],   # GPIO21 / pad 19
    "GATE2": [("R_g2","2"),("Q2","1"),("R_pd2","1")],
    "K2_DRAIN": [("Q2","3"),("K2","8"),("D2","2")],
    "GATE3_DRV": [("U1","26"),("R_g3","1")],   # GPIO3 / pad 26 (C6 right col) — PTT relay K3
    "GATE3": [("R_g3","2"),("Q3","1"),("R_pd3","1")],
    "K3_DRAIN": [("Q3","3"),("K3","8"),("D3","2")],
    "P1": [("J2","1"),("R_lim1","2"),("R_lim2","2"),("T1","1")],   # + audio xfmr winding-A end (tap across LS1 = P1/P5; CT pad 2 NC)
    # K3 = virtual PTT, emulating the WF26's Sprechen/Hören switch S2 on bus line 4:
    #   K3 COM=P4, NC->P3 (listen/idle, the DEFAULT — gate pull-down holds K3 off at boot),
    #   NO->P2 (talk, energised). To talk, firmware must FIRST energise K2 (break P4->IN_P4 so
    #   the handset's own S2 isn't strapping line4<->line3 in parallel and shorting P2<->P3),
    #   then toggle K3. Pole B (K3 pads 5/6/7) is spare/NC. See DESIGN.md "Audio (revisited)".
    "P2": [("J2","2"),("K1","3"),("K3","4"),("OC3","1")],
    # ÖT door-opener bridge goes through R_ot (2.2k) in series with K1's NO contact, matching
    # the genuine WF26 (its ÖT button bridges lines 2<->3 via R1=2.2k, NOT a dead short -- so it
    # only loads the speech pair instead of fully shorting it). K1 COM=P2; K1 NO -> R_ot -> P3.
    "P3": [("J2","3"),("R_ot","1"),("K3","2")],   # + K3 NC = PTT listen/idle strap (P4<->P3)
    "OT_BRIDGE": [("R_ot","2"),("K1","4")],
    # Line 4 (Türruf) is BROKEN INTO the board for chime suppression: P4 = bus/TV20S side
    # (-> K2 COM), IN_P4 = WF26-handset side (-> K2 NC, -> OC1 sense, -> J2.6 jumper back to
    # the WF26's terminal 4). K2 at rest passes P4->IN_P4 (gong rings + OC1 senses); energised
    # it opens the line (gong silenced). This is the V3 series-break, restored on a 6-pin J2.
    "P4": [("J2","4"),("K2","3"),("K3","3")],   # + K3 COM = PTT changeover common (bus line 4)
    "IN_P4": [("K2","2"),("OC1","1"),("J2","6")],
    "P5": [("J2","5"),("OC2","1"),("R_lim3","2"),("T1","3")],   # + OC3 session-sense limiter return + audio xfmr winding-A other end
    # opto LED limiters UNSHARED: each opto gets its own cathode->P1 resistor. The single
    # shared limiter let one ringing channel lift the common cathode node ~10.8 V and reverse-bias
    # the idle opto's LED beyond its 6 V VR; per-opto resistors keep each idle cathode near P1.
    "OC1_CATH": [("OC1","2"),("R_lim1","1")],
    "OC2_CATH": [("OC2","2"),("R_lim2","1")],
    "OC3_CATH": [("OC3","2"),("R_lim3","1")],   # OC3 LED cathode -> R_lim3 -> P5 (LED anode on P2)
    "OC1_OUT": [("OC1","4"),("U1","20")],   # GPIO22 / pad 20 (C6 right col)
    "OC2_OUT": [("OC2","4"),("U1","21")],   # GPIO23 / pad 21 (C6 right col)
    "OC3_OUT": [("OC3","4"),("U1","27")],   # GPIO2 / pad 27 (C6 right col, non-strapping) — session-active in
    "OC_EMIT": [("OC1","3"),("OC2","3"),("OC3","3"),("R_em","1")],
    "LED_A": [("R_led","2"),("LED1","2")],

    # === Audio codec (ES8388, U3) — PROVISIONAL half-duplex front-end (analog values bench-gated) ===
    # Tap: T1 primary across P1/P5 (directly across the WF26 transducer LS1 — confirmed from
    # wf26.kicad_sch). Direction is switched by K3 POLE B, tracking pole A's PTT: idle/listen ties
    # the xfmr secondary -> LIN1 (capture); energised/talk ties it -> LOUT1 (playback). One codec
    # channel (L) used; R channel + 2nd outputs left NC.
    "I2S_MCLK": [("U3","1"),("U1","16")],    # GPIO18 (pad 16)
    "I2S_BCLK": [("U3","5"),("U1","17")],    # GPIO19 (pad 17)
    "I2S_WS":   [("U3","7"),("U1","12")],    # LRCK <-> GPIO11 (pad 12)
    "I2S_DOUT": [("U3","6"),("U1","11")],    # DSDIN <- ESP (GPIO10, pad 11) — playback data
    "I2S_DIN":  [("U3","8"),("U1","8")],     # ASDOUT -> ESP (GPIO0, pad 8) — capture data
    "I2C_SDA":  [("U3","27"),("U1","6"),("R_sda","2")],   # CDATA <-> GPIO6 (pad 6)
    "I2C_SCL":  [("U3","28"),("U1","7"),("R_scl","2")],   # CCLK <-> GPIO7 (pad 7)
    "ES_VREF":    [("U3","10"),("C_vref","1")],
    "ES_VMID":    [("U3","20"),("C_vmid","1")],
    "ES_ADCVREF": [("U3","19"),("C_aref","1")],
    "ES_LIN1":    [("U3","24"),("C_lin","2")],     # LIN1 <- listen coupling
    "ES_LOUT1":   [("U3","12"),("C_lout","2")],    # LOUT1 -> talk coupling
    "AUDIO_SEC":    [("T1","4"),("K3","6")],       # xfmr winding-B end -> K3 pole-B COM (other end T1.6 -> GND; CT pad 5 NC)
    "AUDIO_LISTEN": [("K3","5"),("C_lin","1")],    # K3 NC(B): secondary -> LIN1 (capture)
    "AUDIO_TALK":   [("K3","7"),("C_lout","1")],   # K3 NO(B): LOUT1 -> secondary (playback)
}

# intentionally-unused pins -> No-Connect markers (schematic) / unconnected (PCB)
NOCONN = [("K1","2"),("K1","5"),("K1","6"),("K1","7"),
          ("K2","4"),("K2","5"),("K2","6"),("K2","7"),
          # K3 = virtual PTT, both poles now used: pole A (2/3/4) = P4 PTT changeover;
          # pole B (5/6/7) = codec talk/listen analog switch. No spare K3 contacts.
          ("J1","A8"),("J1","B8"),
          ("D_esd","4"),("D_esd","6"),   # SRV05-4 unused I/O channels
          # ES8388 (U3): unused R-channel / 2nd outputs + true-NC die pads.
          #   11=ROUT1 14=ROUT2 15=LOUT2 21=RIN2 22=LIN2 23=RIN1 (symbol pins -> NC markers);
          #   9,25 = NC pads present on the QFN but absent from the symbol (PCB-only, covered here).
          ("U3","11"),("U3","14"),("U3","15"),("U3","21"),("U3","22"),("U3","23"),
          ("U3","9"),("U3","25"),
          ("T1","2"),("T1","5"),   # SM-LP-5001 winding center taps — unused for 1:1 isolation

          # U1 (C6-WROOM-1): remaining unused GPIOs.
          # Pads 4-5: GPIO4, GPIO5 (JTAG MTMS/MTDI) — spare
          # Pad 9: GPIO1 — spare
          # Pad 22: NC (module marking); Pad 23: GPIO15 (strapping, float)
          # Pads 24-25: GPIO17(U0RXD), GPIO16(U0TXD) — leave N/C
          # (pads 6/7/8/11/12/16/17 now = codec I2C/I2S; pad 27 = OC3_OUT)
          ("U1","4"),("U1","5"),("U1","9"),
          ("U1","22"),("U1","23"),("U1","24"),("U1","25")]

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
    "R_g3": (104, 98), "Q3": (109, 98), "R_pd3": (109, 104), "D3": (116, 94), "K3": (126, 98),
    "OC1": (36, 82), "OC2": (36, 96), "R_lim1": (50, 85), "R_lim2": (50, 90), "R_em": (50, 96), "J2": (16, 86),
    "OC3": (36, 110), "R_lim3": (50, 110),   # session-sense opto + limiter (schematic placement; reorganise later)
    # --- audio codec cluster (schematic canvas; reorganise later) ---
    "U3": (90, 90), "T1": (70, 110),
    "C_dv": (78, 80), "C_pv": (82, 80), "C_hv": (86, 80), "C_av": (90, 80), "C_avb": (94, 80),
    "C_vref": (98, 88), "C_vmid": (98, 92), "C_aref": (98, 96),
    "C_lin": (78, 104), "C_lout": (82, 104), "R_sda": (98, 82), "R_scl": (98, 84),
    "R_led": (66, 84), "LED1": (66, 90),
}

# footprint library nickname -> .pretty directory
_HERE = os.path.dirname(os.path.abspath(__file__))
_DOC = os.path.expanduser("~/Documents/KiCad/10.0/3rdparty/footprints")
_STOCK = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
FP_LIB_DIRS = {
    "PCM_JLCPCB": f"{_DOC}/com_github_CDFER_JLCPCB-Kicad-Library/JLCPCB.pretty",
    "PCM_Espressif": f"{_DOC}/com_github_espressif_kicad-libraries/Espressif.pretty",
    "Relay_SMD": f"{_STOCK}/Relay_SMD.pretty",
    "Connector_USB": f"{_STOCK}/Connector_USB.pretty",
    "TerminalBlock_4Ucon": f"{_STOCK}/TerminalBlock_4Ucon.pretty",
    "Package_DFN_QFN": f"{_STOCK}/Package_DFN_QFN.pretty",   # ES8388 QFN-28
    "SM_LP_5001": f"{_HERE}/lib_audio/SM_LP_5001.pretty",    # Bourns SM-LP-5001 (easyeda2kicad import, C7503474)
    "Fiducial": f"{_STOCK}/Fiducial.pretty",   # PCBA optical reference marks (added in gen_pcb.py)
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
    "U1": "bottom",        # ESP32-C6-WROOM-1: antenna faces south, flush to bottom edge
}
# component ref -> mm it extends BEYOND its EDGE_FLUSH board edge (THT connector overhang).
# The board edge stays at the flush line; the part is pushed out past it so e.g. the USB-C
# shell sticks out and a cable seats fully without the PCB blocking it.
EDGE_OVERHANG = {"J1": 3.1}   # J1 shell protrudes 3.1 mm south of board edge for cable insertion
