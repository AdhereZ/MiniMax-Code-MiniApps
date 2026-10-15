// CadQuery Viewer — Client.
// STL/STEP viewer: parts pushed to ~/.cqview/scene plus files opened from registered folders.

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { STLLoader } from './vendor/STLLoader.js';
import { createHostBridge } from './host-bridge.js';

const API_BASE = new URL('../api/', import.meta.url);
/** @param {string} path @param {Record<string,string>} [query] */
function apiUrl(path, query) {
  const u = new URL(path, API_BASE);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const ROOT_ID_RE = /^[a-f0-9]{10}$/;

// ---------------------------------------------------------------- theme
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
document.documentElement.dataset.theme = darkQuery.matches ? 'dark' : 'light';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';

// ---------------------------------------------------------------- prefs (view-only)
const prefs = loadPrefs();
function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem('cqv.prefs.v2') || '{}');
    return {
      hidden: new Set(Array.isArray(raw.hidden) ? raw.hidden.filter((k) => typeof k === 'string') : []),
      opened: Array.isArray(raw.opened) ? raw.opened.filter((k) => typeof k === 'string' && parseFileKey(k)) : [],
      root: typeof raw.root === 'string' ? raw.root : null,
      edges: raw.edges !== false,
      grid: raw.grid !== false,
    };
  } catch {
    return { hidden: new Set(), opened: [], root: null, edges: true, grid: true };
  }
}
function savePrefs() {
  try {
    localStorage.setItem(
      'cqv.prefs.v2',
      JSON.stringify({
        hidden: [...prefs.hidden],
        opened: prefs.opened,
        root: prefs.root,
        edges: prefs.edges,
        grid: prefs.grid,
      }),
    );
  } catch {
    /* storage unavailable: preferences stay in memory */
  }
}

// ---------------------------------------------------------------- DOM
const el = {
  canvas: /** @type {HTMLCanvasElement} */ ($('canvas')),
  viewport: $('viewport'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlayText: $('overlay-text'),
  overlayAction: /** @type {HTMLButtonElement} */ ($('overlay-action')),
  overlayHint: $('overlay-hint'),
  toast: $('toast'),
  rootName: $('root-name'),
  rootSelect: /** @type {HTMLSelectElement} */ ($('root-select')),
  rootPath: $('root-path'),
  rootAddToggle: $('root-add-toggle'),
  rootAddForm: /** @type {HTMLFormElement} */ ($('root-add-form')),
  rootAddInput: /** @type {HTMLInputElement} */ ($('root-add-input')),
  rootAddCancel: $('root-add-cancel'),
  rootAddError: $('root-add-error'),
  fileFilter: /** @type {HTMLInputElement} */ ($('file-filter')),
  files: $('files'),
  filesStatus: $('files-status'),
  parts: $('parts'),
  partsEmpty: $('parts-empty'),
  partsBadge: $('parts-badge'),
  railButtons: /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.rail-btn')]),
  panels: {
    files: $('panel-files'),
    parts: $('panel-parts'),
    info: $('panel-info'),
  },
  markers: $('markers'),
  hoverDot: $('hover-dot'),
  annot: $('annot'),
  annotCount: $('annot-count'),
  annotCollapse: $('annot-collapse'),
  annotFab: $('annot-fab'),
  annotFabCount: $('annot-fab-count'),
  pickList: $('pick-list'),
  pickEmpty: $('pick-empty'),
  composeText: /** @type {HTMLTextAreaElement} */ ($('compose-text')),
  composePreview: $('compose-preview'),
  clearPick: /** @type {HTMLButtonElement} */ ($('clear-pick')),
  sendBtn: /** @type {HTMLButtonElement} */ ($('send-btn')),
  sendLabel: $('send-label'),
  sendStatus: $('send-status'),
  pickToggle: /** @type {HTMLButtonElement} */ ($('pick-toggle')),
  confirmBar: $('confirm-bar'),
  confirmText: $('confirm-text'),
  pendingUndo: /** @type {HTMLButtonElement} */ ($('pending-undo')),
  pendingCancel: /** @type {HTMLButtonElement} */ ($('pending-cancel')),
  pendingConfirm: /** @type {HTMLButtonElement} */ ($('pending-confirm')),
  infoSize: $('info-size'),
  infoCenter: $('info-center'),
  infoGrid: $('info-grid'),
  infoTris: $('info-tris'),
  infoUpdated: $('info-updated'),
  warning: $('scene-warning'),
  fit: $('fit'),
  optEdges: /** @type {HTMLButtonElement} */ ($('opt-edges')),
  optGrid: /** @type {HTMLButtonElement} */ ($('opt-grid')),
  clipToggle: /** @type {HTMLButtonElement} */ ($('clip-toggle')),
  clipPop: $('clip-pop'),
  clipButtons: /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[data-clip]')]),
  clipPos: /** @type {HTMLInputElement} */ ($('clip-pos')),
  clipVal: $('clip-val'),
  viewButtons: /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[data-view]')]),
};

/**
 * @param {'loading'|'empty'|'error'} kind
 * @param {string} title @param {string} text
 * @param {{action?: string, onAction?: () => void, hint?: string}} [opts]
 */
function showOverlay(kind, title, text, opts = {}) {
  el.overlay.hidden = false;
  el.overlay.dataset.kind = kind;
  el.overlayTitle.textContent = title;
  el.overlayText.textContent = text;
  el.overlayAction.hidden = !opts.action;
  el.overlayAction.textContent = opts.action || '';
  el.overlayAction.onclick = opts.onAction || null;
  el.overlayHint.hidden = !opts.hint;
  el.overlayHint.textContent = opts.hint || '';
}
function hideOverlay() {
  el.overlay.hidden = true;
}
let toastTimer = null;
/** Transient notice; `ms = 0` keeps it until replaced or cleared. */
function showToast(text, kind = 'info', ms = 2400) {
  if (toastTimer) clearTimeout(toastTimer);
  el.toast.hidden = false;
  el.toast.dataset.kind = kind;
  el.toast.textContent = text;
  toastTimer = ms ? setTimeout(hideToast, ms) : null;
}
function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  el.toast.hidden = true;
}

// ---------------------------------------------------------------- renderer
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
} catch (error) {
  showOverlay('error', '无法启动 3D 渲染', '当前环境不支持 WebGL。');
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
camera.up.set(0, 0, 1); // CadQuery convention: Z up (must precede OrbitControls)
camera.position.set(100, -100, 100);
scene.add(camera);

const controls = new OrbitControls(camera, el.canvas);
controls.enableDamping = false;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.addEventListener('change', () => {
  updateDepthRange();
  requestRender();
});
controls.addEventListener('start', () => setViewPressed(null));

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f98, 1.4));
const headLight = new THREE.DirectionalLight(0xffffff, 1.8);
const headTarget = new THREE.Object3D();
headLight.position.set(0.6, 0.8, 1);
headTarget.position.set(0, 0, -1);
camera.add(headLight, headTarget);
headLight.target = headTarget;

const partsGroup = new THREE.Group();
const helpersGroup = new THREE.Group();
const pickGroup = new THREE.Group();
scene.add(partsGroup, helpersGroup, pickGroup);

const loader = new STLLoader();
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
let clipAxis = 'off';
const clipList = () => (clipAxis === 'off' ? [] : [clipPlane]);

const edgeMaterial = new THREE.LineBasicMaterial({ color: css('--cqv-edge'), transparent: true, opacity: 0.6 });
const sectionMaterial = new THREE.MeshBasicMaterial({ color: css('--cqv-section'), side: THREE.BackSide });

