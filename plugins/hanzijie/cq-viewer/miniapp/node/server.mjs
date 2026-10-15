// @ts-check
// CadQuery Viewer — Node runtime.
//
// Exchange contract (fixed, documented):
//   ~/.cqview/scene/<name>.stl   parts pushed by cqview.show()                   (read)
//   ~/.cqview/scene/scene.json   optional per-part colour/opacity               (read)
//   ~/.cqview/roots.json         registered folders the page may browse          (read/write)
//   ~/.cqview/selection.json     last picked points, resolved to absolute files  (write)
//   <dataDir>/open-requests.json what the AI asked the page to open (MCP tools)  (read/write)
//
// Folder browsing is scoped: only folders registered in roots.json, only inside the
// user's home directory, only .stl/.step/.stp files, no symlinks, no hidden folders.
// The MCP endpoint (mcp.mjs) only answers loopback requests and reuses the same rules;
// its one extra power is copy_to_scene, which copies a model file into ~/.cqview/scene.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

import { createMcpHandler, MCP_PATH } from './mcp.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./miniapp-api.js').MiniAppLifecycle} MiniAppLifecycle */

const BASE = '/viewer';
const HOME = homedir();
const EXCHANGE_DIR = join(HOME, '.cqview');
const SCENE_DIR = join(EXCHANGE_DIR, 'scene');
const ROOTS_FILE = join(EXCHANGE_DIR, 'roots.json');
const SELECTION_FILE = join(EXCHANGE_DIR, 'selection.json');
const DISPLAY_SCENE_DIR = '~/.cqview/scene';
const DISPLAY_SELECTION_FILE = '~/.cqview/selection.json';

const PART_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(stl|step|stp)$/i;
const PART_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ROOT_ID_RE = /^[a-f0-9]{10}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MODEL_EXT = new Set(['.stl', '.step', '.stp']);
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages']);
const WALK_MAX_DEPTH = 10;
const WALK_MAX_ENTRIES = 50_000;
const WALK_MAX_FILES = 1_000;
const MAX_ROOTS = 20;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_POINTS = 50;
const MAX_NOTE_CHARS = 500;
const CLIENT_ID_RE = /^[a-z0-9]{8,32}$/;
const HEARTBEAT_MS = 20_000;
const WATCH_DEBOUNCE_MS = 250;
const PY_PROBE_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 300_000;
const STEP_MESH_VERSION = 'cqvm-1';
const CQVM_TYPE = 'application/x-cqview-mesh';
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 20;
const REQUEST_TYPES = new Set(['folder', 'file', 'scene']);
const MCP_LIST_LIMIT = 200;
const MAX_COPY_BYTES = 512 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const STEP_TO_STL_PY = [
  'import sys',
  'import cadquery as cq',
  'src, dst = sys.argv[1], sys.argv[2]',
  'wp = cq.importers.importStep(src)',
  'shapes = [v for v in wp.vals() if isinstance(v, cq.Shape)]',
  'if not shapes: sys.exit(3)',
  'shape = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)',
  'tol = max(0.02, shape.BoundingBox().DiagonalLength * 1e-4)',
  'ok = shape.exportStl(dst, tolerance=tol, angularTolerance=0.15, ascii=False, relative=False)',
  'sys.exit(0 if ok is not False else 4)',
].join('\n');

/** Explicit allowlist of static Client assets (path under miniapp/client/assets). */
const ASSETS = /** @type {Record<string, string>} */ ({
  'app.js': 'text/javascript; charset=utf-8',
  'host-bridge.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'logo.svg': 'image/svg+xml',
  'vendor/three.module.min.js': 'text/javascript; charset=utf-8',
  'vendor/OrbitControls.js': 'text/javascript; charset=utf-8',
  'vendor/STLLoader.js': 'text/javascript; charset=utf-8',
});

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} [message] */
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.userMessage = message;
  }
}

/**
 * @param {MiniAppContext} context
 * @returns {Promise<MiniAppLifecycle>}
 */
