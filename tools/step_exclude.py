#!/usr/bin/env python3
"""Compute the --component-filter include-list for the fit-test STEP export.

kicad-cli's `pcb export step --component-filter` is include-only, so to *drop*
parts we pass every reference except the excluded ones. A footprint is excluded
when it carries a truthy custom field `STEP_Exclude` (set it in KiCad via
Footprint Properties → add field `STEP_Exclude` = `true`). This keeps the choice
of what-to-omit with the parts themselves (e.g. SW3/SW4 left off so the bare
board can be fit-tested against the real switches) rather than hard-coded here.

stdout: comma-separated include-list (empty when nothing is excluded, so the
        caller can skip --component-filter and export the whole board).
stderr: human-readable summary of what was excluded.
"""
import re
import sys

FIELD = "STEP_Exclude"
TRUTHY = {"true", "yes", "1", "exclude", "x"}


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


def footprint_blocks(text):
    """Yield each top-level (footprint ...) s-expression substring."""
    needle = "(footprint "
    i = text.find(needle)
    while i != -1:
        j = sexpr_end(text, i)
        yield text[i:j + 1]
        i = text.find(needle, j + 1)


def main():
    pcb = sys.argv[1]
    text = open(pcb).read()

    refs, excluded = [], []
    ref_re = re.compile(r'\(property "Reference" "([^"]+)"')
    excl_re = re.compile(r'\(property "%s" "([^"]*)"' % re.escape(FIELD))

    for block in footprint_blocks(text):
        m = ref_re.search(block)
        if not m:
            continue
        ref = m.group(1)
        refs.append(ref)
        e = excl_re.search(block)
        if e and e.group(1).strip().lower() in TRUTHY:
            excluded.append(ref)

    if excluded:
        keep = [r for r in refs if r not in set(excluded)]
        print(",".join(keep))
        sys.stderr.write("  excluded from STEP (%s): %s\n"
                         % (FIELD, " ".join(sorted(excluded))))
    else:
        # nothing flagged → caller exports the full board (no filter)
        sys.stderr.write("  excluded from STEP (%s): (none)\n" % FIELD)


if __name__ == "__main__":
    main()