// ---------------------------------------------------------------- axis gizmo
const gizmo = buildGizmo();
function buildGizmo() {
  const gScene = new THREE.Scene();
  const gCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  gCam.up.set(0, 0, 1);
  const axes = [
    ['X', new THREE.Vector3(1, 0, 0), '--cqv-axis-x'],
    ['Y', new THREE.Vector3(0, 1, 0), '--cqv-axis-y'],
    ['Z', new THREE.Vector3(0, 0, 1), '--cqv-axis-z'],
  ];
  for (const [label, dir, token] of axes) {
    const color = css(token);
    gScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.14));
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(label, color), depthTest: false }));
    sprite.position.copy(dir).multiplyScalar(1.38);
    sprite.scale.set(0.5, 0.5, 0.5);
    gScene.add(sprite);
  }
  return { scene: gScene, camera: gCam };
}
function textTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  g.font = '600 40px ui-sans-serif, -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- selection overlay
// Numbered markers are HTML (crisp text, constant size); only the 2-point measuring line is WebGL.
const pickLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: css('--mcode-warning'), depthTest: false, transparent: true }),
);
pickLine.renderOrder = 999;
pickLine.frustumCulled = false;
pickLine.visible = false;
pickGroup.add(pickLine);
/** @type {HTMLDivElement[]} */
const markerEls = [];
/** @type {THREE.Vector3 | null} */
let hoverPoint = null;

// ---------------------------------------------------------------- render loop (on demand)
let frustumHalf = 100;
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderNow);
}
function renderNow() {
  renderQueued = false;
  const w = el.viewport.clientWidth;
  const h = el.viewport.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.autoClear = true;
  renderer.render(scene, camera);

  const size = 84;
  const dir = camera.position.clone().sub(controls.target).normalize();
  gizmo.camera.position.copy(dir).multiplyScalar(4);
  gizmo.camera.quaternion.copy(camera.quaternion);
  gizmo.camera.updateMatrixWorld();
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setViewport(12, 12, size, size);
  renderer.setScissor(12, 12, size, size);
  renderer.clearDepth();
  renderer.render(gizmo.scene, gizmo.camera);
  renderer.setScissorTest(false);
  renderer.autoClear = true;
  positionOverlays(w, h);
}
function resize() {
  const w = Math.max(1, el.viewport.clientWidth);
  const h = Math.max(1, el.viewport.clientHeight);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.left = -frustumHalf * aspect;
  camera.right = frustumHalf * aspect;
  camera.top = frustumHalf;
  camera.bottom = -frustumHalf;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(el.viewport);

// ---------------------------------------------------------------- camera helpers
const VIEWS = {
  iso: [1, -1, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
};
let sceneBox = new THREE.Box3();
let sceneRadius = 1;

function visibleBox() {
  const box = new THREE.Box3();
  for (const p of parts.values()) {
    if (p.mesh && p.mesh.visible && p.mesh.geometry.boundingBox) box.union(p.mesh.geometry.boundingBox);
  }
  return box;
}
function allBox() {
  const box = new THREE.Box3();
  for (const p of parts.values()) if (p.mesh && p.mesh.geometry.boundingBox) box.union(p.mesh.geometry.boundingBox);
  return box;
}
function fitTo(box, dirArray) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
  const dir = dirArray
    ? new THREE.Vector3(...dirArray).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(1, -1, 1).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, Math.max(radius, sceneRadius) * 4);
  camera.zoom = 1;
  frustumHalf = radius * 1.08;
  resize();
  controls.update();
  updateDepthRange();
  requestRender();
}
// Orthographic: keep the whole scene between near/far without visibly moving anything.
function updateDepthRange() {
  if (sceneBox.isEmpty()) return;
  const center = sceneBox.getCenter(new THREE.Vector3());
  const viewDir = controls.target.clone().sub(camera.position).normalize();
  let depth = center.clone().sub(camera.position).dot(viewDir);
  const want = sceneRadius * 2.5;
  if (depth < want) {
    camera.position.addScaledVector(viewDir, depth - want);
    depth = want;
  }
  camera.near = Math.max(1e-3, depth - sceneRadius * 1.5);
  camera.far = depth + sceneRadius * 1.5;
  camera.updateProjectionMatrix();
}
function setViewPressed(name) {
  for (const b of el.viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === name));
}

// ---------------------------------------------------------------- parts (scene + files)
/**
 * @typedef {{size:number,mtime:number,color?:string,opacity?:number,edges?:boolean,kind?:'stl'|'step'}} PartInfo
 * @typedef {{source:'scene',name:string}|{source:'file',root:string,rel:string}} PartRef
 * @typedef {{key:string,ref:PartRef,label:string,title:string,info:PartInfo,loadedKey:string|null,pendingKey?:string,
 *   status:'loading'|'ready'|'error',error?:string,mesh:THREE.Mesh|null,back:THREE.Mesh|null,
 *   edges:THREE.LineSegments|null,tris:number}} PartEntry
 */
/** @type {Map<string, PartEntry>} */
const parts = new Map();
let hadContent = false;

const sceneKey = (name) => `scene:${name}`;
const fileKey = (root, rel) => `file:${root}:${rel}`;
function parseFileKey(key) {
  const m = /^file:([a-f0-9]{10}):(.+)$/.exec(key);
  return m ? { root: m[1], rel: m[2] } : null;
}
const baseName = (rel) => rel.split('/').pop() || rel;
const dirName = (rel) => rel.split('/').slice(0, -1).join('/');

const palette = () => [1, 2, 3, 4, 5, 6].map((i) => css(`--cqv-part-${i}`));
/** Palette slot per part, assigned on first sight to the least-used colour so open parts stay distinct. */
const colorSlots = new Map();
function slotFor(key) {
  let slot = colorSlots.get(key);
  if (slot === undefined) {
    const pal = palette().map((c) => c.toLowerCase());
    const used = new Array(6).fill(0);
    for (const [k, e] of parts) {
      if (k === key) continue;
      const explicit = e.info.color ? pal.indexOf(e.info.color.toLowerCase()) : -1;
      const s = explicit >= 0 ? explicit : colorSlots.get(k);
      if (s !== undefined && s >= 0) used[s] += 1;
    }
    slot = used.indexOf(Math.min(...used));
    colorSlots.set(key, slot);
  }
  return slot;
}
const partColor = (entry) => entry.info.color || palette()[slotFor(entry.key)];
const keyOf = (info) => `${info.mtime}:${info.size}`;
// STEP brings real CAD edges (always worth drawing); meshes fall back to an angle threshold
const edgesAllowed = (entry) => entry.info.edges ?? (entry.brepEdges ? true : entry.tris <= 150_000);
const CQVM_TYPE = 'application/x-cqview-mesh';

/** @param {string} key @param {PartRef} ref @param {PartInfo} info */
function makeEntry(key, ref, info) {
  const label = ref.source === 'scene' ? ref.name : baseName(ref.rel);
  const root = ref.source === 'file' ? roots.find((r) => r.id === ref.root) : null;
  const title = ref.source === 'scene' ? `脚本推送：${ref.name}` : `${root ? root.display : ''}/${ref.rel}`;
  /** @type {PartEntry} */
  const entry = { key, ref, label, title, info, loadedKey: null, status: 'loading', mesh: null, back: null, edges: null, tris: 0 };
  parts.set(key, entry);
  return entry;
}