export async function start(context) {
  const clientRoot = join(context.pluginRoot, 'miniapp', 'client');
  const indexHtml = await readFile(join(clientRoot, 'index.html'));
  const stepCacheDir = join(context.dataDir, 'step-cache');
  const requestsFile = join(context.dataDir, 'open-requests.json');
  const log = context.logger;

  /** Read-modify-write of our JSON files runs one at a time (page and AI can write together). */
  let writeChain = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  /** @type {Map<string, Promise<string>>} */
  const stepJobs = new Map();
  /** @type {Promise<string|null> | null} */
  let pythonProbe = null;

  // ---------- live updates (SSE) ----------
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** @type {import('node:fs').FSWatcher | null} */
  let sceneWatcher = null;
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const rootWatchers = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  let sceneVersion = 0;

  /** @param {Record<string, unknown>} payload */
  const broadcast = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };
  /** @param {string} key @param {() => void} fn */
  const debounced = (key, fn) => {
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, WATCH_DEBOUNCE_MS),
    );
  };

  const ensureSceneWatcher = async () => {
    if (sceneWatcher) return;
    await mkdir(SCENE_DIR, { recursive: true });
    sceneWatcher = watch(SCENE_DIR, { persistent: false }, () =>
      debounced('scene', () => {
        sceneVersion += 1;
        broadcast({ type: 'scene', version: sceneVersion });
      }),
    );
    sceneWatcher.on('error', () => {
      sceneWatcher?.close();
      sceneWatcher = null;
      broadcast({ type: 'watch-lost' });
    });
  };

  const syncRootWatchers = async () => {
    const roots = await readRoots();
    const wanted = new Set();
    for (const r of roots) {
      const id = rootId(r.path);
      wanted.add(id);
      if (rootWatchers.has(id)) continue;
      try {
        const w = watch(r.path, { persistent: false, recursive: true }, (_event, filename) => {
          if (filename && !MODEL_EXT.has(extname(String(filename)).toLowerCase())) return;
          debounced(`root:${id}`, () => broadcast({ type: 'files', root: id }));
        });
        w.on('error', () => {
          w.close();
          rootWatchers.delete(id);
        });
        rootWatchers.set(id, w);
      } catch {
        // folder vanished; the files route reports it
      }
    }
    for (const [id, w] of rootWatchers) {
      if (!wanted.has(id)) {
        w.close();
        rootWatchers.delete(id);
      }
    }
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, HEARTBEAT_MS);

  // ---------- domain: pushed scene ----------
  const readScene = async () => {
    await mkdir(SCENE_DIR, { recursive: true });
    const warnings = [];
    /** @type {Record<string, unknown>} */
    let meta = {};
    try {
      const parsed = JSON.parse(await readFile(join(SCENE_DIR, 'scene.json'), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.parts && typeof parsed.parts === 'object') meta = parsed.parts;
      else warnings.push('scene.json 缺少 parts 字段，已忽略');
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ENOENT') warnings.push('scene.json 无法解析，已忽略');
    }
    const entries = (await readdir(SCENE_DIR)).filter((f) => PART_FILE_RE.test(f)).sort();
    /** @type {Map<string, any>} newest file wins when a name exists in several formats */
    const byName = new Map();
    for (const file of entries) {
      let st;
      try {
        st = await lstat(join(SCENE_DIR, file));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(file).toLowerCase();
      const name = file.slice(0, -ext.length);
      const prev = byName.get(name);
      if (prev && prev.mtime >= Math.round(st.mtimeMs)) continue;
      byName.set(name, {
        name,
        file,
        kind: ext === '.stl' ? 'stl' : 'step',
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        ...sanitizeMeta(meta[name]),
      });
    }
    const parts = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { dir: DISPLAY_SCENE_DIR, selectionFile: DISPLAY_SELECTION_FILE, parts, warnings };
  };

  // ---------- domain: registered folders ----------
  /** @param {unknown} input */
  const addRoot = async (input) => {
    const real = await validateRootPath(input);
    await serial(async () => {
      const roots = await readRoots();
      const next = [{ path: real, used: new Date().toISOString() }, ...roots.filter((r) => r.path !== real)].slice(
        0,
        MAX_ROOTS,
      );
      await writeJsonAtomic(ROOTS_FILE, { roots: next }); // commit first …
    });
    await syncRootWatchers();
    broadcast({ type: 'roots' }); // … then notify
    return describeRoot(real);
  };

  // ---------- domain: requests from the AI (MCP) for the page ----------
  /** @returns {Promise<{epoch: string|null, seq: number, items: Record<string, unknown>[]}>} */
  const readRequests = async () => {
    try {
      const parsed = JSON.parse(await readFile(requestsFile, 'utf8'));
      if (parsed && typeof parsed.epoch === 'string' && Number.isInteger(parsed.seq) && Array.isArray(parsed.items)) {
        const now = Date.now();
        const items = parsed.items.filter(
          (/** @type {any} */ it) =>
            it &&
            Number.isInteger(it.seq) &&
            typeof it.at === 'string' &&
            now - Date.parse(it.at) < REQUEST_TTL_MS &&
            REQUEST_TYPES.has(it.type) &&
            (it.type === 'scene'
              ? typeof it.name === 'string' && PART_NAME_RE.test(it.name)
              : typeof it.root === 'string' && ROOT_ID_RE.test(it.root) && (it.type === 'folder' || typeof it.rel === 'string')),
        );
        return { epoch: parsed.epoch, seq: parsed.seq, items };
      }
    } catch {
      /* none yet */
    }
    return { epoch: null, seq: 0, items: [] };
  };

  /** Persist a request (the page may not be open, or the process may restart), then notify. */
  const pushRequest = async (/** @type {Record<string, unknown>} */ req) => {
    const seq = await serial(async () => {
      const doc = await readRequests();
      const next = doc.seq + 1;
      const items = [...doc.items, { seq: next, at: new Date().toISOString(), ...req }].slice(-MAX_REQUESTS);
      await writeJsonAtomic(requestsFile, { epoch: doc.epoch ?? randomBytes(6).toString('hex'), seq: next, items });
      return next;
    });
    broadcast({ type: 'request', seq });
    return seq;
  };

  const viewerConnected = () => clients.size > 0;

  /** @param {string} p */
  const folderInfo = (p) => ({ id: rootId(p), path: p, label: basename(p) });

  /** @param {string} rootPath @param {{rel: string, size: number, kind: string}[]} files */
  const modelList = (rootPath, files) =>
    files.slice(0, MCP_LIST_LIMIT).map((f) => ({ path: join(rootPath, ...f.rel.split('/')), kind: f.kind, size: f.size }));

  /** @param {{path: string, select?: boolean}} args */
  const addModelFolder = async (args) => {
    const real = await validateRootPath(args.path);
    await addRoot(real);
    const { files, truncated } = await listModels(real);
    if (args.select !== false) await pushRequest({ type: 'folder', root: rootId(real) });
    return {
      folder: folderInfo(real),
      model_count: files.length,
      truncated,
      models: modelList(real, files),
      viewer_connected: viewerConnected(),
    };
  };

  /** @param {{path: string, copy_to_scene?: boolean, name?: string, color?: string, opacity?: number}} args */
  const addModelFile = async (args) => {
    const src = await validateModelPath(args.path);
    if (args.copy_to_scene) return copyToScene(src, args);
    if (args.name !== undefined || args.color !== undefined || args.opacity !== undefined) {
      throw new HttpError(400, 'copy_only_option', 'name、color、opacity 只在 copy_to_scene 为 true 时可用');
    }
    if (basename(src.real).startsWith('.')) throw new HttpError(400, 'hidden_file', '不能打开隐藏文件');
    if (!isAllowedRoot(dirname(src.real))) {
      throw new HttpError(
        400,
        'outside_home',
        '只能原地打开用户主目录内的文件（不能直接放在主目录下，也不能在 ~/Library 或隐藏的顶层目录里）；其他位置的文件请加 copy_to_scene: true',
      );
    }
    // closest registered folder that really lists the file, else register its own folder
    const candidates = (await readRoots())
      .filter((r) => src.real.startsWith(r.path + sep))
      .sort((a, b) => b.path.length - a.path.length);
    /** @type {{rootPath: string, rel: string} | null} */
    let chosen = null;
    for (const r of candidates) {
      const rel = relative(r.path, src.real).split(sep).join('/');
      if (!isListableRel(rel)) continue;
      const { files } = await listModels(r.path);
      if (files.some((f) => f.rel === rel)) {
        chosen = { rootPath: r.path, rel };
        break;
      }
    }
    if (!chosen) {
      const dir = dirname(src.real);
      const rel = basename(src.real);
      await validateRootPath(dir);
      const { files } = await listModels(dir);
      if (!files.some((f) => f.rel === rel)) {
        throw new HttpError(422, 'not_listed', '这个文件所在的文件夹模型太多，查看器列不出它');
      }
      chosen = { rootPath: dir, rel };
    }
    await addRoot(chosen.rootPath); // registers it, or marks it recently used
    await pushRequest({ type: 'file', root: rootId(chosen.rootPath), rel: chosen.rel });
    return {
      mode: 'reference',
      path: src.real,
      kind: src.ext === '.stl' ? 'stl' : 'step',
      size: src.stat.size,
      folder: folderInfo(chosen.rootPath),
      rel: chosen.rel,
      viewer_connected: viewerConnected(),
      note: '原地打开：之后重新导出这个文件，查看器会自动刷新，不用再调用。',
    };
  };

  /**
   * Copy a model file into the pushed scene, like cqview.show_file().
   * @param {{real: string, stat: import('node:fs').Stats, ext: string}} src
   * @param {{name?: string, color?: string, opacity?: number}} opts
   */
  const copyToScene = async (src, opts) => {
    const name = opts.name ?? sceneNameFrom(src.real);
    if (!PART_NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', '模型名只能用字母、数字、. _ -，且不能以 . 开头');
    if (src.stat.size === 0) throw new HttpError(422, 'empty_file', '这个文件是空的');
    if (src.stat.size > MAX_COPY_BYTES) throw new HttpError(413, 'file_too_large', '文件超过 512 MB，不能复制');
    const dst = join(SCENE_DIR, `${name}${src.ext}`);
    await serial(async () => {
      await mkdir(SCENE_DIR, { recursive: true });
      const tmp = join(SCENE_DIR, `.${name}.${process.pid}.${Date.now()}.tmp`);
      try {
        await copyFile(src.real, tmp);
        await rename(tmp, dst);
      } finally {
        await unlink(tmp).catch(() => {});
      }
      for (const ext of MODEL_EXT) {
        if (ext !== src.ext) await unlink(join(SCENE_DIR, `${name}${ext}`)).catch(() => {});
      }
      await setSceneMeta(name, opts);
    });
    await pushRequest({ type: 'scene', name });
    return {
      mode: 'copy',
      name,
      scene_file: dst,
      source: src.real,
      kind: src.ext === '.stl' ? 'stl' : 'step',
      size: src.stat.size,
      viewer_connected: viewerConnected(),
      note: '这是一份副本：源文件之后的修改不会同步，需要时再调用一次。',
    };
  };

  /** Same rules as cqview.py: a push replaces the part's colour/opacity with what was given. */
  const setSceneMeta = async (/** @type {string} */ name, /** @type {{color?: string, opacity?: number}} */ opts) => {
    const file = join(SCENE_DIR, 'scene.json');
    /** @type {{parts: Record<string, unknown>}} */
    let meta = { parts: {} };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.parts && typeof parsed.parts === 'object') meta = parsed;
    } catch {
      /* missing or unreadable: start fresh */
    }
    /** @type {Record<string, unknown>} */
    const entry = {};
    if (opts.color !== undefined) entry.color = opts.color.toLowerCase();
    if (opts.opacity !== undefined) entry.opacity = clamp(opts.opacity, 0.05, 1);
    const had = Object.hasOwn(meta.parts, name);
    if (!had && !Object.keys(entry).length) return;
    if (Object.keys(entry).length) meta.parts[name] = entry;
    else delete meta.parts[name];
    await writeJsonAtomic(file, meta);
  };

  /** @param {{folder?: string}} args */
  const listModelFolders = async (args) => {
    const roots = await readRoots();
    if (args.folder === undefined) {
      const folders = [];
      for (const r of roots) {
        const st = await stat(r.path).catch(() => null);
        folders.push({ ...folderInfo(r.path), exists: !!st && st.isDirectory(), last_used: r.used ?? null });
      }
      const scene = await readScene();
      return {
        folders,
        scene: {
          dir: SCENE_DIR,
          models: scene.parts.map((p) => ({ name: p.name, path: join(SCENE_DIR, p.file), kind: p.kind, size: p.size })),
        },
        viewer_connected: viewerConnected(),
      };
    }
    let root = ROOT_ID_RE.test(args.folder) ? roots.find((r) => rootId(r.path) === args.folder) : undefined;
    if (!root) {
      let p = args.folder.trim();
      if (p === '~' || p.startsWith('~/')) p = join(HOME, p.slice(1));
      const real = isAbsolute(p) ? await realpath(p).catch(() => null) : null;
      root = real ? roots.find((r) => r.path === real) : undefined;
    }
    if (!root) throw new HttpError(404, 'root_not_registered', '这个文件夹还没有登记，先调用 add_model_folder');
    const st = await stat(root.path).catch(() => null);
    if (!st || !st.isDirectory()) throw new HttpError(404, 'root_missing', '文件夹已不存在');
    const { files, truncated } = await listModels(root.path);
    return {
      folder: folderInfo(root.path),
      model_count: files.length,
      truncated,
      models: modelList(root.path, files),
      viewer_connected: viewerConnected(),
    };
  };

  const handleMcp = createMcpHandler({
    addModelFolder,
    addModelFile,
    listModelFolders,
    log: (message) => log.info(message),
  });

  /** @param {string} file @param {import('node:fs').Stats} st @returns {Promise<{path: string, type: 'cqvm'|'stl'}>} */
  const stepToMesh = async (file, st) => {
    const key = createHash('sha1').update(`${STEP_MESH_VERSION}|${file}|${st.size}|${st.mtimeMs}`).digest('hex');
    const outMesh = join(stepCacheDir, `${key}.cqvm`);
    const outStl = join(stepCacheDir, `${key}.stl`);
    for (const [path, type] of /** @type {const} */ ([[outMesh, 'cqvm'], [outStl, 'stl']])) {
      try {
        await access(path);
        return { path, type };
      } catch {
        /* not cached yet */
      }
    }
    const running = stepJobs.get(key);
    if (running) return running;
    const job = (async () => {
      const python = await findPython();
      if (!python) throw new HttpError(503, 'step_unavailable', '打开 STEP 需要本机的 Python 和 CadQuery');
      await mkdir(stepCacheDir, { recursive: true });
      // 1) full fidelity: assembly names, colours, real edges
      const tmpMesh = `${outMesh}.${process.pid}.tmp`;
      try {
        await runChild(python, [join(context.pluginRoot, 'miniapp', 'node', 'step_mesh.py'), file, tmpMesh], STEP_TIMEOUT_MS);
        await rename(tmpMesh, outMesh);
        return { path: outMesh, type: /** @type {const} */ ('cqvm') };
      } catch (error) {
        await unlink(tmpMesh).catch(() => {});
        const code = /** @type {any} */ (error).code;
        if (code === 'exit_3' || code === 'exit_4') {
          throw new HttpError(422, 'step_convert_failed', code === 'exit_3' ? '这个 STEP 文件读不出来，可能已损坏' : '这个 STEP 文件里没有实体');
        }
        log.warn('cqviewer.step.mesh_failed', { code: code ?? 'unknown' });
      }
      // 2) fallback: single merged mesh
      const tmpStl = `${outStl}.${process.pid}.tmp`;
      try {
        await runChild(python, ['-c', STEP_TO_STL_PY, file, tmpStl], STEP_TIMEOUT_MS);
        await rename(tmpStl, outStl);
        return { path: outStl, type: /** @type {const} */ ('stl') };
      } catch (error) {
        await unlink(tmpStl).catch(() => {});
        log.warn('cqviewer.step.convert_failed', { code: /** @type {any} */ (error).code ?? 'unknown' });
        throw new HttpError(422, 'step_convert_failed', 'STEP 没有打开成功，文件可能已损坏或不含实体');
      }
    })().finally(() => stepJobs.delete(key));
    stepJobs.set(key, job);
    return job;
  };

  /** Stream a model file, converting STEP on the way. */
  const serveModel = async (response, full, st, kind) => {
    if (kind === 'stl') return streamFile(response, full, st.size, 'model/stl');
    const converted = await stepToMesh(full, st);
    const cst = await stat(converted.path);
    return streamFile(response, converted.path, cst.size, converted.type === 'cqvm' ? CQVM_TYPE : 'model/stl');
  };

  /** @returns {Promise<string|null>} */
  const findPython = () => {
    if (!pythonProbe) {
      pythonProbe = (async () => {
        const candidates = [
          process.env.CQVIEW_PYTHON,
          'python3',
          'python', // Windows installs usually only provide this name
          '/usr/bin/python3',
          '/opt/homebrew/bin/python3',
          '/usr/local/bin/python3',
        ].filter((c) => typeof c === 'string' && c.length > 0);
        for (const c of /** @type {string[]} */ (candidates)) {
          try {
            await runChild(c, ['-c', 'import cadquery'], PY_PROBE_TIMEOUT_MS);
            return c;
          } catch {
            /* try next */
          }
        }
        return null;
      })().then((found) => {
        if (!found) pythonProbe = null; // retry next time (e.g. after installing cadquery)
        return found;
      });
    }
    return pythonProbe;
  };

  /** @param {string} cmd @param {string[]} args @param {number} timeoutMs */
  const runChild = (cmd, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      // stdout is reserved for the Host protocol: never inherit it.
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
      children.add(child);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        children.delete(child);
        reject(error);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        if (code === 0) resolve(undefined);
        else reject(Object.assign(new Error('child failed'), { code: signal ? `signal_${signal}` : `exit_${code}` }));
      });
    });

  // ---------- domain: selection ----------
  const readSelection = async () => {
    try {
      return JSON.parse(await readFile(SELECTION_FILE, 'utf8'));
    } catch {
      return { points: [] };
    }
  };

  /** @param {unknown} body */
  const writeSelection = async (body) => {
    const raw = validateSelection(body);
    const points = [];
    for (const p of raw) {
      const { ref, ...rest } = p;
      const file = await resolveRef(ref);
      // keep the ref only when it resolves to a real file the viewer may read
      points.push(file ? { ...rest, ref, file } : rest);
    }
    /** @type {Record<string, unknown>} */
    const doc = { updated: new Date().toISOString(), unit: 'mm', count: points.length, points };
    const instruction = /** @type {any} */ (body).instruction;
    if (typeof instruction === 'string') {
      const text = instruction.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);
      if (text) doc.instruction = text;
    }
    if (points.length >= 2) {
      doc.segments = points.slice(1).map((b, i) => {
        const a = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        return { from: a.index, to: b.index, d: round(Math.hypot(dx, dy, dz)), dx: round(dx), dy: round(dy), dz: round(dz) };
      });
    }
    if (points.length === 2) {
      const { d, dx, dy, dz } = /** @type {any[]} */ (doc.segments)[0];
      doc.distance = { d, dx, dy, dz };
    }
    await writeJsonAtomic(SELECTION_FILE, doc); // commit first …
    const client = /** @type {any} */ (body).client;
    broadcast({ type: 'selection', client: typeof client === 'string' && CLIENT_ID_RE.test(client) ? client : null }); // … then notify
    return doc;
  };

  /** @param {unknown} ref */
  const resolveRef = async (ref) => {
    if (!ref || typeof ref !== 'object') return null;
    const r = /** @type {Record<string, unknown>} */ (ref);
    if (r.source === 'scene' && typeof r.name === 'string' && PART_NAME_RE.test(r.name)) {
      for (const ext of ['.stl', '.step', '.stp']) {
        const candidate = join(SCENE_DIR, `${r.name}${ext}`);
        const st = await lstat(candidate).catch(() => null);
        if (st && st.isFile()) return candidate;
      }
      return null;
    }
    if (r.source === 'file' && typeof r.root === 'string' && typeof r.rel === 'string') {
      const root = await findRoot(r.root);
      if (!root) return null;
      try {
        return (await resolveModel(root.path, r.rel)).full;
      } catch {
        return null;
      }
    }
    return null;
  };

  // ---------- HTTP ----------
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (error instanceof HttpError) {
        if (!response.headersSent) sendJson(response, error.status, { error: error.code, message: error.userMessage });
        else response.end();
        return;
      }
      log.error('cqviewer.request.failed', { code: error?.code ?? 'unknown' });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else response.end();
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    // MCP: the Host's MCP client calls this over loopback. Refuse anything a browser page on another
    // origin (or a DNS-rebound hostname) could send.
    if (path === MCP_PATH) {
      if (!isLoopbackRequest(request)) return sendJson(response, 403, { error: 'forbidden' });
      if (method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      const body = await readJsonBody(request);
      const reply = await handleMcp(body);
      if (reply === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      return sendJson(response, 200, reply);
    }

    if (method === 'GET' && path === BASE) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      response.end(indexHtml);
      return;
    }
    if (method === 'GET' && path === `${BASE}/`) {
      response.writeHead(302, { location: `${BASE}${url.search}` });
      response.end();
      return;
    }
    if (method === 'GET' && path.startsWith(`${BASE}/assets/`)) {
      const rel = path.slice(`${BASE}/assets/`.length);
      const type = Object.prototype.hasOwnProperty.call(ASSETS, rel) ? ASSETS[rel] : undefined;
      if (!type) return sendJson(response, 404, { error: 'not_found' });
      const body = await readFile(join(clientRoot, 'assets', ...rel.split('/')));
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      response.end(body);
      return;
    }

    // pushed scene
    if (method === 'GET' && path === `${BASE}/api/scene`) return sendJson(response, 200, await readScene());
    if (method === 'GET' && path.startsWith(`${BASE}/api/part/`)) {
      let file = '';
      try {
        file = decodeURIComponent(path.slice(`${BASE}/api/part/`.length));
      } catch {
        throw new HttpError(400, 'invalid_part_name');
      }
      if (!PART_FILE_RE.test(file)) throw new HttpError(400, 'invalid_part_name');
      const full = join(SCENE_DIR, file);
      const st = await lstat(full).catch(() => null);
      if (!st || !st.isFile()) throw new HttpError(404, 'part_not_found', '文件已不存在');
      return serveModel(response, full, st, extname(file).toLowerCase() === '.stl' ? 'stl' : 'step');
    }

    // registered folders
    if (method === 'GET' && path === `${BASE}/api/roots`) {
      const roots = await readRoots();
      return sendJson(response, 200, { roots: roots.map((r) => describeRoot(r.path)) });
    }
    if (method === 'POST' && path === `${BASE}/api/roots`) {
      const body = await readJsonBody(request);
      const root = await addRoot(/** @type {any} */ (body)?.path);
      return sendJson(response, 200, { root });
    }
    if (method === 'GET' && path === `${BASE}/api/files`) {
      const root = await requireRoot(url.searchParams.get('root'));
      const st = await stat(root.path).catch(() => null);
      if (!st || !st.isDirectory()) throw new HttpError(404, 'root_missing', '文件夹已不存在');
      const { files, truncated } = await listModels(root.path);
      return sendJson(response, 200, { root: describeRoot(root.path), files, truncated });
    }
    if (method === 'GET' && path === `${BASE}/api/file`) {
      const root = await requireRoot(url.searchParams.get('root'));
      const model = await resolveModel(root.path, url.searchParams.get('rel'));
      return serveModel(response, model.full, model.stat, model.kind);
    }

    // selection
    if (method === 'GET' && path === `${BASE}/api/selection`) return sendJson(response, 200, await readSelection());
    if (method === 'POST' && path === `${BASE}/api/selection`) {
      const body = await readJsonBody(request);
      return sendJson(response, 200, await writeSelection(body));
    }

    // what the AI asked the page to open
    if (method === 'GET' && path === `${BASE}/api/requests`) return sendJson(response, 200, await readRequests());


    // live updates
    if (method === 'GET' && path === `${BASE}/api/events`) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write('retry: 2000\n\n');
      clients.add(response);
      response.on('close', () => clients.delete(response));
      try {
        await ensureSceneWatcher();
        await syncRootWatchers();
        response.write(`data: ${JSON.stringify({ type: 'hello', version: sceneVersion })}\n\n`);
      } catch {
        response.write(`data: ${JSON.stringify({ type: 'watch-lost' })}\n\n`);
      }
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  }

  await listen(server, context.listen.host, context.listen.port);
  log.info('cqviewer.runtime.listening');

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    clearInterval(heartbeat);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    sceneWatcher?.close();
    sceneWatcher = null;
    for (const w of rootWatchers.values()) w.close();
    rootWatchers.clear();
    for (const c of children) c.kill('SIGKILL');
    children.clear();
    for (const res of clients) res.end();
    clients.clear();
    server.closeAllConnections?.();
    await close(server);
  };
  const onAbort = () => {
    void dispose();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

// ---------------------------------------------------------------- folders

/** @param {string} p */
function rootId(p) {
  return createHash('sha1').update(p).digest('hex').slice(0, 10);
}

/** @param {string} p */
function displayPath(p) {
  if (p === HOME) return '~';
  return p.startsWith(HOME + sep) ? `~${p.slice(HOME.length)}` : p;
}

/** @param {string} p */
function describeRoot(p) {
  return { id: rootId(p), label: basename(p), display: displayPath(p) };
}

/** @returns {Promise<{path: string, used?: string}[]>} */
async function readRoots() {
  try {
    const parsed = JSON.parse(await readFile(ROOTS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.roots)) {
      return parsed.roots.filter(
        (/** @type {any} */ r) => r && typeof r.path === 'string' && isAbsolute(r.path) && isAllowedRoot(r.path),
      );
    }
  } catch {
    /* no registry yet */
  }
  return [];
}

/** @param {string | null} id */
async function findRoot(id) {
  if (!id || !ROOT_ID_RE.test(id)) return null;
  return (await readRoots()).find((r) => rootId(r.path) === id) ?? null;
}

/** @param {string | null} id */
async function requireRoot(id) {
  const root = await findRoot(id);
  if (!root) throw new HttpError(404, 'root_not_registered', '这个文件夹还没有登记');
  return root;
}

/** Folders must live under the home directory, not be home itself, not hidden/Library at the top level. */
function isAllowedRoot(/** @type {string} */ p) {
  if (!p.startsWith(HOME + sep)) return false;
  const first = p.slice(HOME.length + 1).split(sep)[0];
  return !!first && !first.startsWith('.') && first !== 'Library';
}

/** @param {unknown} input */
async function validateRootPath(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || input.includes('\0')) {
    throw new HttpError(400, 'invalid_root', '请输入文件夹路径');
  }
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = join(HOME, p.slice(1));
  if (!isAbsolute(p)) throw new HttpError(400, 'invalid_root', '请输入绝对路径（可用 ~/ 开头）');
  let real;
  try {
    real = await realpath(p);
  } catch {
    throw new HttpError(400, 'invalid_root', '文件夹不存在');
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new HttpError(400, 'invalid_root', '这不是文件夹');
  if (!isAllowedRoot(real)) throw new HttpError(400, 'invalid_root', '只能添加用户目录下的项目文件夹');
  return real;
}

/** @param {string} rootPath */
async function listModels(rootPath) {
  /** @type {{rel: string, size: number, mtime: number, kind: 'stl'|'step'}[]} */
  const files = [];
  let scanned = 0;
  let truncated = false;
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (truncated) return;
      if (++scanned > WALK_MAX_ENTRIES || files.length >= WALK_MAX_FILES) {
        truncated = true;
        return;
      }
      if (d.name.startsWith('.')) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && depth < WALK_MAX_DEPTH) await walk(full, depth + 1);
      } else if (d.isFile()) {
        const ext = extname(d.name).toLowerCase();
        if (!MODEL_EXT.has(ext)) continue;
        const st = await lstat(full).catch(() => null);
        if (!st) continue;
        files.push({
          rel: relative(rootPath, full).split(sep).join('/'),
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          kind: ext === '.stl' ? 'stl' : 'step',
        });
      }
    }
  };
  await walk(rootPath, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'));
  return { files, truncated };
}

