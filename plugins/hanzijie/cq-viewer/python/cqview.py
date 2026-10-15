"""cqview — push CadQuery geometry into the CadQuery Viewer Mini App.

The viewer watches one fixed folder and reloads whenever a file changes:

    ~/.cqview/scene/<name>.stl|.step   one file per part (assemblies go as STEP: names + colours kept)
    ~/.cqview/scene/scene.json         optional colour / opacity / edge flags
    ~/.cqview/selection.json           positions annotated in the viewer (read with selection())

Usage:

    import sys; sys.path.insert(0, "path/to/cq-viewer/python")   # or copy cqview.py next to your script
    from cqview import show, show_file, hide, clear, selection

    show(bracket, "bracket")                                   # Workplane / Shape -> STL
    show(assy, "screen_mount")                                 # Assembly -> STEP, per-part colours/names
    show(bracket, "bracket", format="step")                    # force STEP (exact B-rep edges)
    show_file("scans/housing.stl", "housing_scan",
              color="#9aa0a6", opacity=0.35, edges=False)      # reference mesh (.stl/.step/.stp)
    print(selection())                                         # what was annotated
    clear()                                                    # empty the pushed scene
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

EXCHANGE_DIR = Path.home() / ".cqview"
SCENE_DIR = EXCHANGE_DIR / "scene"
META_FILE = SCENE_DIR / "scene.json"
SELECTION_FILE = EXCHANGE_DIR / "selection.json"
MODEL_EXTS = (".stl", ".step", ".stp")

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

__all__ = ["show", "show_file", "hide", "clear", "selection", "SCENE_DIR", "SELECTION_FILE"]


def show(
    obj: Any,
    name: str = "part",
    *,
    color: Optional[str] = None,
    opacity: Optional[float] = None,
    edges: Optional[bool] = None,
    format: Optional[str] = None,
    tolerance: float = 0.05,
    angular_tolerance: float = 0.1,
) -> Path:
    """Write a CadQuery object into the viewer's scene (atomic replace).

    Assemblies are written as STEP so the viewer keeps part names, colours and placements;
    everything else is tessellated to STL unless format="step". tolerance is the absolute
    chordal deviation in mm (STL only); angular_tolerance is in radians.
    """
    import cadquery as cq

    _check_name(name)
    fmt = (format or ("step" if isinstance(obj, cq.Assembly) else "stl")).lower()
    if fmt not in ("stl", "step"):
        raise ValueError("format must be 'stl' or 'step'")
    SCENE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=SCENE_DIR)
    os.close(fd)
    try:
        if fmt == "step":
            if isinstance(obj, cq.Assembly):
                obj.export(tmp, "STEP")
            else:
                cq.exporters.export(_to_shape(obj), tmp, "STEP")
            if os.path.getsize(tmp) == 0:
                raise RuntimeError(f"STEP export produced an empty file for {name!r}")
            dst = SCENE_DIR / f"{name}.step"
        else:
            ok = _to_shape(obj).exportStl(
                tmp, tolerance=tolerance, angularTolerance=angular_tolerance, ascii=False, relative=False
            )
            if ok is False or os.path.getsize(tmp) <= 84:
                raise RuntimeError(f"STL export produced no triangles for {name!r}")
            dst = SCENE_DIR / f"{name}.stl"
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    _drop_other_formats(name, keep=dst)
    _set_meta(name, color=color, opacity=opacity, edges=edges)
    return dst


def show_file(
    path: "str | os.PathLike[str]",
    name: Optional[str] = None,
    *,
    color: Optional[str] = None,
    opacity: Optional[float] = None,
    edges: Optional[bool] = None,
) -> Path:
    """Copy an existing STL or STEP (e.g. a scan or a supplier model) into the scene."""
    src = Path(path).expanduser()
    ext = src.suffix.lower()
    if ext not in MODEL_EXTS:
        raise ValueError("show_file accepts .stl, .step or .stp files")
    name = name or re.sub(r"[^A-Za-z0-9._-]", "_", src.stem).strip("._-") or "ref"
    _check_name(name)
    SCENE_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=SCENE_DIR)
    os.close(fd)
    try:
        shutil.copyfile(src, tmp)
        dst = SCENE_DIR / f"{name}{ext}"
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    _drop_other_formats(name, keep=dst)
    _set_meta(name, color=color, opacity=opacity, edges=edges)
    return dst


def hide(name: str) -> None:
    """Remove one part from the scene."""
    _check_name(name)
    for ext in MODEL_EXTS:
        (SCENE_DIR / f"{name}{ext}").unlink(missing_ok=True)
    meta = _read_meta()
    if meta["parts"].pop(name, None) is not None:
        _write_json(META_FILE, meta)


def clear() -> None:
    """Remove every part from the scene."""
    if not SCENE_DIR.exists():
        return
    for ext in MODEL_EXTS:
        for f in SCENE_DIR.glob(f"*{ext}"):
            f.unlink(missing_ok=True)
    META_FILE.unlink(missing_ok=True)


def _drop_other_formats(name: str, keep: Path) -> None:
    for ext in MODEL_EXTS:
        other = SCENE_DIR / f"{name}{ext}"
        if other != keep:
            other.unlink(missing_ok=True)


def selection() -> Optional[dict]:
    """Return the positions selected in the viewer, or None.

    {
      "updated": "...", "unit": "mm", "count": 2,
      "instruction": "在这几个位置加 M3 安装孔",      # 「想让 AI 做什么」, optional
      "points": [
        {"index": 1, "label": "#1", "part": "bracket", "x": .., "y": .., "z": ..,
         "normal": {"x": .., "y": .., "z": ..}, "note": "这里加 R2 圆角",
         "file": "/abs/path/of/the/model.stl", "ref": {...}},
        ...
      ],
      "segments": [{"from": 1, "to": 2, "d": .., "dx": .., "dy": .., "dz": ..}]
    }
    """
    try:
        return json.loads(SELECTION_FILE.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------- internals


def _to_shape(obj: Any):
    import cadquery as cq

    if isinstance(obj, cq.Assembly):
        return obj.toCompound()
    if isinstance(obj, cq.Workplane):
        shapes = [o for o in obj.vals() if isinstance(o, cq.Shape)]
        if not shapes:
            raise ValueError("Workplane has no shapes on the stack")
        return shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
    if isinstance(obj, cq.Shape):
        return obj
    raise TypeError(f"Cannot show object of type {type(obj).__name__}")


def _check_name(name: str) -> None:
    if not _NAME_RE.match(name):
        raise ValueError(
            f"Invalid part name {name!r}: use letters, digits, '.', '_' or '-' (max 100, no leading dot)"
        )


def _read_meta() -> dict:
    try:
        data = json.loads(META_FILE.read_text("utf-8"))
        if isinstance(data, dict) and isinstance(data.get("parts"), dict):
            return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {"parts": {}}


def _set_meta(name: str, *, color: Optional[str], opacity: Optional[float], edges: Optional[bool]) -> None:
    entry: dict = {}
    if color is not None:
        if not _COLOR_RE.match(color):
            raise ValueError("color must look like '#rrggbb'")
        entry["color"] = color.lower()
    if opacity is not None:
        entry["opacity"] = max(0.05, min(1.0, float(opacity)))
    if edges is not None:
        entry["edges"] = bool(edges)
    meta = _read_meta()
    if meta["parts"].get(name) == entry or (not entry and name not in meta["parts"]):
        return
    if entry:
        meta["parts"][name] = entry
    else:
        meta["parts"].pop(name, None)
    _write_json(META_FILE, meta)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
