#!/usr/bin/env python3
"""Generic KiCad schematic -> simulator importer.

Two jobs only:
  a) import the schematic (components + connectivity), and
  b) emit a neutral netlist JSON the browser simulator consumes.

NOTHING here encodes board-specific knowledge: component "kind" is derived purely
from the reference-designator prefix, and the value string is passed through
verbatim for the simulator to interpret per type. Re-run after editing the
schematic; it regenerates board-sim.html from board-sim.template.html.
"""
import json, re, subprocess, sys, tempfile, os

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "..", "kicad", "doorbell.kicad_sch")

# refdes prefix -> neutral component kind (generic EDA conventions, not board-specific)
KIND = {
    "R": "resistor", "C": "capacitor", "L": "inductor", "D": "diode",
    "Q": "bjt", "M": "mosfet", "U": "ic", "T": "transformer", "K": "relay",
    "J": "connector", "P": "connector", "LS": "speaker", "SP": "speaker",
    "OC": "optocoupler", "S": "switch", "SW": "switch", "Y": "crystal",
    "X": "crystal", "TP": "testpoint", "H": "hole", "FID": "fiducial",
    "F": "fuse", "FB": "ferrite", "BT": "battery", "RV": "resistor",
}

def value_from_libname(lib):
    """JLCPCB-style symbols often leave the Value field blank and encode the value in the part
    name, e.g. 'PCM_JLCPCB-Resistors:0603,100Ω' or '...:0805,100nF'. Recover a parseable token
    (the number + optional multiplier preceding an Ω/F/H unit) so passives aren't dropped."""
    if not lib:
        return ""
    name = lib.split(":")[-1]
    m = re.search(r'([0-9][0-9.]*\s*[pnuµmkKMGR]?)\s*(?:Ω|ohm|F|H)', name, re.I)
    return m.group(1).replace("µ", "u").replace(" ", "") if m else ""

def kind_from_lib(lib):
    """Classify by the device TYPE — the symbol's lib_id (library category + part name) — so a part's
    model never depends on its reference designator. Returns None when the lib is unrecognized, so
    kind_from_ref() (the refdes-prefix convention) is the fallback."""
    if not lib:
        return None
    cat, _, name = lib.partition(":")
    cat, name = cat.lower(), name.lower()
    if "tpd2s" in name or "esd" in name:        return "protection"   # ESD/TVS protection array
    if "solderjumper" in name:                  return "connector"    # solder bridge (switch-like, see isBridge)
    if "testpoint" in name:                     return "testpoint"
    if "tactile" in name or "button" in name or "sppj" in cat:  return "switch"
    if "relay" in cat or "g6k" in name:         return "relay"
    if "optocoupler" in cat or name.startswith("ltv") or "pc817" in name: return "optocoupler"
    if "sm_lp" in cat or "sm-lp-5001" in name or "transformer" in name:   return "transformer"
    if "speaker" in name:                       return "speaker"
    if "fuse" in name:                          return "fuse"
    if "diode" in cat:                          return "diode"
    if "transistor" in cat:                     return "mosfet"       # NMOS/PMOS/BJT -> G/D/S model
    if "resistor" in cat:                       return "resistor"
    if "capacitor" in cat:                      return "capacitor"
    if "inductor" in cat or "ferrite" in cat:   return "inductor"
    if "power" in cat:                          return "ic"           # LDO/regulator (VIN/VOUT/GND model)
    if "esp32" in name or "es8311" in name:     return "ic"
    if "usb_c" in name or name.startswith("conn_") or "connector" in cat: return "connector"
    if cat == "device":                         # generic KiCad symbols name == class letter
        if name == "r" or name.startswith("r_"): return "resistor"
        if name == "c" or name.startswith("c_"): return "capacitor"
        if name == "l" or name.startswith("l_"): return "inductor"
        if name == "d" or name.startswith("d_"): return "diode"
    return None

def kind_from_ref(ref):
    base = ref.replace("WF26_", "")          # strip namespacing prefix, keep the class letter
    m = re.match(r"^([A-Za-z]+)", base)
    pre = m.group(1) if m else "?"
    if pre in KIND:
        return KIND[pre]
    # fall back to the longest matching known prefix (e.g. "LS" before "L")
    for n in (2, 1):
        if pre[:n] in KIND:
            return KIND[pre[:n]]
    return "unknown"

def sexpr_blocks(s, tag):
    out, i = [], 0
    while True:
        i = s.find("(" + tag, i)
        if i < 0:
            break
        d, j = 0, i
        while j < len(s):
            c = s[j]
            if c == "(":
                d += 1
            elif c == ")":
                d -= 1
                if d == 0:
                    break
            j += 1
        out.append(s[i:j + 1])
        i = j + 1
    return out