function applyMaterial(entry) {
  if (!entry.mesh) return;
  const opacity = entry.info.opacity ?? 1;
  const transparent = opacity < 1;
  const m = /** @type {THREE.MeshStandardMaterial} */ (entry.mesh.material);
  const base = partColor(entry);
  if (entry.vertexColors) {
    // STEP colours live in the vertices; uncoloured bodies take the part colour
    m.vertexColors = true;
    m.color.set('#ffffff');
    fillUncolored(entry, base);
  } else {
    m.vertexColors = false;
    m.color.set(base);
  }
  m.opacity = opacity;
  m.transparent = transparent;
  m.depthWrite = !transparent;
  m.clippingPlanes = clipList();
  m.needsUpdate = true;
  const visible = !prefs.hidden.has(entry.key);
  entry.mesh.visible = visible;
  if (entry.back) entry.back.visible = visible && clipAxis !== 'off' && !transparent;
  syncEdges(entry);
}
function fillUncolored(entry, hex) {
  if (!entry.colorMask || entry.filledWith === hex || !entry.mesh) return;
  const attr = entry.mesh.geometry.getAttribute('color');
  if (!attr) return;
  const c = new THREE.Color(hex); // converted to the linear working space, like the STEP colours
  const mask = entry.colorMask;
  for (let i = 0; i < mask.length; i++) if (mask[i]) attr.setXYZ(i, c.r, c.g, c.b);
  attr.needsUpdate = true;
  entry.filledWith = hex;
}
function syncEdges(entry) {
  const want = prefs.edges && !!entry.mesh && edgesAllowed(entry);
  if (want && !entry.edges && entry.mesh) {
    let geometry;
    if (entry.brepEdges) {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(entry.brepEdges, 3));
    } else {
      geometry = new THREE.EdgesGeometry(entry.mesh.geometry, 20);
    }
    entry.edges = new THREE.LineSegments(geometry, edgeMaterial);
    partsGroup.add(entry.edges);
  }
  if (entry.edges) entry.edges.visible = want && !prefs.hidden.has(entry.key);
}
function disposeEntry(entry) {
  if (entry.edges) {
    partsGroup.remove(entry.edges);
    entry.edges.geometry.dispose();
    entry.edges = null;
  }
  if (entry.back) {
    partsGroup.remove(entry.back);
    entry.back = null;
  }
  if (entry.mesh) {
    partsGroup.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    /** @type {THREE.Material} */ (entry.mesh.material).dispose();
    entry.mesh = null;
  }
}
function removeEntry(key) {
  const entry = parts.get(key);
  if (!entry) return;
  disposeEntry(entry);
  parts.delete(key);
  colorSlots.delete(key);
}

function entryUrl(entry, info) {
  const v = keyOf(info);
  if (entry.ref.source === 'scene') {
    const file = typeof info.file === 'string' ? info.file : `${entry.ref.name}.stl`;
    return apiUrl(`part/${encodeURIComponent(file)}`, { v });
  }
  return apiUrl('file', { root: entry.ref.root, rel: entry.ref.rel, v });
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
  } catch {
    /* not JSON */
  }
  return `请求失败（HTTP ${res.status}）`;
}

/**
 * Fetch a model: STL as-is, or the server's CQVM conversion of a STEP file
 * (assembly bodies with names and colours plus real B-rep edges).
 */
async function fetchModel(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  const type = res.headers.get('content-type') || '';
  const buffer = await res.arrayBuffer();
  if (type.startsWith(CQVM_TYPE)) return parseCqvm(buffer);
  return { geometry: parseStl(buffer), edges: null, bodies: null, vertexColors: false, colorMask: null };
}

function parseStl(buffer) {
  if (buffer.byteLength < 84) throw new Error('不是有效的 STL 文件');
  const geometry = loader.parse(buffer);
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error('文件里没有三角面');
  const normal = geometry.getAttribute('normal');
  let zeroNormals = !normal;
  if (normal) {
    let zeros = 0;
    const n = Math.min(normal.count, 300);
    for (let i = 0; i < n; i++) if (normal.getX(i) === 0 && normal.getY(i) === 0 && normal.getZ(i) === 0) zeros++;
    zeroNormals = zeros > n / 2;
  }
  if (zeroNormals) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** CQVM: "CQVM" | u32 version | u32 jsonLen | JSON header | 4-aligned typed arrays. */
function parseCqvm(buffer) {
  if (buffer.byteLength < 12) throw new Error('模型数据不完整');
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CQVM') throw new Error('模型数据格式不对');
  if (dv.getUint32(4, true) !== 1) throw new Error('模型数据版本不支持，请刷新页面');
  const jsonLen = dv.getUint32(8, true);
  if (12 + jsonLen > buffer.byteLength) throw new Error('模型数据不完整');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, jsonLen)));
  const base = 12 + jsonLen;
  const view = (d, Ctor) => {
    if (!d) return null;
    if (base + d.offset + d.length * 4 > buffer.byteLength) throw new Error('模型数据不完整');
    return new Ctor(buffer, base + d.offset, d.length);
  };
  const positions = view(header.positions, Float32Array);
  const indices = view(header.indices, Uint32Array);
  const colors = view(header.colors, Float32Array);
  const edges = view(header.edges, Float32Array);
  if (!positions || !indices || indices.length === 0) throw new Error('这个 STEP 里没有实体');

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  let colorMask = null;
  if (colors) {
    const col = new Float32Array(colors); // own copy: uncoloured vertices get filled with the part colour
    colorMask = new Uint8Array(col.length / 3);
    let uncolored = 0;
    for (let i = 0; i < colorMask.length; i++) {
      if (col[i * 3] < 0) {
        colorMask[i] = 1;
        uncolored++;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.5;
      }
    }
    if (!uncolored) colorMask = null;
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  geometry.computeVertexNormals(); // vertices are per face, so creases between faces stay sharp
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bodies = Array.isArray(header.bodies)
    ? header.bodies.filter((b) => b && Array.isArray(b.tri) && b.tri.length === 2)
    : [];
  return { geometry, edges: edges && edges.length ? edges : null, bodies, vertexColors: !!colors, colorMask };
}

/** Body (part inside a STEP assembly) that owns a triangle, by binary search over tri ranges. */
function bodyAt(entry, faceIndex) {
  const bodies = entry?.bodies;
  if (!bodies || !bodies.length || typeof faceIndex !== 'number') return null;
  let lo = 0;
  let hi = bodies.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, count] = bodies[mid].tri;
    if (faceIndex < start) hi = mid - 1;
    else if (faceIndex >= start + count) lo = mid + 1;
    else return bodies[mid];
  }
  return null;
}

/** Load (or reload) an entry unless the same version is already loaded or in flight. */
function ensureLoaded(entry, info) {
  const key = keyOf(info);
  entry.info = { ...entry.info, ...info };
  if (entry.loadedKey === key) {
    applyMaterial(entry);
    return null;
  }
  if (entry.pendingKey === key && entry.status === 'loading') return null;
  return loadEntry(entry, info);
}

async function loadEntry(entry, info) {
  const key = keyOf(info);
  entry.status = 'loading';
  entry.pendingKey = key;
  renderParts();
  try {
    const model = await fetchModel(entryUrl(entry, info));
    const geometry = model.geometry;
    if (entry.pendingKey !== key || parts.get(entry.key) !== entry) {
      geometry.dispose(); // superseded by a newer version, or closed meanwhile
      return;
    }
    disposeEntry(entry);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    entry.mesh = new THREE.Mesh(geometry, material);
    entry.mesh.userData.key = entry.key;
    entry.back = new THREE.Mesh(geometry, sectionMaterial);
    entry.back.raycast = () => {};
    partsGroup.add(entry.mesh, entry.back);
    const index = geometry.getIndex();
    entry.tris = index ? index.count / 3 : geometry.getAttribute('position').count / 3;
    entry.vertexColors = model.vertexColors;
    entry.colorMask = model.colorMask;
    entry.filledWith = null;
    entry.brepEdges = model.edges;
    entry.bodies = model.bodies;
    entry.loadedKey = key;
    entry.status = 'ready';
    entry.error = undefined;
    applyMaterial(entry);
  } catch (error) {
    if (entry.pendingKey !== key) return;
    entry.status = 'error';
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    renderParts();
  }
}

const closeIcon =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function orderedEntries() {
  const scene = [...parts.values()].filter((e) => e.ref.source === 'scene').sort((a, b) => a.label.localeCompare(b.label));
  const files = prefs.opened.map((k) => parts.get(k)).filter(Boolean);
  return [...scene, .../** @type {PartEntry[]} */ (files)];
}

