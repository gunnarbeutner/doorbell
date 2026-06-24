#!/usr/bin/env python3
"""Inject 'fake solder' anchor blocks into the assembly STEP so a 3D print holds together.

When `kicad/fab/doorbell.step` is 3D-printed, each component connects to the board only
through its thin printed leads — heavier parts (e.g. the K5 relay) snap off. This adds a
small box of material at every SMD pad, bridging the board's top surface up into the
component's leads/body so the print is mechanically anchored, the way real solder fillets
hold the part on the real board.

How it works (no CAD kernel needed — KiCad can't generate fillets and none is installed):
the blocks are authored directly as AP214 manifold-solid B-reps in the board's global frame
and appended to the top assembly's SHAPE_REPRESENTATION item list (reusing its mm geometric
context). Existing entities are untouched; only fresh #ids above the current max are added.

Coordinate transform (verified against the mounting/tooling holes): STEP x = pcb x,
STEP y = -(pcb y), board bottom z=0, board top z=1.51 mm. Pad world positions come from
pcbnew (run under KiCad's bundled python, see build.sh) so there's no rotation math here.

usage: step_solder.py [STEP_PATH]   (default kicad/fab/doorbell.step, edited in place)
"""
import os
import re
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.join(HERE, "doorbell.kicad_pcb")

# Board top surface and anchor geometry (mm). EMB sinks the block slightly into the board
# so it fuses solidly; H is how far it rises past the top face to grab the leads/body.
TOP_Z, BOT_Z = 1.51, 0.0
EMB, H = 0.25, 0.6
MARGIN, SIDE_MIN, SIDE_MAX = 0.2, 0.6, 2.0

# Box faces as (corner-key loop CCW about the outward normal, normal, in-plane ref dir).
# Corner key 'xyz' picks lo/hi per axis. Loops are ordered so each shared edge is traversed
# in opposite directions by its two faces (=> a valid closed manifold with outward normals).
FACES = [
    (["000", "010", "110", "100"], (0, 0, -1), (1, 0, 0)),
    (["001", "101", "111", "011"], (0, 0, 1), (1, 0, 0)),
    (["000", "100", "101", "001"], (0, -1, 0), (1, 0, 0)),
    (["010", "011", "111", "110"], (0, 1, 0), (1, 0, 0)),
    (["000", "001", "011", "010"], (-1, 0, 0), (0, 1, 0)),
    (["100", "110", "111", "101"], (1, 0, 0), (0, 1, 0)),
]


def fnum(v):
    return f"{v:.6f}"


class Emitter:
    def __init__(self, start_id):
        self.id = start_id
        self.lines = []

    def add(self, body):
        self.id += 1
        self.lines.append(f"#{self.id}={body};")
        return self.id


def corner(lo, hi, key):
    return (lo[0] if key[0] == "0" else hi[0],
            lo[1] if key[1] == "0" else hi[1],
            lo[2] if key[2] == "0" else hi[2])


def box_solid(em, lo, hi):
    """Emit one axis-aligned box as a MANIFOLD_SOLID_BREP; return its #id."""
    cp, vp = {}, {}
    for k in ("000", "100", "110", "010", "001", "101", "111", "011"):
        x, y, z = corner(lo, hi, k)
        cp[k] = em.add(f"CARTESIAN_POINT('',({fnum(x)},{fnum(y)},{fnum(z)}))")
        vp[k] = em.add(f"VERTEX_POINT('',#{cp[k]})")

    edges = {}  # frozenset{a,b} -> (edge_curve_id, forward_pair=(a,b))

    def edge(a, b):
        key = frozenset((a, b))
        if key in edges:
            ec, (fa, _) = edges[key]
            return ec, (fa == a)
        ax, ay, az = corner(lo, hi, a)
        bx, by, bz = corner(lo, hi, b)
        dx, dy, dz = bx - ax, by - ay, bz - az
        length = (dx * dx + dy * dy + dz * dz) ** 0.5
        d = em.add(f"DIRECTION('',({fnum(dx / length)},{fnum(dy / length)},{fnum(dz / length)}))")
        vec = em.add(f"VECTOR('',#{d},{fnum(length)})")
        p0 = em.add(f"CARTESIAN_POINT('',({fnum(ax)},{fnum(ay)},{fnum(az)}))")
        line = em.add(f"LINE('',#{p0},#{vec})")
        ec = em.add(f"EDGE_CURVE('',#{vp[a]},#{vp[b]},#{line},.T.)")
        edges[key] = (ec, (a, b))
        return ec, True

    faces = []
    for loop, normal, refd in FACES:
        oriented = []
        for i in range(4):
            a, b = loop[i], loop[(i + 1) % 4]
            ec, fwd = edge(a, b)
            oriented.append(em.add(f"ORIENTED_EDGE('',*,*,#{ec},{'.T.' if fwd else '.F.'})"))
        eloop = em.add("EDGE_LOOP('',(%s))" % ",".join(f"#{o}" for o in oriented))
        bound = em.add(f"FACE_OUTER_BOUND('',#{eloop},.T.)")
        nrm = em.add(f"DIRECTION('',({fnum(normal[0])},{fnum(normal[1])},{fnum(normal[2])}))")
        ref = em.add(f"DIRECTION('',({fnum(refd[0])},{fnum(refd[1])},{fnum(refd[2])}))")
        axis = em.add(f"AXIS2_PLACEMENT_3D('',#{cp[loop[0]]},#{nrm},#{ref})")
        plane = em.add(f"PLANE('',#{axis})")
        faces.append(em.add(f"ADVANCED_FACE('',(#{bound}),#{plane},.T.)"))
    shell = em.add("CLOSED_SHELL('',(%s))" % ",".join(f"#{f}" for f in faces))
    return em.add(f"MANIFOLD_SOLID_BREP('solder',#{shell})")


