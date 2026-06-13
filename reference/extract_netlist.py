#!/usr/bin/env python3
"""Extract the electrical netlist from KlingelV4.fzz.

A .fzz is a zip containing a .fz (XML). Because this project was hand-built on
perfboard, the real wiring lives in Fritzing's *breadboard* view, so we trace
connectivity across ALL views, then merge logical nets via net labels, ground,
and power labels. Output is a netlist: net -> set of component pins.
"""
import zipfile, re, sys, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
FZZ = os.path.join(HERE, "..", "docs", "KlingelV4.fzz")

Z = zipfile.ZipFile(FZZ)
fzmember = next(n for n in Z.namelist() if n.endswith(".fz"))
fz = Z.read(fzmember).decode("utf-8", "replace")

# ---- pin-name maps from bundled fzps (connectorId -> human name) ----
pinname = {}  # fzp title -> {connectorId: name}
for n in Z.namelist():
    if n.endswith(".fzp"):
        d = Z.read(n).decode("utf-8", "replace")
        t = re.search(r'<title>([^<]*)</title>', d)
        title = t.group(1) if t else n
        m = {}
        for con in re.finditer(r'<connector\b[^>]*>', d):
            tag = con.group(0)
            cid = re.search(r'id="([^"]+)"', tag)
            nm = re.search(r'name="([^"]*)"', tag)
            if cid:
                m[cid.group(1)] = nm.group(1) if nm else cid.group(1)
        pinname[title] = m

# ---- parse instances ----
inst_re = re.compile(r'<instance\b([^>]*)>(.*?)</instance>', re.S)
def attr(s, k):
    m = re.search(k + r'="([^"]*)"', s); return m.group(1) if m else None

instances = {}
for m in inst_re.finditer(fz):
    head, body = m.group(1), m.group(2)
    mi = attr(head, "modelIndex")
    mid = attr(head, "moduleIdRef") or ""
    tt = re.search(r'<title>([^<]*)</title>', body)
    instances[mi] = {"mid": mid, "title": tt.group(1) if tt else "?", "body": body}

# ---- union-find over (modelIndex, connectorId) ----
parent = {}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb: parent[ra] = rb

# Connectivity from the SCHEMATIC view only (the complete logical design).
conn_re = re.compile(r'<connector\b[^>]*connectorId="([^"]+)"[^>]*>(.*?)</connector>', re.S)
connect_re = re.compile(r'<connect\b([^>]*)/?>')
sview_re = re.compile(r'<schematicView\b.*?</schematicView>', re.S)
def sview(body):
    m = sview_re.search(body); return m.group(0) if m else ""

for mi, inst in instances.items():
    wire_nodes = []
    for c in conn_re.finditer(sview(inst["body"])):
        cid, cbody = c.group(1), c.group(2)
        node = (mi, cid); find(node)
        wire_nodes.append(node)
        for cn in connect_re.finditer(cbody):
            a = cn.group(1)
            tmi, tcid = attr(a, "modelIndex"), attr(a, "connectorId")
            if tmi and tcid:
                union(node, (tmi, tcid))
    # A wire/bus is a single conductor: union all of its own endpoints together.
    # Without this, every chain "A -> wire.c1 ... wire.c0 -> B" snaps at the wire.
    if "WireModuleID" in inst["mid"]:
        for nd in wire_nodes[1:]:
            union(wire_nodes[0], nd)

# ---- merge logical nets: net labels by text, grounds together, power by text ----
netlabel_groups = defaultdict(list); ground_nodes = []; power_groups = defaultdict(list)
for mi, inst in instances.items():
    cids = list({c.group(1) for c in conn_re.finditer(sview(inst["body"]))})
    nodes = [(mi, c) for c in cids]
    if "NetLabelModuleID" in inst["mid"]:   netlabel_groups[inst["title"]] += nodes
    elif "GroundModuleID" in inst["mid"]:   ground_nodes += nodes
    elif "PowerLabelModuleID" in inst["mid"]: power_groups[inst["title"]] += nodes

for grp in netlabel_groups.values():
    for nd in grp[1:]: union(grp[0], nd)
for nd in ground_nodes[1:]: union(ground_nodes[0], nd)
for grp in power_groups.values():
    for nd in grp[1:]: union(grp[0], nd)

# ---- collect nets (real component pins only) ----
SKIP = ("WireModuleID","RectanglePCBModuleID","TwoLayerRectanglePCBModuleID","PerfboardModuleID")
LABEL = ("NetLabelModuleID","GroundModuleID","PowerLabelModuleID")

def pretty(mi, cid):
    inst = instances[mi]; mid = inst["mid"]; pn = None
    if "LuaNode32" in mid:   pn = pinname.get("LuaNode32 / ESP32", {}).get(cid)
    elif "prefix0000" in mid: pn = pinname.get("2RelayModule", {}).get(cid)
    return inst["title"], (pn or cid)

nets = defaultdict(set); netname = {}
for mi, inst in instances.items():
    mid = inst["mid"]
    cids = list({c.group(1) for c in conn_re.finditer(sview(inst["body"]))})
    for cid in cids:
        r = find((mi, cid))
        if any(s in mid for s in LABEL):
            if "GroundModuleID" in mid: netname[r] = "GND"
            else: netname.setdefault(r, inst["title"])
            continue
        if any(s in mid for s in SKIP): continue
        title, pin = pretty(mi, cid)
        nets[r].add(f"{title}.{pin}")

print(f"# Netlist from {os.path.basename(FZZ)}  ({len([n for n in nets.values() if len(n)>=2])} multi-pin nets)\n")
i = 0
for r, pins in sorted(nets.items(), key=lambda kv: (-len(kv[1]), str(kv[0]))):
    if len(pins) < 2: continue
    i += 1
    print(f"[{netname.get(r, f'N{i}')}]  " + "  ".join(sorted(pins)))
print("\n# unconnected / single-pin stubs:")
for r, pins in nets.items():
    if len(pins) == 1:
        print(f"  {netname.get(r,'')}: {list(pins)[0]}")