function renderParts() {
  const entries = orderedEntries();
  el.parts.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement('li');
    li.dataset.loading = String(entry.status === 'loading');
    li.title = entry.title;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !prefs.hidden.has(entry.key);
    cb.setAttribute('aria-label', `显示 ${entry.label}`);
    cb.addEventListener('change', () => {
      if (cb.checked) prefs.hidden.delete(entry.key);
      else prefs.hidden.add(entry.key);
      savePrefs();
      applyMaterial(entry);
      afterSceneChange(false);
    });

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = partColor(entry);
    if ((entry.info.opacity ?? 1) < 1) sw.style.opacity = String(Math.max(entry.info.opacity ?? 1, 0.35));
    sw.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'part-name';
    btn.textContent = entry.label;
    btn.setAttribute('aria-label', `适配视图到 ${entry.label}`);
    btn.addEventListener('click', () => {
      if (entry.mesh?.geometry.boundingBox) fitTo(entry.mesh.geometry.boundingBox);
    });

    const meta = document.createElement('span');
    if (entry.status === 'error') {
      meta.className = 'part-error';
      meta.textContent = entry.error || '打开失败';
      meta.title = entry.error || '打开失败';
    } else if (entry.status === 'loading' && !entry.mesh) {
      meta.className = 'part-meta';
      meta.textContent = '正在打开…';
    } else if (entry.bodies && entry.bodies.length > 1) {
      meta.className = 'part-meta';
      meta.textContent = `${entry.bodies.length} 个零件`;
      meta.title = [...new Set(entry.bodies.map((b) => b.name).filter(Boolean))].join('、');
    }
    li.append(cb, sw, btn, meta);

    if (entry.ref.source === 'file') {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'icon-btn';
      close.innerHTML = closeIcon;
      close.setAttribute('aria-label', `关闭 ${entry.label}`);
      close.title = '关闭';
      close.addEventListener('click', () => closeFile(entry.key));
      li.append(close);
    }
    el.parts.append(li);
  }
  el.partsEmpty.hidden = entries.length > 0;
  el.partsBadge.hidden = entries.length === 0;
  el.partsBadge.textContent = String(entries.length);
}

