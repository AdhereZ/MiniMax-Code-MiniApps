// Run: node --test plugins/hanzijie/cq-viewer/tests/*.test.mjs
// Starts the real Node entry against a throw-away HOME and dataDir, then drives the MCP endpoint.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
// a minimal binary STL: 80-byte header, one triangle
const STL = Buffer.concat([Buffer.alloc(80), Buffer.from([1, 0, 0, 0]), Buffer.alloc(50)]);

let home = '';
let outside = '';
let port = 0;
let lifecycle = /** @type {{dispose(): Promise<void>|void} | null} */ (null);
let rpcId = 0;

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'cqv-home-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'cqv-outside-')));
  process.env.HOME = home; // read by os.homedir() when server.mjs loads
  process.env.USERPROFILE = home;
  await mkdir(join(home, 'proj', 'parts', 'deep'), { recursive: true });
  await mkdir(join(home, 'loose'), { recursive: true });
  await writeFile(join(home, 'proj', 'bracket.stl'), STL);
  await writeFile(join(home, 'proj', 'parts', 'deep', 'pin.step'), 'ISO-10303-21;\n');
  await writeFile(join(home, 'loose', 'cover.stl'), STL);
  await writeFile(join(outside, 'scratch part.stl'), STL);
  port = await freePort();
  const { start } = await import(new URL('../miniapp/node/server.mjs', import.meta.url).href);
  const noop = () => {};
  lifecycle = await start({
    pluginId: 'cq-viewer',
    pluginRoot: PLUGIN_ROOT,
    dataDir: join(home, 'data'),
    listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  });
});

after(async () => {
  await lifecycle?.dispose();
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('initialize and tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'cq-viewer');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const list = await rpc('tools/list');
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['add_model_folder', 'add_model_file', 'list_model_folders'],
  );
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
});

test('add_model_folder registers the folder, lists models, and queues a select request', async () => {
  const out = await call('add_model_folder', { path: '~/proj' });
  assert.equal(out.ok, true);
  assert.equal(out.folder.path, join(home, 'proj'));
  assert.equal(out.model_count, 2);
  assert.deepEqual(out.models.map((m) => m.path).sort(), [join(home, 'proj', 'bracket.stl'), join(home, 'proj', 'parts', 'deep', 'pin.step')]);
  assert.equal(out.viewer_connected, false);
  const roots = JSON.parse(await readFile(join(home, '.cqview', 'roots.json'), 'utf8'));
  assert.equal(roots.roots[0].path, join(home, 'proj'));
  const reqs = await getJson('/viewer/api/requests');
  const last = reqs.items.at(-1);
  assert.equal(last.type, 'folder');
  assert.equal(last.root, out.folder.id);
});

test('add_model_folder rejects home itself, hidden top-level folders, and missing folders', async () => {
  for (const path of ['~', join(home, 'nope')]) {
    const out = await call('add_model_folder', { path });
    assert.equal(out.ok, false, path);
  }
  await mkdir(join(home, '.secret'), { recursive: true });
  const hidden = await call('add_model_folder', { path: join(home, '.secret') });
  assert.equal(hidden.ok, false);
});

test('add_model_file opens in place through the closest registered folder', async () => {
  const out = await call('add_model_file', { path: join(home, 'proj', 'parts', 'deep', 'pin.step') });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'reference');
  assert.equal(out.folder.path, join(home, 'proj'));
  assert.equal(out.rel, 'parts/deep/pin.step');
  assert.equal(out.kind, 'step');
  const reqs = await getJson('/viewer/api/requests');
  assert.deepEqual(
    { type: reqs.items.at(-1).type, root: reqs.items.at(-1).root, rel: reqs.items.at(-1).rel },
    { type: 'file', root: out.folder.id, rel: 'parts/deep/pin.step' },
  );
  // the page can read files of the folder it was pointed at
  const ok = await fetchRaw(`/viewer/api/file?root=${out.folder.id}&rel=bracket.stl`);
  assert.equal(ok.status, 200);
});

test('add_model_file registers the parent folder when no registered folder covers the file', async () => {
  const out = await call('add_model_file', { path: '~/loose/cover.stl' });
  assert.equal(out.ok, true);
  assert.equal(out.folder.path, join(home, 'loose'));
  assert.equal(out.rel, 'cover.stl');
  const list = await call('list_model_folders', {});
  assert.deepEqual(list.folders.map((f) => f.path), [join(home, 'loose'), join(home, 'proj')]);
});