/** @param {string} rootPath @param {unknown} rel */
async function resolveModel(rootPath, rel) {
  const bad = () => new HttpError(400, 'invalid_file', '文件路径无效');
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0') || rel.includes('\\')) throw bad();
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) throw bad();
  const ext = extname(rel).toLowerCase();
  if (!MODEL_EXT.has(ext)) throw bad();
  const full = join(rootPath, ...segs);
  let real;
  try {
    real = await realpath(full);
  } catch {
    throw new HttpError(404, 'file_not_found', '文件已不存在');
  }
  if (real !== full) throw bad(); // symlink somewhere on the path
  const st = await lstat(full);
  if (!st.isFile()) throw bad();
  return { full, stat: st, kind: /** @type {'stl'|'step'} */ (ext === '.stl' ? 'stl' : 'step') };
}

/**
 * A model file named by the AI: absolute (or ~/), an allowed extension, a regular file.
 * Symbolic links are resolved; every later rule applies to the real path.
 * @param {unknown} input
 */
async function validateModelPath(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || input.includes('\0')) {
    throw new HttpError(400, 'invalid_path', '请提供模型文件的绝对路径');
  }
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = join(HOME, p.slice(1));
  if (!isAbsolute(p)) throw new HttpError(400, 'invalid_path', '请提供绝对路径（可用 ~/ 开头）');
  if (!MODEL_EXT.has(extname(p).toLowerCase())) throw new HttpError(400, 'unsupported_type', '只支持 .stl、.step、.stp 文件');
  let real;
  try {
    real = await realpath(p);
  } catch {
    throw new HttpError(404, 'file_not_found', '文件不存在');
  }
  const ext = extname(real).toLowerCase();
  if (!MODEL_EXT.has(ext)) throw new HttpError(400, 'unsupported_type', '只支持 .stl、.step、.stp 文件');
  const st = await stat(real);
  if (!st.isFile()) throw new HttpError(400, 'not_a_file', '这不是文件');
  return { real, stat: st, ext };
}