// ---------------------------------------------------------------- pushed scene sync
let refreshing = false;
let refreshAgain = false;
async function refreshScene() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      await syncScene();
    } while (refreshAgain);
  } catch (error) {
    showWarning(`脚本推送目录读取失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refreshing = false;
  }
}

async function syncScene() {
  const res = await fetch(apiUrl('scene'), { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  if (!data || !Array.isArray(data.parts)) throw new Error('场景数据格式不正确');
  if (typeof data.selectionFile === 'string') selectionFile = data.selectionFile;
  showWarning(Array.isArray(data.warnings) ? data.warnings.join('；') : '');

  const incoming = data.parts.filter((p) => p && typeof p.name === 'string');
  const keep = new Set(incoming.map((p) => sceneKey(p.name)));
  for (const entry of [...parts.values()]) {
    if (entry.ref.source === 'scene' && !keep.has(entry.key)) removeEntry(entry.key);
  }
  const loads = [];
  for (const info of incoming) {
    const key = sceneKey(info.name);
    const entry = parts.get(key) ?? makeEntry(key, { source: 'scene', name: info.name }, info);
    // scene.json may drop a colour: rebuild meta from the fresh record rather than merging
    entry.info = { size: entry.info.size, mtime: entry.info.mtime };
    const job = ensureLoaded(entry, info);
    if (job) loads.push(job);
  }
  renderParts();
  await Promise.all(loads);
  afterSceneChange(true);
}

// ---------------------------------------------------------------- folders & files
/** @type {{id:string,label:string,display:string}[]} */
let roots = [];
/** @type {string|null} */
let currentRoot = null;
/** @type {Map<string, {files:{rel:string,size:number,mtime:number,kind:'stl'|'step'}[], truncated:boolean, error:string, loading:boolean}>} */
const fileLists = new Map();

async function loadRoots() {
  const res = await fetch(apiUrl('roots'), { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  roots = Array.isArray(data.roots) ? data.roots.filter((r) => r && ROOT_ID_RE.test(r.id)) : [];
  renderRootSelect();
}

/** @param {string} path @returns {Promise<string>} root id */
async function registerRoot(path) {
  const res = await fetch(apiUrl('roots'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = await res.json();
  await loadRoots();
  return data.root.id;
}

function selectRoot(id) {
  currentRoot = id;
  prefs.root = id;
  savePrefs();
  renderRootSelect();
  renderFileList();
  void syncFiles(id);
}

function renderRootSelect() {
  el.rootSelect.replaceChildren();
  if (!roots.length) {
    const opt = document.createElement('option');
    opt.textContent = '还没有文件夹';
    opt.value = '';
    el.rootSelect.append(opt);
    el.rootSelect.disabled = true;
  } else {
    el.rootSelect.disabled = false;
    for (const r of roots) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      opt.title = r.display;
      el.rootSelect.append(opt);
    }
    if (currentRoot) el.rootSelect.value = currentRoot;
  }
  const cur = roots.find((r) => r.id === currentRoot);
  el.rootPath.textContent = cur ? cur.display : '';
  el.rootPath.title = cur ? cur.display : '';
  el.rootName.textContent = cur ? cur.label : '选择文件夹';
  el.rootName.title = cur ? cur.display : '';
}

async function syncFiles(rootId) {
  const state = fileLists.get(rootId) ?? { files: [], truncated: false, error: '', loading: true };
  state.loading = true;
  fileLists.set(rootId, state);
  if (rootId === currentRoot) renderFileList();
  try {
    const res = await fetch(apiUrl('files', { root: rootId }), { cache: 'no-store' });
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    if (!data || !Array.isArray(data.files)) throw new Error('文件列表格式不正确');
    state.files = data.files.filter((f) => f && typeof f.rel === 'string');
    state.truncated = !!data.truncated;
    state.error = '';
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
  state.loading = false;
  if (rootId === currentRoot) renderFileList();
  await reconcileOpened(rootId, state);
}

async function reconcileOpened(rootId, state) {
  if (state.error) return; // keep what is on screen; the list shows the error
  const byRel = new Map(state.files.map((f) => [f.rel, f]));
  const loads = [];
  for (const key of prefs.opened) {
    const fk = parseFileKey(key);
    if (!fk || fk.root !== rootId) continue;
    const file = byRel.get(fk.rel);
    let entry = parts.get(key);
    if (!file) {
      if (!entry) entry = makeEntry(key, { source: 'file', root: fk.root, rel: fk.rel }, { size: 0, mtime: 0 });
      entry.status = 'error';
      entry.error = '文件已不存在';
      continue;
    }
    if (!entry) entry = makeEntry(key, { source: 'file', root: fk.root, rel: fk.rel }, file);
    const job = ensureLoaded(entry, file);
    if (job) loads.push(job);
  }
  renderParts();
  if (loads.length) {
    await Promise.all(loads);
    afterSceneChange(true);
  }
}

async function openFile(rootId, file) {
  const key = fileKey(rootId, file.rel);
  if (prefs.opened.includes(key)) return;
  prefs.opened.push(key);
  prefs.hidden.delete(key);
  savePrefs();
  const entry = makeEntry(key, { source: 'file', root: rootId, rel: file.rel }, file);
  renderFileList();
  const refit = hadContent;
  await loadEntry(entry, file);
  afterSceneChange(true);
  if (refit && entry.mesh) fitTo(visibleBox());
}

function closeFile(key) {
  prefs.opened = prefs.opened.filter((k) => k !== key);
  prefs.hidden.delete(key);
  savePrefs();
  removeEntry(key);
  const kept = picks.filter((p) => !(p.ref && p.ref.source === 'file' && fileKey(p.ref.root, p.ref.rel) === key));
  if (kept.length !== picks.length) setPicks(kept);
  renderParts();
  renderFileList();
  afterSceneChange(false);
}

function renderFileList() {
  el.files.replaceChildren();
  el.filesStatus.classList.remove('error');
  if (!currentRoot) {
    el.filesStatus.textContent = '点右上角的 + 添加一个项目文件夹。';
    return;
  }
  const state = fileLists.get(currentRoot);
  if (!state || (state.loading && state.files.length === 0 && !state.error)) {
    el.filesStatus.textContent = '正在扫描文件夹…';
    return;
  }
  if (state.error) {
    el.filesStatus.classList.add('error');
    el.filesStatus.textContent = state.error;
    return;
  }
  const filter = el.fileFilter.value.trim().toLowerCase();
  const shown = filter ? state.files.filter((f) => f.rel.toLowerCase().includes(filter)) : state.files;
  for (const f of shown) {
    const key = fileKey(currentRoot, f.rel);
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'file-row';
    label.title = f.rel;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = prefs.opened.includes(key);
    const rootId = currentRoot;
    cb.addEventListener('change', () => {
      if (cb.checked) void openFile(rootId, f);
      else closeFile(key);
    });

    const main = document.createElement('span');
    main.className = 'file-main';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = baseName(f.rel);
    if (f.kind === 'step') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'STEP';
      name.append(tag);
    }
    const dir = document.createElement('span');
    dir.className = 'file-dir';
    dir.textContent = dirName(f.rel) || '（根目录）';
    main.append(name, dir);

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = fmtSize(f.size);

    label.append(cb, main, size);
    li.append(label);
    el.files.append(li);
  }
  if (!state.files.length) {
    el.filesStatus.textContent = '这个文件夹里还没有 STL 或 STEP 文件';
  } else {
    const bits = [`共 ${state.files.length} 个模型`];
    if (filter) bits.push(`找到 ${shown.length} 个`);
    if (state.truncated) bits.push('只显示前 1000 个');
    el.filesStatus.textContent = bits.join('，');
  }
}

// ---------------------------------------------------------------- after any change
function afterSceneChange(fromLoad) {
  sceneBox = allBox();
  sceneRadius = sceneBox.isEmpty() ? 1 : Math.max(sceneBox.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
  const vis = visibleBox();
  rebuildGrid(vis.isEmpty() ? sceneBox : vis);
  updateClipRange();
  updateInfo(vis);

  if (parts.size === 0) {
    showOverlay('empty', '打开一个模型开始', '从项目文件夹中选择 STL 或 STEP 文件。', {
      action: '选择模型',
      onAction: () => openPanel('files'),
      hint: '也可以在 CadQuery 脚本里调用 show()，模型会直接显示在这里。',
    });
    hadContent = false;
  } else {
    const anyReady = [...parts.values()].some((p) => p.mesh);
    if (anyReady) hideOverlay();
    else if ([...parts.values()].every((p) => p.status === 'error')) {
      showOverlay('error', '模型没有打开', '可以在「已打开」里查看原因，或换一个文件试试。', {
        action: '查看已打开',
        onAction: () => openPanel('parts'),
      });
    } else {
      showOverlay('loading', '正在打开模型', '大文件需要几秒钟…');
    }
    if (fromLoad && anyReady && !hadContent) {
      hadContent = true;
      fitTo(vis.isEmpty() ? sceneBox : vis, VIEWS.iso);
      setViewPressed('iso');
    }
  }
  updateDepthRange();
  requestRender();
}

function showWarning(text) {
  el.warning.hidden = !text;
  el.warning.textContent = text;
}

// ---------------------------------------------------------------- grid
let grid = null;
let originAxes = null;
let gridStep = 0;
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function rebuildGrid(box) {
  for (const o of [grid, originAxes]) {
    if (!o) continue;
    helpersGroup.remove(o);
    o.geometry.dispose();
    /** @type {THREE.Material} */ (o.material).dispose();
  }
  grid = null;
  originAxes = null;
  gridStep = 0;
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z * 0.5, 1e-2) * 1.6;
  gridStep = niceStep(span / 16);
  const div = Math.max(2, Math.ceil(span / gridStep / 2) * 2);
  grid = new THREE.GridHelper(gridStep * div, div, css('--cqv-grid-major'), css('--cqv-grid-minor'));
  grid.rotation.x = Math.PI / 2;
  grid.position.set(
    Math.round(center.x / gridStep) * gridStep,
    Math.round(center.y / gridStep) * gridStep,
    box.min.z - span * 0.002,
  );
  originAxes = new THREE.AxesHelper(gridStep * 2);
  originAxes.renderOrder = 1;
  grid.visible = originAxes.visible = prefs.grid;
  helpersGroup.add(grid, originAxes);
}

// ---------------------------------------------------------------- clipping
function axisIndex(axis) {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}
function updateClipRange() {
  const on = clipAxis !== 'off';
  el.clipPos.disabled = !on || sceneBox.isEmpty();
  if (!on || sceneBox.isEmpty()) {
    el.clipVal.textContent = '';
    return;
  }
  const i = axisIndex(clipAxis);
  const lo = sceneBox.min.getComponent(i);
  const hi = sceneBox.max.getComponent(i);
  const v = lo + (hi - lo) * (Number(el.clipPos.value) / 1000);
  const n = new THREE.Vector3();
  n.setComponent(i, -1);
  clipPlane.set(n, v);
  el.clipVal.textContent = `${clipAxis.toUpperCase()} ≤ ${fmt(v, 1)}`;
}
function applyClip() {
  updateClipRange();
  for (const entry of parts.values()) applyMaterial(entry);
  edgeMaterial.clippingPlanes = clipList();
  edgeMaterial.needsUpdate = true;
  sectionMaterial.clippingPlanes = clipList();
  sectionMaterial.needsUpdate = true;
  requestRender();
}

// ---------------------------------------------------------------- annotations (positions on parts)
/**
 * @typedef {{x:number,y:number,z:number,part:string|null,body?:string,ref?:PartRef,
 *   normal?:{x:number,y:number,z:number},note?:string}} Pick
 */
const MAX_PICKS = 50;
/** Confirmed annotations (persisted, sent to the AI). @type {Pick[]} */
let picks = [];
/** Points chosen in pick mode, waiting for 确认. @type {Pick[]} */
let pending = [];
let pickMode = false;
/** @type {Pick[][]} */
const undoStack = [];
let activePick = -1;
let instruction = '';
let annotOpen = true;
let selectionFile = '~/.cqview/selection.json';
let lastSelectionStamp = '';
const clientId = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, '').slice(0, 24);
const raycaster = new THREE.Raycaster();
let downAt = null;

const clonePicks = (list) => list.map((p) => ({ ...p, ...(p.normal ? { normal: { ...p.normal } } : {}) }));
const pointAt = (i) => (i < picks.length ? picks[i] : pending[i - picks.length]);

/** First visible surface hit under the cursor (respecting the section plane), or null. */
function hitAt(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const targets = [...parts.values()].filter((p) => p.mesh && p.mesh.visible).map((p) => p.mesh);
  if (!targets.length) return null;
  return (
    raycaster
      .intersectObjects(targets, false)
      .find((h) => clipAxis === 'off' || clipPlane.distanceToPoint(h.point) >= -1e-6) ?? null
  );
}

/** @returns {Pick} */
function pickFromHit(hit) {
  const entry = parts.get(hit.object.userData.key);
  const body = entry ? bodyAt(entry, hit.faceIndex) : null;
  /** @type {Pick} */
  const p = {
    x: round(hit.point.x),
    y: round(hit.point.y),
    z: round(hit.point.z),
    part: entry ? entry.label : null,
    ...(entry ? { ref: entry.ref } : {}),
    // only worth naming when the file is an assembly of several parts
    ...(body && entry.bodies.length > 1 && (body.path || body.name) ? { body: body.path || body.name } : {}),
  };
  if (hit.face) p.normal = { x: round(hit.face.normal.x, 4), y: round(hit.face.normal.y, 4), z: round(hit.face.normal.z, 4) };
  return p;
}
const bodyShort = (body) => (body ? body.split('/').filter(Boolean).pop() || body : '');

el.canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) downAt = { x: e.clientX, y: e.clientY };
  hideHover();
});
el.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved <= 4 && pickMode) addPending(e);
});

// ---- pick mode: choose several points, then confirm
function addPending(e) {
  const hit = hitAt(e.clientX, e.clientY);
  if (!hit) {
    showToast('请点在模型表面上', 'info', 1400);
    return;
  }
  if (picks.length + pending.length >= MAX_PICKS) {
    showToast(`最多标注 ${MAX_PICKS} 个位置`, 'warning');
    return;
  }
  pending = [...pending, pickFromHit(hit)];
  renderPending();
}

function setPickMode(on) {
  if (pickMode === on) return;
  pickMode = on;
  pending = [];
  if (!on) hideHover();
  document.body.classList.toggle('picking', on);
  el.pickToggle.setAttribute('aria-pressed', String(on));
  el.confirmBar.hidden = !on;
  renderPending();
}

function confirmPending() {
  if (!pending.length) return;
  const added = pending;
  const firstNew = picks.length;
  setPickMode(false);
  setPicks([...picks, ...added]);
  annotOpen = true;
  updateAnnotVisibility();
  requestAnimationFrame(() => {
    const notes = el.pickList.querySelectorAll('.note');
    /** @type {HTMLInputElement | undefined} */ (notes[firstNew])?.focus();
  });
}

function removeLastPending() {
  if (!pending.length) return false;
  pending = pending.slice(0, -1);
  renderPending();
  return true;
}

function renderPending() {
  const n = pending.length;
  if (n) {
    el.confirmText.replaceChildren('已选择 ', Object.assign(document.createElement('strong'), { textContent: String(n) }), ' 个位置');
  } else {
    el.confirmText.textContent = '在模型上点击要标注的位置，可以连续选多个';
  }
  el.pendingUndo.disabled = n === 0;
  el.pendingConfirm.disabled = n === 0;
  el.pendingConfirm.textContent = n ? `确认 ${n} 个位置` : '确认';
  syncMarkers();
}

// ---- confirmed annotations
/** Every structural change goes through here so it can be undone and is persisted. */
function setPicks(next, record = true) {
  if (record) {
    undoStack.push(clonePicks(picks));
    if (undoStack.length > 30) undoStack.shift();
  }
  picks = next;
  activePick = -1;
  renderPicks();
  void postSelection();
}
function undoPicks() {
  const prev = undoStack.pop();
  if (!prev) return false;
  picks = prev;
  activePick = -1;
  renderPicks();
  void postSelection();
  return true;
}

// hover preview (pick mode only): shows where a click would land
let hoverEvent = null;
let hoverTimer = null;
el.canvas.addEventListener('pointermove', (e) => {
  if (!pickMode || e.buttons !== 0) {
    hideHover();
    return;
  }
  hoverEvent = e;
  if (!hoverTimer) {
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (hoverEvent && pickMode) updateHover(hoverEvent);
    }, 40);
  }
});
el.canvas.addEventListener('pointerleave', () => {
  hoverEvent = null;
  hideHover();
});
function updateHover(e) {
  const hit = hitAt(e.clientX, e.clientY);
  hoverPoint = hit ? hit.point.clone() : null;
  requestRender();
}
function hideHover() {
  if (!hoverPoint && el.hoverDot.hidden) return;
  hoverPoint = null;
  el.hoverDot.hidden = true;
}

const projected = new THREE.Vector3();
function screenOf(x, y, z, w, h) {
  projected.set(x, y, z).project(camera);
  if (projected.z < -1 || projected.z > 1) return null;
  const sx = ((projected.x + 1) / 2) * w;
  const sy = ((1 - projected.y) / 2) * h;
  if (sx < -24 || sy < -24 || sx > w + 24 || sy > h + 24) return null;
  return [sx, sy];
}
/** Called after every WebGL frame so HTML markers track the camera. */
function positionOverlays(w, h) {
  markerEls.forEach((m, i) => {
    const p = pointAt(i);
    const s = p ? screenOf(p.x, p.y, p.z, w, h) : null;
    m.hidden = !s;
    if (s) m.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`;
    m.dataset.active = String(i === activePick);
  });
  const hs = hoverPoint ? screenOf(hoverPoint.x, hoverPoint.y, hoverPoint.z, w, h) : null;
  el.hoverDot.hidden = !hs;
  if (hs) el.hoverDot.style.transform = `translate(${hs[0].toFixed(1)}px, ${hs[1].toFixed(1)}px)`;
}