def _netname(block, nummap):
    m = re.search(r'\(net (\d+) "([^"]*)"\)', block)
    if m: return m.group(2)
    m = re.search(r'\(net "([^"]*)"\)', block)
    if m: return m.group(1)
    m = re.search(r'\(net (\d+)\)', block)
    if m: return nummap.get(m.group(1), "")
    return ""

def parse_pcb():
    import math
    PCB = os.path.join(HERE, "..", "kicad", "doorbell.kicad_pcb")
    if not os.path.exists(PCB):
        return None
    s = open(PCB).read()
    nummap = dict(re.findall(r'\(net (\d+) "([^"]*)"\)', s))
    # copper layer order (top->bottom) from the layer table
    layers = [m[1] for m in re.findall(r'\((\d+) "([^"]+)" (?:signal|mixed|power|user)', s) if m[1].endswith(".Cu")]
    segs = []
    for b in sexpr_blocks(s, "segment"):
        st = re.search(r'\(start ([-\d.]+) ([-\d.]+)\)', b); en = re.search(r'\(end ([-\d.]+) ([-\d.]+)\)', b)
        w = re.search(r'\(width ([-\d.]+)\)', b); ly = re.search(r'\(layer "([^"]+)"\)', b)
        if not (st and en and ly): continue
        segs.append(dict(x1=float(st[1]), y1=float(st[2]), x2=float(en[1]), y2=float(en[2]),
                         w=float(w[1]) if w else 0.2, layer=ly[1], net=_netname(b, nummap)))
    vias = []
    for b in sexpr_blocks(s, "via"):
        at = re.search(r'\(at ([-\d.]+) ([-\d.]+)\)', b); sz = re.search(r'\(size ([-\d.]+)\)', b)
        lys = re.findall(r'"([FB]\.Cu|In\d\.Cu)"', b)
        if not at: continue
        vias.append(dict(x=float(at[1]), y=float(at[2]), r=(float(sz[1]) if sz else 0.6)/2,
                         layers=lys, net=_netname(b, nummap)))
    pads = []
    for fp in sexpr_blocks(s, "footprint"):
        fat = re.search(r'\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)', fp)
        if not fat: continue
        fref = re.search(r'\(property "Reference" "([^"]+)"', fp)
        fref = fref.group(1) if fref else "?"
        fdeg = float(fat[3] or 0)
        fx, fy, fa = float(fat[1]), float(fat[2]), math.radians(fdeg)
        for p in sexpr_blocks(fp, "pad"):
            pat = re.search(r'\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)', p)
            sz = re.search(r'\(size ([-\d.]+) ([-\d.]+)\)', p)
            lys = re.findall(r'"([FB]\.Cu|In\d\.Cu|\*\.Cu)"', p)
            if not (pat and sz): continue
            px, py = float(pat[1]), float(pat[2])
            ax = fx + px*math.cos(fa) + py*math.sin(fa)   # KiCad footprint rotation: [cos +sin; -sin cos]
            ay = fy - px*math.sin(fa) + py*math.cos(fa)
            shape = "circle" if " circle " in p[:60] or "circle " in p[:60] else "rect"
            pads.append(dict(x=ax, y=ay, w=float(sz[1]), h=float(sz[2]), shape=shape, ref=fref,
                             rot=float(pat[3] or 0),   # KiCad stores pad angle absolute (footprint rot baked in)
                             layers=("*.Cu" in [l for l in lys]) and ["*"] or lys,
                             net=_netname(p, nummap)))
    # board outline (Edge.Cuts)
    outline = []
    for b in sexpr_blocks(s, "gr_line") + sexpr_blocks(s, "gr_rect"):
        if '"Edge.Cuts"' not in b: continue
        st = re.search(r'\(start ([-\d.]+) ([-\d.]+)\)', b); en = re.search(r'\(end ([-\d.]+) ([-\d.]+)\)', b)
        if not (st and en): continue
        x1, y1, x2, y2 = float(st[1]), float(st[2]), float(en[1]), float(en[2])
        if b.lstrip().startswith("(gr_rect"):
            outline += [[x1,y1,x2,y1],[x2,y1,x2,y2],[x2,y2,x1,y2],[x1,y2,x1,y1]]
        else:
            outline.append([x1,y1,x2,y2])
    xs = [c for seg in outline for c in (seg[0],seg[2])] + [s2[k] for s2 in segs for k in ("x1","x2")]
    ys = [c for seg in outline for c in (seg[1],seg[3])] + [s2[k] for s2 in segs for k in ("y1","y2")]
    bbox = [min(xs), min(ys), max(xs), max(ys)] if xs else [0,0,100,100]
    return dict(layers=layers, segments=segs, vias=vias, pads=pads, outline=outline, bbox=bbox)

