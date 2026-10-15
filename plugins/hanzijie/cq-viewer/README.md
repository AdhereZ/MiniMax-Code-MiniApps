# CadQuery Viewer

[简体中文](README.zh-CN.md) | English

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/cqviewer-lockup-dark.png">
  <img alt="CadQuery Viewer" src="docs/brand/cqviewer-lockup-light.png" width="420">
</picture>

A local 3D viewer for MiniMax Code. Open STL and STEP models from your project folder — STEP assemblies keep their part names, colours, and real CAD edges — watch models pushed live from CadQuery scripts, then mark positions on the model and send them to the conversation in one click, so the AI knows exactly which face, hole, or edge you mean.

Author: [HanZijie](https://github.com/HanZijie) · Version: `1.0.0`

![CadQuery Viewer: a STEP assembly with three annotations ready to send](docs/preview.jpg)

## What it does

| Area | Detail |
| --- | --- |
| Viewer | Full-window canvas, orthographic camera, Z up (CadQuery convention). Seven preset views, fit, edges, grid, X/Y/Z section plane, axis gizmo. Follows the light/dark theme. |
| Project folders | Lists every `.stl`, `.step`, `.stp` in a folder (recursive); tick a file to open it. Open files reload when they change on disk. |
| STEP | Converted locally into a mesh that keeps the assembly: part names, placements, colours, and B-rep edges (seam lines hidden). The "Opened" list shows how many parts a file has. Results are cached. |
| CadQuery push | `python/cqview.py` → `show(part_or_assembly, "name")` writes into `~/.cqview/scene/`; the Viewer shows it immediately. Assemblies are pushed as STEP so names and colours survive. |
| Annotate | Pick mode (`P`): click several points on the surface, then confirm (`Enter`). Each point records part, sub-part (for assemblies), coordinates, and surface normal; add a note per point plus one instruction for the AI. |
| Send to AI | One button sends the composed message to the conversation (see [Sending to the conversation](#sending-to-the-conversation)). The same data is kept in `~/.cqview/selection.json` for agents and scripts. |

## Requirements

- MiniMax Code with Mini App support.
- STL needs nothing else.
- STEP needs Python 3 with [CadQuery](https://github.com/CadQuery/cadquery) (`pip install cadquery`). The Viewer looks for `$CQVIEW_PYTHON`, `python3`, `python`, `/usr/bin/python3`, `/opt/homebrew/bin/python3`, `/usr/local/bin/python3` and uses the first one that can `import cadquery`.

## Install & use

Copy this directory into the active MiniMax Code data directory under `plugins/`. `<dataDir>` defaults to `~/.minimax`, so the default install path is:

```text
<dataDir>/plugins/cq-viewer/
```

Keep the hidden `.minimax-plugin/` directory. Restart MiniMax Code, then open "CadQuery Viewer" from the plugin list or ask the assistant, for example "打开 CadQuery Viewer 看一下这个项目里的模型".

1. **Pick a folder.** Click the folder icon on the left, then **+** to add a folder (any folder inside your home directory). An assistant can also open the page on the current workspace with the path `/viewer?root=<absolute folder path>`.
2. **Open models.** Tick files in the list. Use the toolbar at the bottom for views, fit (`F`), edges, grid, and section.
3. **Annotate.** Press **选点** (`P`), click points on the model, press **确认** (`Enter`). Write a note for each point and what you want the AI to do.
4. **Send.** Press **发送到对话** (`⌘/Ctrl + Enter` in the instruction box).

| Key | Action |
| --- | --- |
| `P` | Enter / leave pick mode |
| `Enter` | Confirm the picked points |
| `Backspace` | Remove the last unconfirmed point |
| `Esc` | Close popover → leave pick mode → close panel |
| `⌘/Ctrl + Z` | Undo the last annotation change |
| `F` | Fit the view |

### Push models from CadQuery

```python
import sys; sys.path.insert(0, "path/to/cq-viewer/python")
import cadquery as cq
from cqview import show, show_file, clear, selection

bracket = cq.Workplane("XY").box(80, 40, 6).edges("|Z").fillet(6)
show(bracket, "bracket")                     # STL, fast
show(my_assembly, "mount")                   # cq.Assembly -> STEP, keeps names and colours
show_file("scans/housing.stl", "scan", opacity=0.35, edges=False)
print(selection())                           # the annotations you made in the Viewer
clear()                                      # empty the pushed scene
```

`python3 python/demo_viewer.py` pushes a small coloured assembly to try it out.

### Sending to the conversation

The page first performs the standard MCP Apps handshake (`ui/initialize` over `postMessage`). If the Host grants the `message` capability, **Send** issues a `ui/message` request with the composed text. If the Host does not answer the handshake, **Send** falls back to the MiniMax Code page bridge `window.mcode.miniapp.message.append`, which places the text in the conversation input; press Enter there to send. Outside MiniMax Code the button becomes **复制内容** and copies the text instead.

## Data & access

**What it reads**

- Folders you register: directory listings plus the contents of `.stl`, `.step`, and `.stp` files only. Hidden directories, `node_modules`, `__pycache__`, `venv`, and `site-packages` are skipped; symbolic links are never followed; at most 10 levels, 50,000 entries, and 1,000 model files per folder. A folder must be inside your home directory, and cannot be the home directory itself, `~/Library`, or a hidden top-level folder.
- `~/.cqview/scene/` — models pushed by `python/cqview.py` (`.stl`, `.step`, `.stp`, `scene.json`).
- `~/.cqview/roots.json` and `~/.cqview/selection.json` (its own files, see below).

**What it writes.** Outside `dataDir` it writes only its own exchange folder `~/.cqview/`, always atomically (temp file in the same folder, then rename):

- `~/.cqview/roots.json` — the folders you registered (when you add one, or the page is opened with `?root=`).
- `~/.cqview/selection.json` — the current annotations: points, notes, instruction, and the absolute path of each annotated model. Rewritten on every change; the last write wins.
- It creates `~/.cqview/` and `~/.cqview/scene/` if missing. It never writes model files; only `cqview.py` does.

Inside `dataDir` it keeps `step-cache/`, the converted STEP meshes keyed by file path, size, and modification time. Deleting it is safe.

**Processes.** Python is started only when a STEP file is opened, with arguments passed as an array (no shell), stdio ignored, and every child killed on shutdown:

- Probe, until one candidate works: `<python> -c "import cadquery"` (60 s timeout).
- Convert: `<python> <plugin>/miniapp/node/step_mesh.py <model.step> <dataDir>/step-cache/<hash>.cqvm.<pid>.tmp` (300 s timeout).
- Fallback if that fails: `<python> -c <inline STEP→STL script> <model.step> <dataDir>/step-cache/<hash>.stl.<pid>.tmp`.

The model path is validated first (registered folder, allowed extension, no symbolic link) and passed as a single argument.

**Watching.** While the Viewer runs it watches `~/.cqview/scene/` and each registered folder (recursively) for model changes.

**Browser storage** holds view preferences only: selected folder, opened files, hidden parts, edge/grid toggles.

**Host page bridge.** On **Send** only, as described above.

**Network.** None. Three.js is vendored.

## Tested environment

- MiniMax Code desktop `3.1.1-preview.4597` (Electron 42), macOS 26 (Apple Silicon); Python 3.9 with CadQuery 2.5.2 / OCP 7.7.2.
- In MiniMax Code: install, open, folder registration via `?root=`, and Host bridge detection (the `ui/initialize` handshake is not answered in this build, so the fallback path is used).
- End-to-end in headless Chrome against the same Node entry: STL and STEP opening (multi-level assemblies with names, colours, instances), live reload, pick → confirm → notes, the `ui/message` path against a simulated MCP Apps host, the fallback path against a simulated page bridge, and the button switching to copy mode when no Host is present.
- Not verified: Windows; that the fallback actually fills the conversation input in this build; STEP files with face-level colours from other CAD tools.

## Third-party

[three.js](https://threejs.org/) r170 (`three.module.min.js`, `OrbitControls.js`, `STLLoader.js`), MIT — see `miniapp/client/assets/vendor/LICENSE-three.txt`. STEP conversion uses the CadQuery / OCP installed on your machine; nothing from it is bundled.

## License

[MIT](LICENSE)