function syncMarkers() {
  const total = picks.length + pending.length;
  while (markerEls.length < total) {
    const m = document.createElement('div');
    m.className = 'marker';
    m.append(document.createElement('span'));
    el.markers.append(m);
    markerEls.push(m);
  }
  while (markerEls.length > total) markerEls.pop()?.remove();
  markerEls.forEach((m, i) => {
    m.classList.toggle('pending', i >= picks.length);
    /** @type {HTMLElement} */ (m.firstChild).textContent = String(i + 1);
  });
  pickLine.visible = picks.length === 2 && pending.length === 0;
  if (pickLine.visible) {
    const [a, b] = picks;
    pickLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3));
  }
  requestRender();
}

function renderPicks() {
  syncMarkers();
  el.pickList.replaceChildren(...picks.map((p, i) => pickItem(p, i)));
  el.pickEmpty.hidden = picks.length > 0;
  el.annotCount.textContent = picks.length ? String(picks.length) : '';
  el.annotFabCount.textContent = String(picks.length);
  el.clearPick.disabled = picks.length === 0;
  updateAnnotVisibility();
  updateCompose();
}

function updateAnnotVisibility() {
  const has = picks.length > 0;
  el.annot.hidden = !(has && annotOpen);
  el.annotFab.hidden = !(has && !annotOpen);
}

function pickItem(p, i) {
  const n = i + 1;
  const li = document.createElement('li');
  li.className = 'pick-item';
  li.dataset.active = String(i === activePick);

  const head = document.createElement('div');
  head.className = 'pick-head';

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'pick-badge';
  badge.textContent = String(n);
  badge.title = '以这个位置为旋转中心';
  badge.setAttribute('aria-label', `定位到第 ${n} 个位置`);
  badge.addEventListener('click', () => focusPick(i));

  const main = document.createElement('div');
  main.className = 'pick-main';
  const part = document.createElement('div');
  part.className = 'pick-part';
  part.textContent = (p.part ?? '未知零件') + (p.body ? ` › ${bodyShort(p.body)}` : '');
  part.title = [p.part, p.body].filter(Boolean).join(' › ');
  const xyz = document.createElement('div');
  xyz.className = 'mono';
  xyz.textContent = `${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}`;
  const sub = document.createElement('div');
  sub.className = 'pick-sub mono';
  if (i > 0) {
    const a = picks[i - 1];
    sub.textContent = `距 #${i} ${fmt(Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z))} mm`;
  }
  main.append(part, xyz, sub);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.innerHTML = closeIcon;
  del.title = '删除';
  del.setAttribute('aria-label', `删除第 ${n} 个位置`);
  del.addEventListener('click', () => setPicks(picks.filter((_, j) => j !== i)));

  head.append(badge, main, del);

  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'input note';
  note.maxLength = 500;
  note.value = p.note ?? '';
  note.placeholder = '这里要做什么，如：加 R2 圆角';
  note.setAttribute('aria-label', `第 ${n} 个位置的备注`);
  note.addEventListener('input', () => {
    p.note = note.value;
    scheduleSave();
    updateCompose();
  });
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') note.blur();
  });

  li.append(head, note);
  li.addEventListener('mouseenter', () => setActivePick(i));
  li.addEventListener('mouseleave', () => setActivePick(-1));
  li.addEventListener('focusin', () => setActivePick(i));
  li.addEventListener('focusout', () => setActivePick(-1));
  return li;
}

function setActivePick(i) {
  if (activePick === i) return;
  activePick = i;
  el.pickList.querySelectorAll('.pick-item').forEach((li, j) => {
    /** @type {HTMLElement} */ (li).dataset.active = String(j === i);
  });
  requestRender();
}

function focusPick(i) {
  const p = picks[i];
  if (!p) return;
  const target = new THREE.Vector3(p.x, p.y, p.z);
  camera.position.add(target.clone().sub(controls.target));
  controls.target.copy(target);
  controls.update();
  updateDepthRange();
  requestRender();
}