def _walk_symbols():
    """Yield every instance symbol block across the root sheet and all hierarchical sub-sheets,
    paired with its set of references (handles sheets instantiated multiple times)."""
    for fn in os.listdir(os.path.join(HERE, "..", "kicad")):
        if not fn.endswith(".kicad_sch"):
            continue
        s = open(os.path.join(HERE, "..", "kicad", fn)).read()
        for sym in sexpr_blocks(s, "symbol"):
            if not re.match(r'\(symbol\s*\(lib_id', sym):   # instance symbols only (skip lib cache)
                continue
            refs = set(re.findall(r'\(reference "([^"]+)"\)', sym))   # hierarchical instance refs
            pr = re.search(r'\(property "Reference" "([^"]+)"', sym)
            if pr:
                refs.add(pr.group(1))
            yield sym, {r for r in refs if not r.endswith("?")}

def lib_ids():
    """ref -> symbol lib_id, across the root sheet and any hierarchical sub-sheets."""
    out = {}
    for sym, refs in _walk_symbols():
        m = re.match(r'\(symbol\s*\(lib_id "([^"]+)"\)', sym)
        if m:
            for r in refs:
                out[r] = m.group(1)
    return out

def sym_values():
    """ref -> Value property, across the root sheet and all sub-sheets. (The root-only scan missed
    symbols inside hierarchical sheets — e.g. the relay-driver gate resistors.)"""
    out = {}
    for sym, refs in _walk_symbols():
        m = re.search(r'\(property "Value" "([^"]*)"', sym)
        if m:
            for r in refs:
                out[r] = m.group(1)
    return out


def main():
    # values from the schematic symbols (root + hierarchical sub-sheets)
    values = sym_values()

    # connectivity from a kicad-cli netlist export (robust vs. hand-parsing wires)
    with tempfile.NamedTemporaryFile(suffix=".net", delete=False) as tf:
        netfile = tf.name
    subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadsexpr",
                    "-o", netfile, SCH], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    nl = open(netfile).read()
    os.unlink(netfile)

    comps = {}   # ref -> {kind, value, pins: {pin: net}}
    nets = set()
    for m in re.finditer(r'\(net\s+\(code "\d+"\)\s+\(name "([^"]+)"\)(.*?)(?=\(net\s+\(code|\Z)', nl, re.S):
        net = m.group(1)
        nets.add(net)
        for ref, pin, fn in re.findall(r'\(ref "([^"]+)"\)\s+\(pin "([^"]+)"\)(?:\s+\(pinfunction "([^"]*)"\))?', m.group(2)):
            c = comps.setdefault(ref, {"kind": kind_from_ref(ref), "value": values.get(ref, ""), "pins": {}, "pinfn": {}})
            c["pins"][pin] = net
            if fn: c["pinfn"][pin] = fn

    libmap = lib_ids()
    for r, c in comps.items():
        k = kind_from_lib(libmap.get(r, ""))   # device type (lib_id) wins; refdes prefix is the fallback
        if k:
            c["kind"] = k
        if not c["value"]:                     # last resort: recover a blank value from the part name
            v = value_from_libname(libmap.get(r, ""))
            if v:
                c["value"] = v
    out = {
        "source": "doorbell.kicad_sch",
        "components": [dict(ref=r, lib=libmap.get(r, ""), **comps[r]) for r in sorted(comps)],
        "nets": sorted(nets),
        "pcb": parse_pcb(),
    }
    json.dump(out, open(os.path.join(HERE, "netlist.json"), "w"), indent=1)

    # by-kind summary
    bykind = {}
    for c in out["components"]:
        bykind[c["kind"]] = bykind.get(c["kind"], 0) + 1
    print(f"imported {len(out['components'])} components, {len(out['nets'])} nets")
    print("by kind:", ", ".join(f"{k}:{v}" for k, v in sorted(bykind.items())))

    import glob
    payload = json.dumps(out)
    made = []
    for tmpl in sorted(glob.glob(os.path.join(HERE, "*.template.html"))):
        html = open(tmpl).read().replace("__NETLIST_JSON__", payload)
        outname = os.path.basename(tmpl).replace(".template", "")
        open(os.path.join(HERE, outname), "w").write(html)
        made.append(outname)
    print("wrote", ", ".join(made) if made else "netlist.json (no templates yet)")

if __name__ == "__main__":
    main()