def collect_blobs():
    """Return [(x, y, z0, z1, half), ...] in STEP coords, one per SMD/edge pad."""
    b = pcbnew.LoadBoard(BOARD)
    keep = {pcbnew.PAD_ATTRIB_SMD, pcbnew.PAD_ATTRIB_CONN}
    blobs = []
    for fp in b.GetFootprints():
        if getattr(fp, "IsDNP", lambda: False)():     # --no-dnp drops these models; nothing to anchor
            continue
        flipped = fp.IsFlipped()
        for p in fp.Pads():
            if p.GetAttribute() not in keep:           # PTH/NPTH pads self-anchor via their pins
                continue
            pos = p.GetPosition()
            x, y = pcbnew.ToMM(pos.x), -pcbnew.ToMM(pos.y)
            sz = p.GetSize()
            side = min(SIDE_MAX, max(SIDE_MIN, max(pcbnew.ToMM(sz.x), pcbnew.ToMM(sz.y)) + MARGIN))
            half = side / 2.0
            z0, z1 = (BOT_Z - H, BOT_Z + EMB) if flipped else (TOP_Z - EMB, TOP_Z + H)
            blobs.append((x, y, z0, z1, half))
    return blobs


def find_assembly_rep(text):
    """#id of the top assembly's SHAPE_REPRESENTATION (the one mapped at identity)."""
    # Resolve each SHAPE_DEFINITION_REPRESENTATION's product name; pick the board's.
    ent = dict(re.findall(r'#(\d+)\s*=\s*([A-Z_0-9]+)', text))
    bodies = {m.group(1): m.group(2)
              for m in re.finditer(r'#(\d+)\s*=\s*[A-Z_0-9]+\s*(\([^;]*\))', text)}

    def prod_name(start):
        seen, stack = set(), [start]
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            if ent.get(x) == "PRODUCT":
                nm = re.findall(r"'([^']*)'", bodies.get(x, ""))
                return nm[0] if nm else ""
            stack += re.findall(r'#(\d+)', bodies.get(x, ""))
        return ""

    best = None
    for m in re.finditer(r'#(\d+)\s*=\s*SHAPE_DEFINITION_REPRESENTATION\s*\(([^;]*)\)', text):
        rs = re.findall(r'#(\d+)', m.group(2))
        if len(rs) < 2:
            continue
        if "doorbell" in prod_name(rs[0]).lower():
            return rs[1]
        best = best or rs[1]
    return best


def items_tuple_span(text, rep_id):
    """(insert_pos, context_id) for the rep's item list: where to splice solid #ids."""
    m = re.search(r'#%s\s*=\s*SHAPE_REPRESENTATION\s*\(' % rep_id, text)
    i = text.index("(", m.start())            # entity arg-list open paren
    j = text.index("(", i + 1)                # items tuple open paren
    depth = 0
    k = j
    while k < len(text):
        if text[k] == "(":
            depth += 1
        elif text[k] == ")":
            depth -= 1
            if depth == 0:
                break
        k += 1
    ctx = re.findall(r'#(\d+)', text[k:text.index(";", k)])
    return k, (ctx[0] if ctx else None)


def main():
    step = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "fab", "doorbell.step")
    if not os.path.exists(step):
        sys.exit(f"  step_solder: {step} not found (run the STEP export first)")
    text = open(step).read()

    blobs = collect_blobs()
    if not blobs:
        sys.stderr.write("  step_solder: no SMD pads found — nothing added\n")
        return

    rep_id = find_assembly_rep(text)
    if not rep_id:
        sys.exit("  step_solder: could not locate the assembly SHAPE_REPRESENTATION")
    insert_at, _ctx = items_tuple_span(text, rep_id)

    start = max(int(n) for n in re.findall(r'#(\d+)\s*=', text))
    em = Emitter(start)
    solids = [box_solid(em, (x - hf, y - hf, z0), (x + hf, y + hf, z1))
              for (x, y, z0, z1, hf) in blobs]

    refs = "," + ",".join(f"#{s}" for s in solids)        # splice into rep item tuple
    block = "\n".join(em.lines) + "\n"
    out = text[:insert_at] + refs + text[insert_at:]
    end = out.rindex("ENDSEC;")                            # DATA section terminator
    out = out[:end] + block + out[end:]
    open(step, "w").write(out)

    sys.stderr.write("  step_solder: anchored %d SMD pads (%d solids, %d entities) into rep#%s\n"
                     % (len(blobs), len(solids), em.id - start, rep_id))


if __name__ == "__main__":
    main()
