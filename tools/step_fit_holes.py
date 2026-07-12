#!/usr/bin/env python3
"""Write a throwaway copy of the PCB with the FIT-TEST footprints' THT drills enlarged.

A footprint flagged **`STEP_Exclude`**=<truthy> is one whose 3D model is dropped from the STEP
exports (the same flag `step_exclude.py` reads) so the REAL part can be fit-tested against the
printed/modelled board instead of a printed body. For the real part's pins/pegs to drop into the
holes, the drills have to clear FDM undersizing — a 0.4 mm-nozzle / 0.2 mm-layer print reproduces
small vertical holes undersized — so every THT pad drill of a flagged footprint is enlarged by
OVERSIZE_MM here.

Selection is driven entirely by the STEP_Exclude flag (no hard-coded refdes), so the regular
assembly export (`build.sh step`) and the bare-board export (`build.sh board-step`) stay in sync:
flag a part in KiCad and both get the matching enlarged holes. The rewrite lands ONLY on a
throwaway copy — the committed board and every fab output keep the real drill sizes.

usage: step_fit_holes.py IN.kicad_pcb OUT.kicad_pcb
"""
import re
import sys

FIELD = "STEP_Exclude"
TRUTHY = {"true", "yes", "1", "exclude", "x"}
OVERSIZE_MM = 0.5      # added to every THT pad drill of a flagged footprint

REF_RE = re.compile(r'\(property "Reference" "([^"]+)"')
EXCL_RE = re.compile(r'\(property "%s" "([^"]*)"' % re.escape(FIELD))


def sexpr_end(text, start):
    """Return the closing-paren index, ignoring parentheses inside strings."""
    depth = 0
    in_string = False
    escaped = False
    for j in range(start, len(text)):
        c = text[j]
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j
    return len(text) - 1


def footprint_spans(text):
    """Yield (start, end) of each top-level (footprint ...) s-expression."""
    needle = "(footprint "
    i = text.find(needle)
    while i != -1:
        j = sexpr_end(text, i)
        yield i, j + 1
        i = text.find(needle, j + 1)


def enlarge_drills(block, changes):
    """Bump every (drill ...) in a footprint block by OVERSIZE_MM (circular + oval slots)."""
    def oval(m):
        nx, ny = float(m.group(1)) + OVERSIZE_MM, float(m.group(2)) + OVERSIZE_MM
        changes.append((f"oval {m.group(1)}x{m.group(2)}", f"{nx:g}x{ny:g}"))
        return f"(drill oval {nx:g} {ny:g})"

    def circ(m):
        new = float(m.group(1)) + OVERSIZE_MM
        changes.append((m.group(1), f"{new:g}"))
        return f"(drill {new:g})"

    block = re.sub(r"\(drill oval ([\d.]+) ([\d.]+)\)", oval, block)
    block = re.sub(r"\(drill ([\d.]+)\)", circ, block)
    return block


def main():
    inp, outp = sys.argv[1], sys.argv[2]
    text = open(inp).read()

    out, last, summary = [], 0, {}
    for i, j in footprint_spans(text):
        out.append(text[last:i])
        block = text[i:j]
        ref = REF_RE.search(block)
        excl = EXCL_RE.search(block)
        if ref and excl and excl.group(1).strip().lower() in TRUTHY:
            changes = []
            block = enlarge_drills(block, changes)
            if changes:
                summary[ref.group(1)] = changes
        out.append(block)
        last = j
    out.append(text[last:])
    open(outp, "w").write("".join(out))

    if summary:
        for ref in sorted(summary):
            parts = ", ".join("%s→%s" % c for c in sorted(set(summary[ref])))
            sys.stderr.write("  %s: fit-test drills +%g mm (%s)\n" % (ref, OVERSIZE_MM, parts))
    else:
        sys.stderr.write("  no %s footprints flagged — drills unchanged\n" % FIELD)


if __name__ == "__main__":
    main()
