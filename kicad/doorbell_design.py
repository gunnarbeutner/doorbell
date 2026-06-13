"""Single source of truth for the doorbell V4 board.

Both `gen_schematic.py` and `gen_pcb.py` import this module, so the schematic and
the PCB always describe the same circuit. Edit here, then run `./build.sh`.
"""
import os

# drawing-sheet title block, shared by the schematic and PCB generators
# (each generator fills the date field with its generation date)
TITLE = "Doorbell controller (Klingel V4)"
REVISION = "V4.1"
COMPANY = "Gunnar Beutner"

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

# component table: internal key -> (symbol-lib nickname, symbol entry, value)
COMP = {
    "U1": ("PCM_Espressif", "ESP32-C6-WROOM-1", "ESP32-C6-WROOM-1-N8"),  # 28-pad + EPAD; pads 1-14 = left col, 15-28 = right col
    "U2": ("PCM_JLCPCB-Power", "LDO, 3.3V, 1A", "SGM2212-3.3"),   # low-dropout; LCSC C3294699 (LCSC dict below)
    "U3": ("ES8311", "ES8311", "ES8311"),                         # mono audio codec (ADC+DAC); LCSC C962342. Symbol+fp via easyeda2kicad -> kicad/lib_audio/. PROVISIONAL front-end.
    "T1": ("SM_LP_5001", "SM-LP-5001", "SM-LP-5001"),   # Bourns 600:600 1:1 line/audio iso xfmr; LCSC C7503474. Symbol+fp imported via easyeda2kicad -> kicad/lib_audio/
    "J1": ("Connector", "USB_C_Receptacle_USB2.0_16P", "USB-C (USB4105)"),
    "J2": ("Connector_Generic", "Conn_01x06", "WF26 (6-way screw)"),
    "SW_OC1": ("cas220tb1", "CAS-220TB1", "CAS-220TB1"),
    "SW_OC2": ("cas220tb1", "CAS-220TB1", "CAS-220TB1"),
    "SW_OC3": ("cas220tb1", "CAS-220TB1", "CAS-220TB1"),
    "K2": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),   # 4.5V coil: must-operate 3.6V, margin on the ~4.5V post-Schottky rail
    "K3": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),
    "K1": ("Relay", "G6K-2", "G6K-2F-Y 4.5V"),   # PTT relay — contacts TBD (audio circuit not yet defined)
    "Q2": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "Q3": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "Q1": ("PCM_JLCPCB-Transistors", "NMOS,2N7002", "2N7002"),
    "D2": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D3": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D1": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),
    "D_vbus": ("PCM_JLCPCB-Diodes", "Schottky,SS14", "SS14"),                       # VBUS reverse-protection (LCSC C2480)
    "D_esd": ("TPD2S017", "TPD2S017DBVR", "TPD2S017"),   # USB D+/D- two-stage flow-through ESD clamp (LCSC C880115); symbol via easyeda2kicad -> kicad/lib_usb/
    "D_tvs": ("PCM_JLCPCB-Diodes", "TVS-Uni,SMF5.0A", "SMF5.0A"),   # VBUS 5V TVS (LCSC C19077497): the TPD2S017's VCC is only a bias pin, so VBUS gets its own clamp
    "D_oc1": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),  # OC1 LED reverse-voltage clamp
    "D_oc2": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),  # OC2 LED reverse-voltage clamp
    "D_oc3": ("PCM_JLCPCB-Diodes", "Switching,1N4148W", "1N4148W"),  # OC3 LED reverse-voltage clamp
    "OC2": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "OC3": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),
    "OC1": ("PCM_JLCPCB-Optocouplers", "LTV-217-B-G", "LTV-217 (PC817)"),   # session-active sense: anode=P5 (coil feed), cathode->R_lim3->P2 (coil return); conducts when K1_WF26 energised
    "R_lim1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_lim2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),   # OC3's own LED limiter (unshared)
    "R_lim3": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),   # OC1 session-sense cathode limiter (P5->LED->R_lim3->P2); VALUE TBD pending measured P5-P2 session voltage
    "R_em": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_g2": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_g3": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_g1": ("PCM_JLCPCB-Resistors", "0603,100Ω", "100"),
    "R_pd2": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pd3": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pd1": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_en": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_boot": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_cc1": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_cc2": ("PCM_JLCPCB-Resistors", "0603,5.1kΩ", "5.1k"),
    "R_led": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_ot": ("PCM_JLCPCB-Resistors", "0603,2.2kΩ", "2.2k"),  # ÖT door-opener bridge series R; matches genuine WF26 R1 (2.2k, confirmed by colour bands red-red-red-gold)
    "R_io8": ("PCM_JLCPCB-Resistors", "0603,3.3kΩ", "3.3k"),
    "R_sda": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),   # I2C SDA pull-up to +3V3 (codec)
    "R_scl": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),   # I2C SCL pull-up to +3V3 (codec)
    "R_ce":  ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),   # CE I2C address pull-down to GND → addr 0x18
    # Opto collector pull-ups: the sense level no longer depends on the ESP32's weak
    # internal ~45k pull-up being enabled in firmware (VERIFICATION.md finding 1).
    # 10k + the 1k shared emitter R gives V_OL ≈ 0.4 V — still well under V_IL 0.825 V.
    "R_pu1": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pu2": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_pu3": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    # Audio front-end fixes (VERIFICATION.md findings 2+3):
    # - R_op/R_on (1k, DAC legs): the idle DAC's low output impedance shunted the
    #   shared T1 winding and shelved RECEIVED audio ~5-12 dB toward 4 kHz; 1k per
    #   leg also drops the TX high-pass corner (0.5uF eff. into the 16R-dominated
    #   line) from >1 kHz to ~160 Hz. TX level loss is irrelevant: the line expects
    #   speaker-as-mic millivolts.
    # - R_mp/R_mn (10k, mic legs): divider against the ES8311's 6k differential
    #   input (6/26 = -12.7 dB). The PGA cannot attenuate (min 0 dB, FS 2 Vrms);
    #   a loud gong on the 16R speaker pair (~2.8-5.7 Vrms) clipped the ADC and
    #   brushed the pins' absolute-max excursion. Now <=1.4 Vrms at the pins.
    "R_op": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_on": ("PCM_JLCPCB-Resistors", "0603,1kΩ", "1k"),
    "R_mp": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "R_mn": ("PCM_JLCPCB-Resistors", "0603,10kΩ", "10k"),
    "C_in": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_3v3": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),
    "C_out": ("PCM_JLCPCB-Capacitors", "0603,10uF", "10uF"),    # SGM2212 wants COUT 1-10uF (was 22uF for AMS1117)
    "C_en": ("PCM_JLCPCB-Capacitors", "0603,1uF", "1uF"),   # EN reset RC: Espressif spec value (was 100nF)
    "C_dec": ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),
    # --- ES8311 support network (values provisional, per datasheet typical app) ---
    "C_dv":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # DVDD decouple
    "C_pv":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # PVDD decouple
    "C_av":  ("PCM_JLCPCB-Capacitors", "0603,100nF", "100nF"),  # AVDD decouple
    "C_avb": ("PCM_JLCPCB-Capacitors", "0603,10uF",  "10uF"),   # AVDD bulk
    "C_vref":("PCM_JLCPCB-Capacitors", "0603,10uF",  "10uF"),   # DACVREF reservoir
    "C_vmid":("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # VMID
    "C_aref":("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # ADCVREF
    "C_op":  ("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # OUTP -> xfmr sec coupling
    "C_on":  ("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # OUTN -> xfmr sec coupling
    "C_mp":  ("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # xfmr sec -> MIC1P coupling
    "C_mn":  ("PCM_JLCPCB-Capacitors", "0603,1uF",   "1uF"),    # xfmr sec -> MIC1N coupling
    "LED1": ("PCM_JLCPCB-Diodes", "LED,0603,Red", "PWR"),
    "F_vbus": ("Device", "Fuse", "1A fast (466)"),   # Littelfuse 0466001.NRHF NANO2 1206; VBUS fail-safe ahead of the protection diodes
    "SW_boot": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "BOOT"),
    "SW_en": ("PCM_JLCPCB-Connectors_Buttons", "Tactile Button, 160gf, 12V, 50mA, 4.0mm", "EN"),
    "FLAG5": ("power", "PWR_FLAG", ""),
    "FLAG3": ("power", "PWR_FLAG", ""),
    "FLAGG": ("power", "PWR_FLAG", ""),
}

# LCSC part numbers (internal key -> C-number) for parts whose symbol carries no usable
# "LCSC" field (stock KiCad / easyeda symbols) or whose JLCPCB-library symbol is a stand-in
# for a different part. gen_schematic.py embeds these in the schematic (they override the
# symbol's own LCSC field); jlcpcb_files.py derives its BOM overrides from this dict.
# Parts not listed here get their LCSC number from the JLCPCB library symbol itself.
LCSC = {
    "J1": "C3025063",    # GCT USB4105-GF-A-060 USB-C receptacle (single-row SMD pads, THT shell
                         # stakes; -060 = 0.60mm stake length — same body/footprint as -120)
    "J2": "C5290323",    # DORABO DB125-3.5-6P-GN-S screw terminal (THT)
    "K1": "C397193",     # Omron G6K-2F-Y-TR DC4.5 DPDT relay (4.5V coil; must-operate 3.6V, more VBUS-sag margin)
    "K2": "C397193",
    "K3": "C397193",
    "U1": "C5366877",    # ESP32-C6-WROOM-1-N8 (8MB, PCB antenna)
    "U2": "C3294699",    # SGM2212-3.3 low-dropout LDO (symbol is an AMS1117 stand-in -> override its LCSC)
    "U3": "C962342",     # ES8311 mono audio codec (QFN-20)
    "T1": "C7503474",    # Bourns SM-LP-5001 600:600 audio isolation transformer
    "SW_OC1": "C2921541",   # NIDEC CAS-220TB1 DPDT slide switch
    "SW_OC2": "C2921541",
    "SW_OC3": "C2921541",
    "D_esd": "C880115",     # TI TPD2S017DBVR (easyeda2kicad symbol carries the field too; explicit for the BOM overrides)
    "F_vbus": "C151135",    # Littelfuse 0466001.NRHF 1A fast 1206 fuse (stock KiCad symbol carries no LCSC field)
    # --- The remaining parts' numbers used to live only in the JLCPCB-library symbols'
    #     "LCSC" field; listed explicitly so the dict is the complete single source
    #     (gen_pcb.py stamps them onto the footprints, jlcpcb_files.py onto the BOM).
    # 0603 passives (JLCPCB basic parts)
    "R_g1": "C22775", "R_g2": "C22775", "R_g3": "C22775",            # 100R
    "R_em": "C21190", "R_led": "C21190", "R_op": "C21190", "R_on": "C21190",  # 1k
    "R_ot": "C4190",                                                  # 2.2k
    "R_io8": "C22978",                                                # 3.3k
    "R_lim1": "C23186", "R_lim2": "C23186", "R_lim3": "C23186",
    "R_cc1": "C23186", "R_cc2": "C23186",                             # 5.1k
    "R_pd1": "C25804", "R_pd2": "C25804", "R_pd3": "C25804",
    "R_en": "C25804", "R_boot": "C25804", "R_sda": "C25804",
    "R_scl": "C25804", "R_ce": "C25804", "R_pu1": "C25804",
    "R_pu2": "C25804", "R_pu3": "C25804", "R_mp": "C25804", "R_mn": "C25804",  # 10k
    "C_dec": "C14663", "C_dv": "C14663", "C_pv": "C14663", "C_av": "C14663",  # 100nF
    "C_en": "C15849", "C_vmid": "C15849", "C_aref": "C15849",
    "C_op": "C15849", "C_on": "C15849", "C_mp": "C15849", "C_mn": "C15849",   # 1uF
    "C_in": "C19702", "C_out": "C19702", "C_3v3": "C19702",
    "C_avb": "C19702", "C_vref": "C19702",                            # 10uF
    # semiconductors / misc
    "Q1": "C8545", "Q2": "C8545", "Q3": "C8545",                      # 2N7002
    "D1": "C81598", "D2": "C81598", "D3": "C81598",
    "D_oc1": "C81598", "D_oc2": "C81598", "D_oc3": "C81598",          # 1N4148W
    "D_vbus": "C2480",                                                # SS14
    "D_tvs": "C19077497",                                             # SMF5.0A
    "LED1": "C2286",                                                  # power LED
    "OC1": "C115450", "OC2": "C115450", "OC3": "C115450",             # LTV-217
    "SW_boot": "C720477", "SW_en": "C720477",                         # TS-1088 tactile
}
# symbols borrowed from a *different* part (value/LCSC overridden above): their MPN/datasheet
# fields describe the stand-in, not the real part -> gen_schematic.py must not embed them.
SYMBOL_STANDIN = {"U2"}

# one-line role of every part, embedded as the schematic symbol's "Description" field
PURPOSE = {
    "U1": "Wi-Fi/BLE MCU (ESPHome); native USB on GPIO12/13",
    "U2": "5V->3.3V LDO; low dropout rides out WiFi-TX VBUS sag",
    "U3": "Mono audio codec (ADC+DAC): I2S data + I2C control; half-duplex intercom audio",
    "T1": "600:600 1:1 audio isolation transformer; winding A across bus P1/P5, winding B to codec",
    "J1": "USB-C receptacle: 5V power + native-USB programming",
    "J2": "WF26 intercom bus tap: P1-P3, P4/IN_P4 (line-4 break-in), P5",
    "K1": "Virtual-PTT relay: bridges IN_P4<->P2 (talk); gate drive runs through K3's interlock contact",
    "K2": "Door-opener relay: bridges P2<->P3 via R16, emulating the WF26 ÖT button",
    "K3": "Chime-suppress relay: breaks line 4 (IN_P4->P4); pole B interlocks K1's gate",
    "Q1": "K1 coil driver, low-side NMOS",
    "Q2": "K2 coil driver, low-side NMOS",
    "Q3": "K3 coil driver, low-side NMOS",
    "D1": "K1 coil flyback diode",
    "D2": "K2 coil flyback diode",
    "D3": "K3 coil flyback diode",
    "D_vbus": "VBUS reverse-polarity protection Schottky (~0.45V drop to +5V rail)",
    "D_esd": "USB D+/D- ESD clamp, two-stage flow-through (TPD2S017); VCC biased from VBUS",
    "D_tvs": "VBUS surge/ESD clamp TVS (5V working voltage)",
    "F_vbus": "VBUS fuse (1A fast): fail-safe for a clamping D10 / board fault; ~2x headroom over WiFi-TX+relay peaks",
    "D_oc1": "OK1 LED reverse-voltage clamp, anti-parallel (limits reverse V to ~0.7V)",
    "D_oc2": "OK2 LED reverse-voltage clamp, anti-parallel (limits reverse V to ~0.7V)",
    "D_oc3": "OK3 LED reverse-voltage clamp, anti-parallel (limits reverse V to ~0.7V)",
    "OC1": "Session-active sense opto: conducts when the WF26 talk relay is energised (P5->P2)",
    "OC2": "House-bell (Türruf) sense opto across P1<->IN_P4",
    "OC3": "Apartment-bell (Etagenruf) sense opto across P1<->P5",
    "SW_OC1": "OK1 polarity selector (DPDT slide flips LED feed + return together)",
    "SW_OC2": "OK2 polarity selector (DPDT slide flips LED feed + return together)",
    "SW_OC3": "OK3 polarity selector (DPDT slide flips LED feed + return together)",
    "R_lim1": "OK2 LED current limiter (per-channel, unshared to avoid cross-talk)",
    "R_lim2": "OK3 LED current limiter (per-channel, unshared to avoid cross-talk)",
    "R_lim3": "OK1 LED current limiter (value TBD pending measured session voltage)",
    "R_em": "Shared opto emitter resistor to GND (uA only)",
    "R_g1": "K1 gate series resistor",
    "R_g2": "K2 gate series resistor",
    "R_g3": "K3 gate series resistor",
    "R_pd1": "K1 gate pull-down: relay stays off while the GPIO floats at boot",
    "R_pd2": "K2 gate pull-down: relay stays off while the GPIO floats at boot",
    "R_pd3": "K3 gate pull-down: relay stays off while the GPIO floats at boot",
    "R_en": "EN pull-up",
    "R_boot": "BOOT (GPIO9) pull-up",
    "R_io8": "GPIO8 strapping pull-up",
    "R_cc1": "USB-C CC1 sink pull-down (advertises 5V device)",
    "R_cc2": "USB-C CC2 sink pull-down (advertises 5V device)",
    "R_led": "Power-LED current limiter",
    "R_ot": "ÖT bridge series R; matches the WF26's genuine 2.2k button resistor",
    "R_sda": "I2C SDA pull-up (codec control bus)",
    "R_scl": "I2C SCL pull-up (codec control bus)",
    "R_ce": "ES8311 CE address pull-down -> I2C addr 0x18",
    "R_pu1": "OC1 collector pull-up: defined sense level without the ESP32's internal pull-up",
    "R_pu2": "OC2 collector pull-up: defined sense level without the ESP32's internal pull-up",
    "R_pu3": "OC3 collector pull-up: defined sense level without the ESP32's internal pull-up",
    "R_op": "DAC OUTP series R: keeps the idle DAC from shunting RX audio; lowers TX HPF corner",
    "R_on": "DAC OUTN series R: keeps the idle DAC from shunting RX audio; lowers TX HPF corner",
    "R_mp": "MIC1P series R: -12.7dB divider vs the 6k input, headroom for loud gongs (PGA min 0dB)",
    "R_mn": "MIC1N series R: -12.7dB divider vs the 6k input, headroom for loud gongs (PGA min 0dB)",
    "C_in": "LDO input capacitor",
    "C_3v3": "ESP32 module bulk decoupling (at U1 pad 2)",
    "C_out": "LDO output capacitor",
    "C_en": "EN reset RC (Espressif-spec 1uF)",
    "C_dec": "ESP32 module HF decoupling",
    "C_dv": "ES8311 DVDD decoupling",
    "C_pv": "ES8311 PVDD decoupling",
    "C_av": "ES8311 AVDD decoupling",
    "C_avb": "ES8311 AVDD bulk",
    "C_vref": "ES8311 DACVREF reservoir",
    "C_vmid": "ES8311 VMID bypass",
    "C_aref": "ES8311 ADCVREF bypass",
    "C_op": "DAC OUTP AC-coupling to T1 secondary",
    "C_on": "DAC OUTN AC-coupling to T1 secondary",
    "C_mp": "T1 secondary -> MIC1P AC-coupling",
    "C_mn": "T1 secondary -> MIC1N AC-coupling",
    "LED1": "Power-on indicator LED (+3V3)",
    "SW_boot": "BOOT button (hold through reset -> USB download mode)",
    "SW_en": "Reset button",
}

# footprint per component (lib:name). Power flags carry no footprint.
FOOTPRINT = {
    "U1": "PCM_Espressif:ESP32-C6-WROOM-1",
    "U2": "PCM_JLCPCB:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR",
    "U3": "ES8311:WQFN-20_L3.0-W3.0-P0.40-BL-EP1.7",   # ES8311 mono codec (easyeda2kicad import, C962342)
    "T1": "SM_LP_5001:XFMR-SMD_SM-LP-5001E",   # Bourns SM-LP-5001: winding A=1,3 (CT=2) / winding B=4,6 (CT=5)
    "J1": "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",  # SMD Type-C, THT shell stakes (LCSC C3025063); -xx-A footprint covers all stake lengths
    "J2": "TerminalBlock_4Ucon:TerminalBlock_4Ucon_1x06_P3.50mm_Vertical",
    "SW_OC1": "cas220tb1:SW-SMD_NIDEC_CAS-220XBX",
    "SW_OC2": "cas220tb1:SW-SMD_NIDEC_CAS-220XBX",
    "SW_OC3": "cas220tb1:SW-SMD_NIDEC_CAS-220XBX",
    "K2": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "K3": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "K1": "Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y",
    "Q2": "PCM_JLCPCB:Q_SOT-23", "Q3": "PCM_JLCPCB:Q_SOT-23", "Q1": "PCM_JLCPCB:Q_SOT-23",
    "D2": "PCM_JLCPCB:D_SOD-123", "D3": "PCM_JLCPCB:D_SOD-123", "D1": "PCM_JLCPCB:D_SOD-123",
    "D_oc1": "PCM_JLCPCB:D_SOD-123", "D_oc2": "PCM_JLCPCB:D_SOD-123", "D_oc3": "PCM_JLCPCB:D_SOD-123",
    "D_vbus": "PCM_JLCPCB:D_SMA",
    "D_esd": "PCM_JLCPCB:SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BL-1",   # standard SOT-23-6, matches the TPD2S017 DBV pin order
    "D_tvs": "PCM_JLCPCB:D_SOD-123FL",
    "F_vbus": "Fuse:Fuse_1206_3216Metric",
    "OC2": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm", "OC3": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm",
    "OC1": "PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm",
    "LED1": "PCM_JLCPCB:D_0603",
    "SW_boot": "PCM_JLCPCB:SW_TS-1088-AR02016", "SW_en": "PCM_JLCPCB:SW_TS-1088-AR02016",
}
for _r in ("R_lim1","R_lim2","R_lim3","R_em","R_g2","R_g3","R_g1","R_pd2","R_pd3","R_pd1","R_en","R_boot","R_cc1","R_cc2","R_led","R_io8","R_ot","R_sda","R_scl","R_ce","R_pu1","R_pu2","R_pu3","R_op","R_on","R_mp","R_mn"):
    FOOTPRINT[_r] = "PCM_JLCPCB:R_0603"
for _c in ("C_in","C_3v3","C_out","C_en","C_dec",
           "C_dv","C_pv","C_av","C_avb","C_vref","C_vmid","C_aref","C_op","C_on","C_mp","C_mn"):
    FOOTPRINT[_c] = "PCM_JLCPCB:C_0603"

# FP override used by the schematic generator (stock symbols carry no footprint)
FP_OVERRIDE = {r: FOOTPRINT[r] for r in ("J1", "J2", "K1", "K2", "K3", "U3", "T1",
                                          "SW_OC1", "SW_OC2", "SW_OC3", "F_vbus")}

# nets: name -> [(ref, pad), ...]    (G6K-2 relay: coil 1,8 | COM=3 NC=2 NO=4)
NETS = {
    # USB VBUS (raw): J1 power pins into the fuse. Everything downstream of F1 is
    # VBUS_F: Schottky anode, VBUS TVS cathode, and the TPD2S017's VCC bias pin —
    # so a clamping TVS (or any board fault) blows the fuse and fails safe.
    "VBUS":   [("J1","A4"),("J1","B4"),("J1","A9"),("J1","B9"),("F_vbus","1")],
    "VBUS_F": [("F_vbus","2"),("D_vbus","2"),("D_esd","5"),("D_tvs","1")],
    # +5V rail = everything downstream of the reverse-protection Schottky D4 (cathode).
    "+5V": [("D_vbus","1"),("C_in","1"),
            ("U2","3"),("K2","1"),("K3","1"),("K1","1"),("D2","1"),("D3","1"),("D1","1"),("FLAG5","1")],
    "+3V3": [("U2","2"),("U2","4"),("C_out","1"),("C_3v3","1"),("C_dec","1"),("U1","2"),
             ("R_en","1"),("R_boot","1"),("R_led","1"),("R_io8","2"),("FLAG3","1"),
             # ES8311 supplies (PVDD/DVDD/AVDD) + their decoupling + I2C pull-ups
             ("U3","3"),("U3","4"),("U3","11"),
             ("C_dv","1"),("C_pv","1"),("C_av","1"),("C_avb","1"),
             ("R_sda","1"),("R_scl","1"),
             # opto collector pull-ups (pad 2 = +3V3 side, own In1 via each)
             ("R_pu1","2"),("R_pu2","2"),("R_pu3","2")],
    # U1 (ESP32-C6-WROOM-1) GND: castellated pads 1, 28 + EPAD (pad 29) -- all must tie to GND.
    "GND": [("J1","A1"),("J1","B1"),("J1","A12"),("J1","B12"),("J1","SH"),
            ("C_in","2"),("C_out","2"),("C_3v3","2"),("C_dec","2"),("U2","1"),
            ("Q2","2"),("Q3","2"),("Q1","2"),("R_pd2","2"),("R_pd3","2"),("R_pd1","2"),("R_em","2"),("C_en","2"),
            ("R_cc1","2"),("R_cc2","2"),("LED1","1"),("SW_boot","2"),("SW_en","2"),
            ("D_esd","2"),("D_tvs","2"),("FLAGG","1"),
            # ES8311 grounds (DGND/AGND/EP) + ref-cap grounds + R_ce pull-down bottom
            ("U3","5"),("U3","10"),("U3","21"),
            ("C_vref","2"),("C_vmid","2"),("C_aref","2"),("R_ce","2"),
            ("C_dv","2"),("C_pv","2"),("C_av","2"),("C_avb","2")]
           + [("U1","1"),("U1","28"),("U1","29")],  # WROOM-1: GND pad 1 + pad 28 + EPAD (pad 29, multi-rect)
    # The TPD2S017 sits IN SERIES in the data lines (1Ω flow-through per channel), so each
    # line splits into a connector-side net (J1 -> CH_IN) and an ESP-side net (CH_OUT -> U1).
    "USB_DM":     [("J1","A7"),("J1","B7"),("D_esd","3")],   # J1 D- pair -> CH1_IN
    "USB_DM_ESP": [("D_esd","1"),("U1","13")],               # CH1_OUT -> GPIO12/USB_D- (pad 13)
    "USB_DP":     [("J1","A6"),("J1","B6"),("D_esd","4")],   # J1 D+ pair -> CH2_IN
    "USB_DP_ESP": [("D_esd","6"),("U1","14")],               # CH2_OUT -> GPIO13/USB_D+ (pad 14)
    "USB_CC1": [("J1","A5"),("R_cc1","1")],
    "USB_CC2": [("J1","B5"),("R_cc2","1")],
    "EN": [("U1","3"),("R_en","2"),("C_en","1"),("SW_en","1")],        # C6 pad 3 = EN
    "BOOT": [("U1","15"),("R_boot","2"),("SW_boot","1")],  # GPIO9/BOOT on C6 pad 15
    "GPIO8": [("U1","10"),("R_io8","1")],  # C6 strapping pin GPIO8 on pad 10; 3.3k pull-up per C6 datasheet/DevKitC-1 (R6)
    # GATE*_DRV pad order (18=K2, 19=K1, 20=K3) is chosen so the GPIO escape bundle's
    # lane stack fans out to its targets west->east without crossings:
    # OK2, OK1, R_g3 (K3 gate R), K3 pin 5 (K1 drive into the interlock), R_g2 (K2).
    "GATE1_DRV": [("U1","19"),("K3","5")],     # GPIO21 / pad 19 — PTT K1 drive, straight
                                               # into K3 pole-B NO (pin 5): the interlock
                                               # contact comes FIRST, the series R after
    # K3 pole-B (pins 5/6/7) is wired as a hardware interlock: K1's gate drive is broken by K3's
    # spare pole-B contact so Q1 cannot turn on unless K3 is already energised. This prevents the
    # hazard where K1-talk (P4<->P2) without K3 open would short P2<->P3 via the WF26's S2 strap.
    # Pole-B pinout: COM=6, NC=7, NO=5 (symmetric with pole-A: COM=3, NC=2, NO=4).
    # NO (pin 5) is used so the path is OPEN at rest and only closes when K3 energises.
    "GATE1_PRE": [("K3","6"),("R_g1","1")],    # K3 pole-B COM (pin 6) -> R_g1 (series R
                                               # now sits gate-side, beside R_pd1/Q1)
    "GATE1": [("R_g1","2"),("Q1","1"),("R_pd1","1")],  # R_g1 out -> Q1 gate + pull-down
    "K1_DRAIN": [("Q1","3"),("K1","8"),("D1","2")],
    "GATE2_DRV": [("U1","18"),("R_g2","1")],   # GPIO20 / pad 18 — door-opener K2
    "GATE2": [("R_g2","2"),("Q2","1"),("R_pd2","1")],
    "K2_DRAIN": [("Q2","3"),("K2","8"),("D2","2")],
    "GATE3_DRV": [("U1","20"),("R_g3","1")],   # GPIO22 / pad 20 — chime-suppress K3
    "GATE3": [("R_g3","2"),("Q3","1"),("R_pd3","1")],
    "K3_DRAIN": [("Q3","3"),("K3","8"),("D3","2")],
    # T1 leg<->pin assignment routing-driven, like the secondary: flipping winding A
    # only inverts absolute audio polarity (inaudible)
    "P1": [("J2","1"),("T1","6"),
           ("SW_OC2","3"),("SW_OC2","4"),   # SW pins 3+4 = P1 side (OC2)
           ("SW_OC3","3"),("SW_OC3","4")],  # SW pins 3+4 = P1 side (OC3)
    # K1 = virtual PTT, pure TX relay (pole A). COM=IN_P4, NO->P2 (talk, energised).
    #   NC (pin 2) is intentionally open — not wired to P3 — so K1 de-energised does NOT strap
    #   P4<->P3 and cannot block the WF26's physical S2 from switching to talk. The WF26's own
    #   S2 (P4<->P3 at rest) handles the listen/idle state. K3 pole-B hardware interlock
    #   (GATE1_PRE/GATE1) enforces K3 must be on before K1 can fire. Pole B (K1 pads 5/6/7) spare.
    "P2": [("J2","2"),("K2","3"),("K1","4"),
           ("SW_OC1","3"),("SW_OC1","4")],  # SW pins 3+4 = P2 side (OC1)
    # ÖT door-opener bridge goes through R_ot (2.2k) in series with K2's NO contact, matching
    # the genuine WF26 (its ÖT button bridges lines 2<->3 via R1=2.2k, NOT a dead short -- so it
    # only loads the speech pair instead of fully shorting it). K2 COM=P2; K2 NO -> R_ot -> P3.
    "P3": [("J2","3"),("R_ot","1")],
    "OT_BRIDGE": [("R_ot","2"),("K2","4")],
    # Line 4 (Türruf) is BROKEN INTO the board for chime suppression:
    # IN_P4 = TV20/S-incoming side (J2.6 -> K3 NC; OC2 and K1 COM sit here so both gong-sense
    # and PTT still work when K3 is energised, since K3 NC retains the TV20/S signal).
    # P4 = WF26-handset side (K3 COM -> J2.4 -> WF26 terminal 4).
    # K3 at rest passes IN_P4(NC)->P4(COM); energised it opens the line (gong silenced).
    "P4": [("J2","4"),("K3","3")],                           # WF26 terminal 4: J2.4, K3 COM
    "IN_P4": [("K3","2"),("J2","6"),("K1","3"),
              ("SW_OC2","1"),("SW_OC2","6")],  # SW pins 1+6 = IN_P4 side (OC2)
    "P5": [("J2","5"),("T1","4"),
           ("SW_OC3","1"),("SW_OC3","6"),   # SW pins 1+6 = P5 side (OC3)
           ("SW_OC1","1"),("SW_OC1","6")],  # SW pins 1+6 = P5 side (OC1)
    # opto LED limiters UNSHARED: each opto gets its own cathode->P1 resistor. The single
    # shared limiter let one ringing channel lift the common cathode node ~10.8 V and reverse-bias
    # the idle opto's LED beyond its 6 V VR; per-opto resistors keep each idle cathode near P1.
    # Anti-parallel reverse-voltage clamps: 1N4148W pin 1 = CATHODE, pin 2 = ANODE (CDFER lib,
    # same convention as the D1-D3 flybacks / D4). Clamp ANODE (pin 2) sits on the opto LED's
    # cathode net and clamp CATHODE (pin 1) on the LED's anode net, so the 1N4148 only conducts
    # on the reverse half-wave (limits LED reverse V to ~0.7V, < the 6V VR rating) and is OFF
    # while the opto LED conducts forward. (2026-06-10 fix: pins were swapped -> the clamp sat
    # PARALLEL to the LED and stole the forward current, killing all three sense channels.)
    "OC2_CATH": [("OC2","2"),("R_lim1","1"),("D_oc2","2")],   # D_oc2 ANODE (pin 2) on LED cathode net
    "OC3_CATH": [("OC3","2"),("R_lim2","1"),("D_oc3","2")],
    "OC1_CATH": [("OC1","2"),("R_lim3","1"),("D_oc1","2")],
    # SW center pins: JP on pin 5, RET on pin 2 (swapped vs the natural orientation;
    # the footprint is rotated 180° on the PCB, which maps pads 1↔6/2↔5/3↔4, so the
    # copper layout is unchanged — pads 1/6 and 3/4 are paired on the same nets anyway).
    # Slide pos A = 1↔2 + 4↔5, pos B = 2↔3 + 5↔6; either position closes a complete
    # loop of opposite polarity.
    "OC2_JP": [("SW_OC2","5"),("OC2","1"),("D_oc2","1")],    # D_oc2 CATHODE (pin 1): anti-parallel to opto LED
    "OC3_JP": [("SW_OC3","5"),("OC3","1"),("D_oc3","1")],
    "OC1_JP": [("SW_OC1","5"),("OC1","1"),("D_oc1","1")],
    # SW pin 2 -> R_lim cathode-return side (sliding SW flips both poles simultaneously)
    "OC2_RET": [("SW_OC2","2"),("R_lim1","2")],
    "OC3_RET": [("SW_OC3","2"),("R_lim2","2")],
    "OC1_RET": [("SW_OC1","2"),("R_lim3","2")],
    # Each collector also carries its 10k pull-up to +3V3 (R_pu*, pad 1 on the
    # collector column) — the escape lane routes through the pull-up's pad 1.
    "OC2_OUT": [("OC2","4"),("R_pu2","1"),("U1","26")],   # GPIO3  / pad 26 (C6 right col) — house bell (Türruf)
    "OC3_OUT": [("OC3","4"),("R_pu3","1"),("U1","27")],   # GPIO2  / pad 27 (C6 right col) — apartment bell (Etagenruf)
    "OC1_OUT": [("OC1","4"),("R_pu1","1"),("U1","21")],   # GPIO23 / pad 21 (C6 right col) — session-active in
    "OC_EMIT": [("OC2","3"),("OC3","3"),("OC1","3"),("R_em","1")],
    "LED_A": [("R_led","2"),("LED1","2")],

    # === Audio codec (ES8311, U3) — PROVISIONAL mono half-duplex front-end (analog bench-gated) ===
    # Tap: T1 winding A across P1/P5 (directly across the WF26 transducer LS1 — confirmed from
    # wf26.kicad_sch). ES8311 is MONO with DIFFERENTIAL out (OUTP/OUTN) and mic in (MIC1P/MIC1N),
    # both AC-coupled to T1 winding B (sec). Out and mic share the secondary; firmware mutes the
    # idle direction (DAC off in listen, ADC off in talk) — standard ES8311 half-duplex, so the
    # K1 pole-B audio switch is no longer needed (K1 reverts to PTT-only on pole A).
    # I2C on pads 16/17 (west col) and I2S MCLK on pad 6 (east col) — all GPIO-matrix-
    # routable on the C6; this assignment makes the three-lane bundle into U3 come out
    # in SDA, SCL, MCLK order without crossings (west-column lines own the upper
    # lanes, the east-column riser slots in beneath).
    # I2S data/clock pad order (12=BCLK, 11=DIN, 8=WS, 7=DOUT, top to bottom on U1's
    # east column) matches U3's south-row pin order west->east (SCLK=6, ASDOUT=7,
    # LRCK=8, DSDIN=9), so the four-line fan to the codec routes without crossings.
    # All I2S signals are GPIO-matrix-routable on the C6 — pure permutation.
    "I2S_MCLK": [("U3","2"),("U1","6")],     # MCLK  <- GPIO6 (pad 6)
    "I2S_BCLK": [("U3","6"),("U1","12")],    # SCLK  <- GPIO11 (pad 12)
    "I2S_WS":   [("U3","8"),("U1","8")],     # LRCK  <-> GPIO0 (pad 8)
    "I2S_DOUT": [("U3","9"),("U1","7")],     # DSDIN <- ESP (GPIO7, pad 7) — playback data
    "I2S_DIN":  [("U3","7"),("U1","11")],    # ASDOUT -> ESP (GPIO10, pad 11) — capture data
    "I2C_SDA":  [("U3","19"),("U1","16"),("R_sda","2")],  # CDATA <-> GPIO18 (pad 16)
    "I2C_SCL":  [("U3","1"),("U1","17"),("R_scl","2")],   # CCLK  <-> GPIO19 (pad 17)
    "ES_CE":    [("U3","20"),("R_ce","1")],               # CE addr-select: U3 pin 20 -> pull-down -> GND
    "ES_DACVREF": [("U3","14"),("C_vref","1")],
    "ES_ADCVREF": [("U3","15"),("C_aref","1")],
    "ES_VMID":    [("U3","16"),("C_vmid","1")],
    # differential analog, AC-coupled to T1 winding B (pads 4,6; CT pad 5 NC):
    "ES_OUTP": [("U3","12"),("C_op","1")],
    "ES_OUTN": [("U3","13"),("C_on","1")],
    "ES_MICP": [("U3","18"),("C_mp","1")],
    "ES_MICN": [("U3","17"),("C_mn","1")],
    # leg<->pin assignment chosen for clean PCB routing; the swap only flips absolute
    # audio polarity, which is inaudible (mono path, no phase-sensitive summing).
    # Winding swap (2026-06-11): bus winding on the EAST pads (6/4, facing its B.Cu
    # launch vias), secondary on the WEST pads (1/3).
    # Each leg carries series resistors in both directions (see R_op/R_mp comments
    # in COMP): cap -> resistor (pad 1 = cap side) -> transformer.
    "OUT_A":   [("C_op","2"),("R_op","1")],
    "OUT_B":   [("C_on","2"),("R_on","1")],
    "MIC_A":   [("C_mp","2"),("R_mp","1")],
    "MIC_B":   [("C_mn","2"),("R_mn","1")],
    "SEC_A":   [("T1","1"),("R_op","2"),("R_mp","2")],   # secondary leg A: OUTP & MIC1P
    "SEC_B":   [("T1","3"),("R_on","2"),("R_mn","2")],   # secondary leg B: OUTN & MIC1N
}

# Subassembly groups (KiCad PCB_GROUP) -> internal keys. Each functional block selects/moves as a
# unit in the PCB editor. Created in route.py at finalize time. Footprints only; an
# item belongs to at most one group.
GROUPS = {
    "MCU":                     ["U1", "R_io8", "C_3v3", "C_dec"],
    "BOOT":                    ["SW_boot", "R_boot"],
    "RST":                     ["SW_en", "R_en", "C_en"],
    "USB-C":                   ["J1", "D_esd", "D_tvs", "F_vbus", "R_cc1", "R_cc2"],
    "Power (LDO)":             ["U2", "C_in", "C_out", "D_vbus"],
    "Power LED":               ["LED1", "R_led"],
    "Bell sense (optos)":      ["OC2", "OC3", "OC1", "R_lim1", "R_lim2", "R_lim3", "R_em", "D_oc1", "D_oc2", "D_oc3",
                                "R_pu1", "R_pu2", "R_pu3"],
    "Polarity switches":       ["SW_OC3", "SW_OC2", "SW_OC1"],
    "K2 door-opener relay":    ["K2", "Q2", "D2", "R_g2", "R_pd2", "R_ot"],
    "K3 chime-suppress relay": ["K3", "Q3", "D3", "R_g3", "R_pd3"],
    "K1 PTT relay":            ["K1", "Q1", "D1", "R_g1", "R_pd1"],
    "Audio codec (ES8311)":    ["U3", "T1", "C_dv", "C_pv", "C_av", "C_avb", "C_vref", "C_vmid",
                                "C_aref", "C_op", "C_on", "C_mp", "C_mn", "R_sda", "R_scl", "R_ce",
                                "R_op", "R_on", "R_mp", "R_mn"],
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

# placement grid (units of 2.54mm), shared cluster layout for schematic + PCB
GRID = {
    "J1": (16, 20), "R_cc1": (10, 24), "R_cc2": (10, 28), "R_io8": (74, 52),
    "D_vbus": (24, 16), "D_esd": (10, 16),
    "U2": (36, 20), "C_in": (30, 30), "C_out": (42, 30), "C_3v3": (48, 30), "C_dec": (54, 30),
    "FLAG5": (28, 14), "FLAG3": (48, 16), "FLAGG": (36, 36),
    "U1": (82, 46), "R_en": (60, 28), "C_en": (64, 34), "SW_en": (56, 32),
    "R_boot": (60, 64), "SW_boot": (56, 68),
    "R_g2": (104, 30), "Q2": (109, 30), "R_pd2": (109, 36), "D2": (116, 26), "K2": (126, 30),
    "R_g3": (104, 64), "Q3": (109, 64), "R_pd3": (109, 70), "D3": (116, 60), "K3": (126, 64),
    "R_g1": (104, 98), "Q1": (109, 98), "R_pd1": (109, 104), "D1": (116, 94), "K1": (126, 98),
    "OC2": (36, 82), "OC3": (36, 96), "R_lim1": (50, 85), "R_lim2": (50, 90), "R_em": (50, 96), "J2": (16, 86),
    "OC1": (36, 110), "R_lim3": (50, 110),   # session-sense opto + limiter (schematic placement; reorganise later)
    "R_pu2": (58, 82), "R_pu3": (58, 96), "R_pu1": (58, 110),  # collector pull-ups, right of each opto
    "D_oc2": (22, 82), "D_oc3": (22, 96), "D_oc1": (22, 110),  # opto LED clamp diodes (schematic)
    "SW_OC2": (28, 82),   # OC2 polarity switch
    "SW_OC3": (28, 96),   # OC3 polarity switch
    "SW_OC1": (28, 110),  # OC1 polarity switch
    # --- audio codec cluster (schematic canvas; reorganise later) ---
    "U3": (90, 90), "T1": (70, 110),
    "C_dv": (78, 80), "C_pv": (82, 80), "C_av": (86, 80), "C_avb": (90, 80),
    "C_vref": (98, 86), "C_vmid": (98, 90), "C_aref": (98, 94),
    "C_op": (78, 104), "C_on": (82, 104), "C_mp": (86, 104), "C_mn": (90, 104),
    "R_op": (78, 108), "R_on": (82, 108), "R_mp": (86, 108), "R_mn": (90, 108),
    "R_ce": (98, 78), "R_sda": (98, 80), "R_scl": (98, 82),
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
    "TerminalBlock_4Ucon": f"{_HERE}/lib_terminal/TerminalBlock_4Ucon.pretty",  # local copy of stock fp; Phoenix PT-1,5-6-3.5-H 3D stand-in (no 4Ucon/DB125 model exists)
    "ES8311": f"{_HERE}/lib_audio/ES8311.pretty",   # ES8311 mono codec (easyeda2kicad import, C962342)
    "SM_LP_5001": f"{_HERE}/lib_audio/SM_LP_5001.pretty",    # Bourns SM-LP-5001 (easyeda2kicad import, C7503474)
    "cas220tb1": f"{_HERE}/lib_switches/cas220tb1.pretty",
    "TPD2S017": f"{_HERE}/lib_usb/TPD2S017.pretty",   # TI TPD2S017 (easyeda2kicad import, C880115); footprint unused (PCM_JLCPCB SOT-23-6 instead)
    "Fuse": f"{_STOCK}/Fuse.pretty",           # stock 1206 fuse land pattern (F1)
    "Fiducial": f"{_STOCK}/Fiducial.pretty",   # PCBA optical reference marks (added in gen_pcb.py)
    "TestPoint": f"{_STOCK}/TestPoint.pretty", # commissioning test pads (added in gen_pcb.py)
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
# component ref -> mm its footprint bbox extends BEYOND its EDGE_FLUSH board edge.
# The board edge stays at the flush line; the part is pushed out past it so the USB-C
# shell sticks out and a cable seats fully without the PCB blocking it.
# J1 (USB4105): courtyard front 4.18 minus the footprint's own "PCB Edge" marker line at
# 3.675 -> 0.505, which puts the board edge exactly on GCT's recommended edge line (the
# shell mouth then protrudes ~1.3 mm, per the datasheet).
EDGE_OVERHANG = {"J1": 0.505}
