"""STEP -> CQVM mesh for the CadQuery Viewer.

Reads a STEP file with OCCT's XCAF reader so assembly structure, part names, colours and
placements survive, tessellates every body, extracts real B-rep edges (seams skipped) and
writes one compact binary file:

    b"CQVM" | uint32 version | uint32 json_len | json (utf-8, padded to 4) | binary payload

The JSON header describes typed arrays inside the payload (byte offsets are 4-aligned):
    positions float32 xyz, indices uint32, colors float32 rgb (linear, -1 = "no colour"),
    edges float32 xyz pairs (line segments), bodies [{name, path, color, tri: [start, count]}].

Usage: python3 step_mesh.py <input.step> <output.cqvm>
Exit codes: 0 ok, 2 bad args, 3 unreadable STEP, 4 no geometry.
"""

import json
import struct
import sys
from array import array

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Bnd import Bnd_Box
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

VERSION = 1
COLOR_TYPES = (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen)


def label_name(label):
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        try:
            return repair_text(attr.Get().ToExtString())
        except Exception:
            return None
    return None


def repair_text(s):
    """UTF-8 names often come back decoded as Latin-1 ("æ¯æ¶"); undo that when it round-trips."""
    if not s or all(ord(ch) < 128 for ch in s) or any(ord(ch) > 255 for ch in s):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def meaningful(name):
    """Skip auto-generated component ids and exporter boilerplate."""
    if not name:
        return False
    n = name.strip()
    return bool(n) and not n.isdigit() and not n.startswith("=>") and not n.startswith("Open CASCADE STEP translator")


def label_color(label):
    c = Quantity_Color()
    for t in COLOR_TYPES:
        try:
            if XCAFDoc_ColorTool.GetColor_s(label, t, c):
                return (c.Red(), c.Green(), c.Blue())  # linear RGB, what three.js vertex colours expect
        except Exception:
            pass
    return None


class Collector:
    def __init__(self, lin_defl, ang_defl):
        self.lin = lin_defl
        self.ang = ang_defl
        self.pos = array("f")
        self.col = array("f")
        self.idx = array("I")
        self.edges = array("f")
        self.bodies = []

    def add_body(self, shape, name, path, body_color, face_colors):
        if shape.IsNull():
            return
        # instances share their TShape, so OCCT skips faces that already carry a triangulation
        BRepMesh_IncrementalMesh(shape, self.lin, False, self.ang, True)
        tri_start = len(self.idx) // 3
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        while explorer.More():
            face = TopoDS.Face_s(explorer.Current())
            explorer.Next()
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is None:
                continue
            trsf = loc.Transformation()
            color = body_color
            for sub_face, sub_color in face_colors:
                if sub_face.IsSame(face):
                    color = sub_color
                    break
            rgb = color if color is not None else (-1.0, -1.0, -1.0)
            base = len(self.pos) // 3
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(trsf)
                self.pos.extend((p.X(), p.Y(), p.Z()))
                self.col.extend(rgb)
            flip = face.Orientation() == TopAbs_REVERSED
            for t in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(t).Get()
                if flip:
                    b, c = c, b
                self.idx.extend((base + a - 1, base + b - 1, base + c - 1))
        tri_count = len(self.idx) // 3 - tri_start
        if tri_count:
            self.bodies.append(
                {
                    "name": name,
                    "path": path,
                    "color": list(body_color) if body_color else None,
                    "tri": [tri_start, tri_count],
                }
            )
        self.add_edges(shape)

    def add_edges(self, shape):
        edge_faces = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_faces)
        for i in range(1, edge_faces.Extent() + 1):
            edge = TopoDS.Edge_s(edge_faces.FindKey(i))
            if BRep_Tool.Degenerated_s(edge):
                continue
            seam = False
            for f in edge_faces.FindFromIndex(i):
                if BRep_Tool.IsClosed_s(edge, TopoDS.Face_s(f)):
                    seam = True
                    break
            if seam:
                continue
            try:
                curve = BRepAdaptor_Curve(edge)
                disc = GCPnts_TangentialDeflection(curve, self.ang, self.lin)
            except Exception:
                continue
            n = disc.NbPoints()
            if n < 2:
                continue
            prev = disc.Value(1)
            for j in range(2, n + 1):
                cur = disc.Value(j)
                self.edges.extend((prev.X(), prev.Y(), prev.Z(), cur.X(), cur.Y(), cur.Z()))
                prev = cur


