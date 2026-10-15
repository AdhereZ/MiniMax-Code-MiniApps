"""Smoke test for the CadQuery Viewer: `python3 python/demo_viewer.py` (run from the plugin folder).

Pushes a small coloured assembly into the viewer (as STEP, so part names and colours show).
Nothing is written into the project folder. Remove it again with:

    python3 -c "import sys; sys.path.insert(0, 'python'); from cqview import clear; clear()"
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cadquery as cq  # noqa: E402

from cqview import show  # noqa: E402

bracket = (
    cq.Workplane("XY")
    .box(80, 40, 6)
    .edges("|Z")
    .fillet(6)
    .faces(">Z")
    .workplane()
    .rarray(56, 20, 2, 2)
    .cboreHole(5.5, 9, 3)
)
pin = cq.Workplane("XY").circle(2.5).extrude(20).faces(">Z").chamfer(0.6)

assy = cq.Assembly(name="demo")
assy.add(bracket, name="bracket", color=cq.Color(0.45, 0.62, 0.92))
assy.add(pin, name="pin_left", loc=cq.Location((-28, 10, 3)), color=cq.Color(0.96, 0.6, 0.2))
assy.add(pin, name="pin_right", loc=cq.Location((28, 10, 3)), color=cq.Color(0.96, 0.6, 0.2))

print("demo ->", show(assy, "demo_assembly"))