// ---- compose & send
function displayFileOf(p) {
  if (!p.ref) return null;
  if (p.ref.source === 'scene') {
    const entry = parts.get(sceneKey(p.ref.name));
    const file = typeof entry?.info?.file === 'string' ? entry.info.file : `${p.ref.name}.stl`;
    return `~/.cqview/scene/${file}`;
  }
  const root = roots.find((r) => r.id === p.ref.root);
  return root ? `${root.display}/${p.ref.rel}` : p.ref.rel;
}

/** The exact text that goes to the conversation. */
function buildMessage() {
  const ask = instruction.trim();
  const lines = [ask || '请看我在 CadQuery Viewer 里标注的位置。'];
  if (picks.length) {
    lines.push('', `标注位置（${picks.length} 处，单位 mm，Z 轴向上）：`);
    picks.forEach((p, i) => {
      const normal = p.normal ? `，法向 (${fmt(p.normal.x)}, ${fmt(p.normal.y)}, ${fmt(p.normal.z)})` : '';
      const where = (p.part ?? '未知零件') + (p.body ? ` › ${p.body}` : '');
      lines.push(`#${i + 1} ${where}：(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})${normal}`);
      if (p.note && p.note.trim()) lines.push(`    备注：${p.note.trim()}`);
      const file = displayFileOf(p);
      if (file) lines.push(`    文件：${file}`);
    });
    if (picks.length >= 2) {
      const segs = picks.slice(1).map((b, i) => {
        const a = picks[i];
        return `#${i + 1}→#${i + 2} ${fmt(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z))} mm`;
      });
      lines.push('', `相邻距离：${segs.join('，')}`);
    }
  }
  lines.push('', `（来自 CadQuery Viewer；完整数据：${selectionFile}）`);
  return lines.join('\n');
}

let sending = false;
let bridgeReady = false;
function updateCompose() {
  el.composePreview.textContent = buildMessage();
  const fallback = bridgeReady && !hostBridge.canDeliver();
  el.sendLabel.textContent = sending ? '正在发送…' : fallback ? '复制内容' : '发送到对话';
  el.sendBtn.disabled = sending || (picks.length === 0 && !instruction.trim());
}
function setSendStatus(text, kind = 'info') {
  el.sendStatus.textContent = text;
  el.sendStatus.dataset.kind = kind;
}

async function sendToConversation() {
  if (sending) return;
  const text = buildMessage();
  sending = true;
  updateCompose();
  setSendStatus('');
  try {
    flushSave();
    await postSelection();
    if (!bridgeReady) await detectHostBridge();
    if (!hostBridge.canDeliver()) {
      const ok = await copyText(text);
      setSendStatus(
        ok ? '这个窗口没有连接到对话，内容已复制，可以直接粘贴发送' : '这个窗口没有连接到对话，请在 MiniMax Code 里打开 Viewer',
        ok ? 'info' : 'error',
      );
      return;
    }
    const result = await hostBridge.deliver(text);
    setSendStatus(result.mode === 'sent' ? '已发送到对话' : '已放进对话输入框，按回车即可发送', 'ok');
  } catch (error) {
    setSendStatus(`没有发送成功：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    sending = false;
    updateCompose();
  }
}

// ---- persistence: one write at a time, coalescing bursts (typing notes, rapid clicks)
let posting = false;
let postDirty = false;
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void postSelection();
  }, 400);
}
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
async function postSelection() {
  if (posting) {
    postDirty = true;
    return;
  }
  posting = true;
  try {
    do {
      postDirty = false;
      await writeSelectionOnce();
    } while (postDirty);
  } finally {
    posting = false;
  }
}
async function writeSelectionOnce() {
  try {
    const points = picks.map(({ x, y, z, part, body, ref, normal, note }) => ({ x, y, z, part, body, ref, normal, note }));
    const res = await fetch(apiUrl('selection'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: clientId, instruction, points }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const doc = await res.json();
    lastSelectionStamp = typeof doc.updated === 'string' ? doc.updated : '';
  } catch (error) {
    showToast(`标注没有保存：${error instanceof Error ? error.message : String(error)}`, 'error', 4000);
  }
}
async function loadSelection() {
  try {
    const res = await fetch(apiUrl('selection'), { cache: 'no-store' });
    if (!res.ok) return;
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.points)) return;
    if (doc.updated && doc.updated === lastSelectionStamp) return;
    lastSelectionStamp = doc.updated || '';
    picks = doc.points
      .filter((p) => p && [p.x, p.y, p.z].every((v) => typeof v === 'number' && Number.isFinite(v)))
      .slice(0, MAX_PICKS)
      .map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        part: p.part ?? null,
        ...(typeof p.body === 'string' ? { body: p.body } : {}),
        ...(p.ref ? { ref: p.ref } : {}),
        ...(p.normal ? { normal: p.normal } : {}),
        ...(typeof p.note === 'string' ? { note: p.note } : {}),
      }));
    if (document.activeElement !== el.composeText) {
      instruction = typeof doc.instruction === 'string' ? doc.instruction : '';
      el.composeText.value = instruction;
    }
    activePick = -1;
    renderPicks();
  } catch {
    /* annotations are optional */
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- info & formatting
function updateInfo(box) {
  if (box.isEmpty()) {
    el.infoSize.textContent = el.infoCenter.textContent = el.infoTris.textContent = '—';
  } else {
    const s = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    el.infoSize.textContent = `${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)} mm`;
    el.infoCenter.textContent = `${fmt(c.x, 1)}, ${fmt(c.y, 1)}, ${fmt(c.z, 1)}`;
    let tris = 0;
    for (const p of parts.values()) if (p.mesh && p.mesh.visible) tris += p.tris;
    el.infoTris.textContent = fmtCount(tris);
  }
  el.infoGrid.textContent = gridStep ? `${trimNum(gridStep)} mm / 格` : '—';
  let latest = 0;
  for (const p of parts.values()) if (p.mesh) latest = Math.max(latest, p.info.mtime || 0);
  el.infoUpdated.textContent = latest ? new Date(latest).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
}
function round(v, d = 3) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function fmt(v, d = 2) {
  return (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
}
function trimNum(v) {
  return Number(v.toPrecision(6)).toString();
}
function fmtCount(n) {
  if (!n) return '0';
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万`;
  return n.toLocaleString('zh-CN');
}
function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------- UI wiring
// left panels (one at a time)
let openPanelName = /** @type {string|null} */ (null);
function openPanel(name) {
  openPanelName = name;
  for (const [key, panel] of Object.entries(el.panels)) panel.hidden = key !== name;
  for (const b of el.railButtons) b.setAttribute('aria-pressed', String(b.dataset.panel === name));
}
for (const b of el.railButtons) {
  b.addEventListener('click', () => openPanel(openPanelName === b.dataset.panel ? null : b.dataset.panel || null));
}
for (const b of document.querySelectorAll('[data-close-panel]')) b.addEventListener('click', () => openPanel(null));
el.rootName.addEventListener('click', () => openPanel('files'));

// toolbar
el.pickToggle.addEventListener('click', () => setPickMode(!pickMode));
el.pendingUndo.addEventListener('click', () => removeLastPending());
el.pendingCancel.addEventListener('click', () => setPickMode(false));
el.pendingConfirm.addEventListener('click', () => confirmPending());

el.fit.addEventListener('click', () => fitTo(visibleBox()));
for (const b of el.viewButtons) {
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => {
    const name = /** @type {keyof typeof VIEWS} */ (b.dataset.view);
    const box = visibleBox();
    fitTo(box.isEmpty() ? sceneBox : box, VIEWS[name]);
    setViewPressed(name);
  });
}
el.optEdges.setAttribute('aria-pressed', String(prefs.edges));
el.optGrid.setAttribute('aria-pressed', String(prefs.grid));
el.optEdges.addEventListener('click', () => {
  prefs.edges = !prefs.edges;
  el.optEdges.setAttribute('aria-pressed', String(prefs.edges));
  savePrefs();
  for (const entry of parts.values()) syncEdges(entry);
  requestRender();
});
el.optGrid.addEventListener('click', () => {
  prefs.grid = !prefs.grid;
  el.optGrid.setAttribute('aria-pressed', String(prefs.grid));
  savePrefs();
  if (grid) grid.visible = prefs.grid;
  if (originAxes) originAxes.visible = prefs.grid;
  requestRender();
});