def sub_face_colors(label):
    """Face-level colours stored as sub-shape labels of a simple shape."""
    out = []
    subs = TDF_LabelSequence()
    XCAFDoc_ShapeTool.GetSubShapes_s(label, subs)
    for i in range(1, subs.Length() + 1):
        sub = subs.Value(i)
        color = label_color(sub)
        if color is None:
            continue
        shape = XCAFDoc_ShapeTool.GetShape_s(sub)
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        while explorer.More():
            out.append((explorer.Current(), color))
            explorer.Next()
    return out


def walk(collector, label, loc, inherited_color, path, instance=None):
    if XCAFDoc_ShapeTool.IsAssembly_s(label):
        comps = TDF_LabelSequence()
        XCAFDoc_ShapeTool.GetComponents_s(label, comps, False)
        own = label_color(label) or inherited_color
        for i in range(1, comps.Length() + 1):
            comp = comps.Value(i)
            ref = TDF_Label()
            if not XCAFDoc_ShapeTool.GetReferredShape_s(comp, ref):
                continue
            comp_loc = XCAFDoc_ShapeTool.GetLocation_s(comp)
            color = label_color(comp) or label_color(ref) or own
            comp_name, ref_name = label_name(comp), label_name(ref)
            comp_name = comp_name if meaningful(comp_name) else None
            if XCAFDoc_ShapeTool.IsAssembly_s(ref):
                child = comp_name or (ref_name if meaningful(ref_name) else None)
                child_path = path + [child] if child and (not path or path[-1] != child) else path
                walk(collector, ref, loc.Multiplied(comp_loc), color, child_path)
            else:
                walk(collector, ref, loc.Multiplied(comp_loc), color, path, instance=comp_name)
        return
    shape = XCAFDoc_ShapeTool.GetShape_s(label)
    if shape.IsNull():
        return
    own_name = label_name(label)
    own_name = own_name if meaningful(own_name) else None
    if own_name and own_name.endswith("_part"):
        own_name = None  # CadQuery names a shared shape "<first instance>_part"; not a real part name
    display = instance or own_name or (path[-1] if path else None)
    body_path = path + [display] if display and (not path or path[-1] != display) else path
    color = label_color(label) or inherited_color
    faces = sub_face_colors(label)
    if faces and not loc.IsIdentity():
        faces = [(f.Moved(loc), c) for f, c in faces]
    collector.add_body(shape.Moved(loc), display, "/".join(body_path), color, faces)


def main():
    if len(sys.argv) != 3:
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    app.InitDocument(doc)
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    reader.SetLayerMode(False)
    if reader.ReadFile(src) != IFSelect_RetDone:
        sys.exit(3)
    if not reader.Transfer(doc):
        sys.exit(3)

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        sys.exit(4)

    # deflection from the overall size so big and small models both look right
    box = Bnd_Box()
    for i in range(1, roots.Length() + 1):
        BRepBndLib.Add_s(XCAFDoc_ShapeTool.GetShape_s(roots.Value(i)), box)
    if box.IsVoid():
        sys.exit(4)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    diag = ((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) ** 0.5
    collector = Collector(lin_defl=max(0.01, diag * 2e-4), ang_defl=0.2)

    for i in range(1, roots.Length() + 1):
        root = roots.Value(i)
        root_name = label_name(root)
        walk(collector, root, TopLoc_Location(), label_color(root), [root_name] if meaningful(root_name) else [])

    if not collector.idx:
        sys.exit(4)

    has_colors = any(v >= 0 for v in collector.col[: min(len(collector.col), 3_000_000)])
    blobs = []
    offset = 0

    def add(arr):
        nonlocal offset
        data = arr.tobytes()
        entry = {"offset": offset, "length": len(arr)}
        blobs.append(data)
        offset += len(data)  # float32 / uint32 keep 4-byte alignment
        return entry

    header = {
        "unit": "mm",
        "positions": add(collector.pos),
        "indices": add(collector.idx),
        "colors": add(collector.col) if has_colors else None,
        "edges": add(collector.edges),
        "bodies": collector.bodies,
        "bbox": [xmin, ymin, zmin, xmax, ymax, zmax],
    }
    head = json.dumps(header, ensure_ascii=False).encode("utf-8")
    head += b" " * ((4 - len(head) % 4) % 4)
    with open(dst, "wb") as fh:
        fh.write(b"CQVM")
        fh.write(struct.pack("<II", VERSION, len(head)))
        fh.write(head)
        for b in blobs:
            fh.write(b)


if __name__ == "__main__":
    main()