/** Would listModels() list this path, relative to its folder? */
function isListableRel(/** @type {string} */ rel) {
  const segs = rel.split('/');
  if (segs.length - 1 > WALK_MAX_DEPTH) return false;
  return segs.every((s, i) => !!s && !s.startsWith('.') && (i === segs.length - 1 || !SKIP_DIRS.has(s)));
}

/** Scene name from a file name, like cqview.show_file(). */
function sceneNameFrom(/** @type {string} */ file) {
  const stem = basename(file, extname(file))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 100);
  return stem || 'model';
}

/**
 * Host must be loopback (blocks DNS rebinding); Origin, when a browser sends one, too.
 * The Host's MCP client is a Node process and sends no Origin.
 * @param {import('node:http').IncomingMessage} request
 */
function isLoopbackRequest(request) {
  const host = request.headers.host;
  if (host !== undefined && !LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/:?#]+)/i.exec(origin);
  return !!m && LOOPBACK_HOSTS.has(hostnameOf(m[1]));
}

/** @param {string} hostHeader */
function hostnameOf(hostHeader) {
  const h = hostHeader.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\]/.exec(h);
  if (bracketed) return bracketed[1];
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

// ---------------------------------------------------------------- helpers

/** @param {unknown} raw */
function sanitizeMeta(raw) {
  /** @type {{color?: string, opacity?: number, edges?: boolean}} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const m = /** @type {Record<string, unknown>} */ (raw);
  if (typeof m.color === 'string' && COLOR_RE.test(m.color)) out.color = m.color.toLowerCase();
  if (typeof m.opacity === 'number' && Number.isFinite(m.opacity)) out.opacity = clamp(m.opacity, 0.05, 1);
  if (typeof m.edges === 'boolean') out.edges = m.edges;
  return out;
}

/** @param {unknown} body */
function validateSelection(body) {
  const fail = () => new HttpError(400, 'invalid_selection');
  if (!body || typeof body !== 'object') throw fail();
  const pts = /** @type {any} */ (body).points;
  if (!Array.isArray(pts) || pts.length > MAX_POINTS) throw fail();
  return pts.map((p, i) => {
    if (!p || typeof p !== 'object') throw fail();
    const x = num(p.x);
    const y = num(p.y);
    const z = num(p.z);
    if (x === null || y === null || z === null) throw fail();
    const part =
      typeof p.part === 'string' && p.part.length <= 200 && !/[\u0000-\u001f]/.test(p.part) ? p.part : null;
    /** @type {{index: number, label: string, part: string|null, x: number, y: number, z: number, normal?: {x:number,y:number,z:number}, note?: string, ref?: unknown}} */
    const point = { index: i + 1, label: `#${i + 1}`, part, x: round(x), y: round(y), z: round(z) };
    if (typeof p.body === 'string' && p.body.length <= 300 && !/[\u0000-\u001f]/.test(p.body)) {
      /** @type {any} */ (point).body = p.body; // part inside a STEP assembly, e.g. "总成/pins/pin_right"
    }
    if (p.normal && typeof p.normal === 'object') {
      const nx = num(p.normal.x);
      const ny = num(p.normal.y);
      const nz = num(p.normal.z);
      if (nx !== null && ny !== null && nz !== null) point.normal = { x: round(nx, 4), y: round(ny, 4), z: round(nz, 4) };
    }
    if (typeof p.note === 'string') {
      // free text for the AI: keep newlines/tabs, drop other control characters
      const note = p.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_NOTE_CHARS);
      if (note) point.note = note;
    }
    if (p.ref && typeof p.ref === 'object') {
      const r = p.ref;
      if (r.source === 'scene' && typeof r.name === 'string' && PART_NAME_RE.test(r.name)) {
        point.ref = { source: 'scene', name: r.name };
      } else if (
        r.source === 'file' &&
        typeof r.root === 'string' &&
        ROOT_ID_RE.test(r.root) &&
        typeof r.rel === 'string' &&
        r.rel.length <= 1024 &&
        !/[\u0000-\u001f\\]/.test(r.rel)
      ) {
        point.ref = { source: 'file', root: r.root, rel: r.rel };
      }
    }
    return point;
  });
}

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7 ? v : null;
}

/** @param {number} v @param {number} [digits] */
function round(v, digits = 3) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** @param {string} file @param {unknown} data */
async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * JSON-only bodies: a cross-site page cannot send application/json without a CORS preflight,
 * which this server never grants.
 * @param {import('node:http').IncomingMessage} request
 */
async function readJsonBody(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    request.resume();
    throw new HttpError(415, 'json_required');
  }
  const text = await new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the error response can still be delivered
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
  try {
    return JSON.parse(/** @type {string} */ (text));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {string} file
 * @param {number} size
 * @param {string} type
 */
function streamFile(response, file, size, type) {
  response.writeHead(200, { 'content-type': type, 'content-length': String(size), 'cache-control': 'no-store' });
  const stream = createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

/** @param {import('node:http').Server} server @param {string} host @param {number} port */
function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
}

/** @param {import('node:http').Server} server */
function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  });
}