function setClipPopover(open) {
  el.clipPop.hidden = !open;
  el.clipToggle.setAttribute('aria-expanded', String(open));
}
el.clipToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  setClipPopover(el.clipPop.hidden);
});
el.clipPop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  if (!el.clipPop.hidden) setClipPopover(false);
});
for (const b of el.clipButtons) {
  b.addEventListener('click', () => {
    clipAxis = b.dataset.clip || 'off';
    for (const o of el.clipButtons) o.setAttribute('aria-pressed', String(o === b));
    el.clipToggle.classList.toggle('active', clipAxis !== 'off');
    applyClip();
  });
}
el.clipPos.addEventListener('input', () => {
  updateClipRange();
  requestRender();
});

// annotations panel
el.annotCollapse.addEventListener('click', () => {
  annotOpen = false;
  updateAnnotVisibility();
});
el.annotFab.addEventListener('click', () => {
  annotOpen = true;
  updateAnnotVisibility();
});
el.composeText.addEventListener('input', () => {
  instruction = el.composeText.value;
  scheduleSave();
  updateCompose();
});
el.composeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void sendToConversation();
  }
});
el.sendBtn.addEventListener('click', () => void sendToConversation());
el.clearPick.addEventListener('click', () => {
  if (picks.length) {
    setPicks([]);
    setSendStatus('标注已清空，⌘Z 可以恢复');
  }
});

// files panel
el.rootSelect.addEventListener('change', () => {
  if (el.rootSelect.value) selectRoot(el.rootSelect.value);
});
el.fileFilter.addEventListener('input', () => renderFileList());

function setAddFormOpen(open) {
  el.rootAddForm.hidden = !open;
  el.rootAddToggle.setAttribute('aria-expanded', String(open));
  el.rootAddError.hidden = true;
  if (open) el.rootAddInput.focus();
}
el.rootAddToggle.addEventListener('click', () => setAddFormOpen(el.rootAddForm.hidden));
el.rootAddCancel.addEventListener('click', () => setAddFormOpen(false));
el.rootAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el.rootAddInput.value.trim();
  if (!value) {
    el.rootAddError.hidden = false;
    el.rootAddError.textContent = '请输入文件夹路径';
    return;
  }
  try {
    const id = await registerRoot(value);
    el.rootAddInput.value = '';
    setAddFormOpen(false);
    selectRoot(id);
  } catch (error) {
    el.rootAddError.hidden = false;
    el.rootAddError.textContent = error instanceof Error ? error.message : String(error);
  }
});

// keyboard
window.addEventListener('keydown', (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (e.key === 'Escape') {
    if (typing) {
      t.blur();
      return;
    }
    if (!el.clipPop.hidden) setClipPopover(false);
    else if (pickMode) setPickMode(false);
    else if (openPanelName) openPanel(null);
    return;
  }
  if (typing) return;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (pickMode && removeLastPending()) return;
    if (undoPicks()) showToast('已撤销', 'info', 1200);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'p' || e.key === 'P') setPickMode(!pickMode);
  else if (e.key === 'f' || e.key === 'F') fitTo(visibleBox());
  else if (e.key === 'Enter' && pickMode && pending.length) {
    e.preventDefault();
    confirmPending();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && pickMode && pending.length) {
    e.preventDefault();
    removeLastPending();
  }
});

// theme: follow the host when it tells us, otherwise the system
let hostTheme = /** @type {string|null} */ (null);
function refreshThemeColors() {
  renderer.setClearColor(css('--cqv-canvas'), 1);
  edgeMaterial.color.set(css('--cqv-edge'));
  sectionMaterial.color.set(css('--cqv-section'));
  /** @type {THREE.LineBasicMaterial} */ (pickLine.material).color.set(css('--mcode-warning'));
  for (const entry of parts.values()) applyMaterial(entry);
  rebuildGrid(visibleBox().isEmpty() ? sceneBox : visibleBox());
  renderParts();
  requestRender();
}
darkQuery.addEventListener('change', () => {
  if (hostTheme) return;
  document.documentElement.dataset.theme = darkQuery.matches ? 'dark' : 'light';
  refreshThemeColors();
});
function applyHostContext(ctx) {
  const theme = ctx && (ctx.theme === 'dark' || ctx.theme === 'light') ? ctx.theme : null;
  if (!theme) return;
  hostTheme = theme; // the host owns the theme from now on, even if it matches the system today
  if (theme === document.documentElement.dataset.theme) return;
  document.documentElement.dataset.theme = theme;
  refreshThemeColors();
}

// ---------------------------------------------------------------- live connection
let events = null;
let offlineTimer = null;
let wasOffline = false;
function rootsInUse() {
  const ids = new Set(prefs.opened.map((k) => parseFileKey(k)?.root).filter(Boolean));
  if (currentRoot) ids.add(currentRoot);
  return ids;
}
function connect() {
  events = new EventSource(apiUrl('events'));
  events.onopen = () => {
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = null;
    if (wasOffline) {
      wasOffline = false;
      showToast('已重新连接', 'info', 1500);
    }
  };
  events.onerror = () => {
    // only surface a problem that lasts; brief reconnects stay invisible
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (events && events.readyState !== EventSource.OPEN) {
        wasOffline = true;
        showToast('连接中断，正在重新连接…', 'warning', 0);
      }
    }, 3000);
  };
  events.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      void refreshScene();
      for (const id of rootsInUse()) void syncFiles(id);
    } else if (msg.type === 'scene') void refreshScene();
    else if (msg.type === 'files' && typeof msg.root === 'string' && rootsInUse().has(msg.root)) void syncFiles(msg.root);
    else if (msg.type === 'roots') void loadRoots().catch(() => {});
    else if (msg.type === 'selection' && msg.client !== clientId) void loadSelection(); // ignore our own echo
    else if (msg.type === 'watch-lost') {
      events?.close();
      setTimeout(connect, 2000);
    }
  };
}

// ---------------------------------------------------------------- boot
const hostBridge = createHostBridge();
hostBridge.onContextChanged(applyHostContext);
let bridgeDetection = null;
/** Handshake with MiniMax Code once; decides which delivery path this window has. */
function detectHostBridge() {
  bridgeDetection ??= (async () => {
    const s = await hostBridge.connect(1500);
    bridgeReady = true;
    applyHostContext(s.hostContext);
    updateCompose();
  })();
  return bridgeDetection;
}

async function boot() {
  void detectHostBridge();
  renderer.setClearColor(css('--cqv-canvas'), 1);
  resize();
  renderPending();
  renderPicks();
  renderParts();

  try {
    await loadRoots();
  } catch (error) {
    el.filesStatus.textContent = `文件夹列表没有读取成功：${error instanceof Error ? error.message : String(error)}`;
  }

  // ?root=<absolute path> (how a session opens the viewer on its own folder) or ?root=<id>
  const requested = new URLSearchParams(location.search).get('root');
  let target = null;
  if (requested) {
    if (ROOT_ID_RE.test(requested) && roots.some((r) => r.id === requested)) target = requested;
    else {
      try {
        target = await registerRoot(requested);
      } catch (error) {
        showToast(`无法打开这个文件夹：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
      }
    }
  }
  if (!target && prefs.root && roots.some((r) => r.id === prefs.root)) target = prefs.root;
  if (!target && roots.length) target = roots[0].id;

  // forget files whose folder is no longer registered
  prefs.opened = prefs.opened.filter((k) => roots.some((r) => r.id === parseFileKey(k)?.root));
  savePrefs();

  if (target) selectRoot(target);
  else renderFileList();
  for (const id of rootsInUse()) if (id !== target) void syncFiles(id);

  await refreshScene();
  afterSceneChange(false);
  await loadSelection();
  connect();
}
void boot();
