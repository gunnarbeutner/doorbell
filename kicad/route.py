#!/usr/bin/env python3
"""Autoroute kicad/doorbell.kicad_pcb with Freerouting.

Exports a Specctra DSN from the board (pcbnew), runs Freerouting headless to produce a
.ses, then imports the session back and saves the routed board in place. Re-running
gen_pcb.py wipes the routes (fresh ratsnest), so the workflow is: edit design -> regen
board -> route.

Run with KiCad's bundled Python (owns pcbnew); see build.sh. Env:
    FR_PASSES   Freerouting max passes (default 20)
    FREEROUTING path to the freerouting launcher
"""
import os, sys, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
import pcbnew

BOARD = os.path.join(HERE, "doorbell.kicad_pcb")
DSN = os.path.join(HERE, "doorbell.dsn")
SES = os.path.join(HERE, "doorbell.ses")
FREEROUTING = os.environ.get("FREEROUTING",
                             "/Applications/freerouting.app/Contents/MacOS/freerouting")
PASSES = os.environ.get("FR_PASSES", "20")

board = pcbnew.LoadBoard(BOARD)
if not pcbnew.ExportSpecctraDSN(board, DSN):
    sys.exit("DSN export failed")
print(f"exported {DSN}")

subprocess.run([FREEROUTING, "-de", DSN, "-do", SES, "-mp", PASSES, "-da"], check=True)

if not pcbnew.ImportSpecctraSES(board, SES):
    sys.exit("SES import failed")
pcbnew.SaveBoard(BOARD, board)
print(f"routed -> {BOARD} ({len(board.GetTracks())} track segments)")