test('add_model_file outside home needs copy_to_scene, which copies into the scene with colour', async () => {
  const src = join(outside, 'scratch part.stl');
  const refused = await call('add_model_file', { path: src });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'outside_home');

  const copied = await call('add_model_file', { path: src, copy_to_scene: true, color: '#4F8CFF', opacity: 0.5 });
  assert.equal(copied.ok, true);
  assert.equal(copied.mode, 'copy');
  assert.equal(copied.name, 'scratch_part');
  assert.equal(copied.scene_file, join(home, '.cqview', 'scene', 'scratch_part.stl'));
  assert.deepEqual(await readFile(copied.scene_file), STL);
  const meta = JSON.parse(await readFile(join(home, '.cqview', 'scene', 'scene.json'), 'utf8'));
  assert.deepEqual(meta.parts.scratch_part, { color: '#4f8cff', opacity: 0.5 });
  const scene = await getJson('/viewer/api/scene');
  assert.deepEqual(scene.parts.map((p) => p.name), ['scratch_part']);

  // pushing again without colour clears it, like cqview.show_file()
  await call('add_model_file', { path: src, copy_to_scene: true });
  const meta2 = JSON.parse(await readFile(join(home, '.cqview', 'scene', 'scene.json'), 'utf8'));
  assert.equal(meta2.parts.scratch_part, undefined);

  const reqs = await getJson('/viewer/api/requests');
  assert.equal(reqs.items.at(-1).type, 'scene');
  assert.equal(reqs.items.at(-1).name, 'scratch_part');
});

test('list_model_folders with a folder lists its models; scene is reported', async () => {
  const byPath = await call('list_model_folders', { folder: '~/proj' });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.model_count, 2);
  const byId = await call('list_model_folders', { folder: byPath.folder.id });
  assert.equal(byId.folder.path, join(home, 'proj'));
  const all = await call('list_model_folders', {});
  assert.equal(all.scene.models[0].name, 'scratch_part');
  const missing = await call('list_model_folders', { folder: outside });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'root_not_registered');
});

test('argument and file-type errors come back as tool errors', async () => {
  const bad = await call('add_model_file', { path: join(home, 'proj', 'bracket.stl'), color: 'red' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_arguments');
  const extra = await call('add_model_folder', { path: '~/proj', bogus: 1 });
  assert.equal(extra.error.code, 'invalid_arguments');
  await writeFile(join(home, 'proj', 'notes.txt'), 'x');
  const txt = await call('add_model_file', { path: join(home, 'proj', 'notes.txt') });
  assert.equal(txt.error.code, 'unsupported_type');
  const copyOnly = await call('add_model_file', { path: join(home, 'proj', 'bracket.stl'), name: 'x' });
  assert.equal(copyOnly.error.code, 'copy_only_option');
  const unknown = await rpc('tools/call', { name: 'rm_rf', arguments: {} });
  assert.equal(unknown.error.code, -32602);
});

test('the MCP endpoint refuses non-loopback Host/Origin, GET, and non-JSON bodies', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await raw('POST', '/mcp/cq-viewer', body, { host: 'evil.example.com' })).status, 403);
  assert.equal((await raw('POST', '/mcp/cq-viewer', body, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await raw('POST', '/mcp/cq-viewer', body, { origin: 'http://127.0.0.1:1' })).status, 403); // other local app
  assert.equal((await raw('POST', '/mcp/cq-viewer', body, { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await raw('GET', '/mcp/cq-viewer', undefined, {})).status, 405);
  assert.equal((await raw('POST', '/mcp/cq-viewer', body, { 'content-type': 'text/plain' })).status, 415);
});

test('requests survive a restart and keep their sequence', async () => {
  const before = await getJson('/viewer/api/requests');
  assert.ok(before.epoch && before.seq >= 4);
  await lifecycle?.dispose();
  const { start } = await import(new URL('../miniapp/node/server.mjs', import.meta.url).href);
  const noop = () => {};
  lifecycle = await start({
    pluginId: 'cq-viewer',
    pluginRoot: PLUGIN_ROOT,
    dataDir: join(home, 'data'),
    listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  });
  const after = await getJson('/viewer/api/requests');
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.seq, before.seq);
  await call('add_model_folder', { path: '~/proj', select: true });
  assert.equal((await getJson('/viewer/api/requests')).seq, before.seq + 1);
  await call('add_model_folder', { path: '~/proj', select: false });
  assert.equal((await getJson('/viewer/api/requests')).seq, before.seq + 1);
});

// ---------------------------------------------------------------- helpers

async function call(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert.ok(reply.result, JSON.stringify(reply));
  return reply.result.structuredContent;
}

async function rpc(method, params) {
  const res = await post({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) });
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text);
}

function post(payload) {
  return raw('POST', '/mcp/cq-viewer', JSON.stringify(payload), {});
}

async function getJson(path) {
  const res = await fetchRaw(path);
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text);
}

function fetchRaw(path) {
  return raw('GET', path, undefined, {});
}

/** @returns {Promise<{status: number, text: string}>} */
function raw(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(p));
    });
  });
}
