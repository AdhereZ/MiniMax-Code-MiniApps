// Run: node --test plugins/hanzijie/cq-viewer/tests/*.test.mjs
// Concurrency of writes to ~/.cqview, child-process cleanup on dispose, and the Host/Origin guard.
// Starts the real Node entry against a throw-away HOME; STEP conversion uses a fake "python".

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const unix = process.platform !== 'win32';

let home = '';
let fakeLog = '';
/** @type {{port: number, lifecycle: {dispose(): Promise<void>|void}}[]} */
const running = [];

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'cqv-home-')));
  process.env.HOME = home; // read by os.homedir() when server.mjs loads
  process.env.USERPROFILE = home;
  await mkdir(join(home, 'proj'), { recursive: true });
  await writeFile(join(home, 'proj', 'part.step'), 'ISO-10303-21;\n');
  await writeFile(join(home, 'proj', 'crash.step'), 'ISO-10303-21;\n');
  await writeFile(join(home, 'proj', 'segv.step'), 'ISO-10303-21;\n');
  for (let i = 0; i < 8; i++) await mkdir(join(home, `folder${i}`), { recursive: true });
  if (unix) {
    // Fake python: the probe succeeds; step_mesh.py logs its pid and hangs (or kills itself for
    // crash.step); the inline STL fallback only logs that it ran.
    fakeLog = join(home, 'fake-python.log');
    const fake = join(home, 'fake-python');
    await writeFile(
      fake,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  -c)',
        '    if [ "$2" = "import cadquery" ]; then exit 0; fi',
        '    echo "fallback" >> "$CQV_FAKE_LOG"; exit 0 ;;',
        '  *step_mesh.py)',
        '    echo "mesh $$" >> "$CQV_FAKE_LOG"',
        '    case "$2" in *crash.step) kill -9 $$ ;; *segv.step) kill -SEGV $$ ;; esac',
        '    exec sleep 30 ;;',
        'esac',
        'exit 9',
        '',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    process.env.CQVIEW_PYTHON = fake;
    process.env.CQV_FAKE_LOG = fakeLog;
  }
});

after(async () => {
  for (const r of running) await r.lifecycle.dispose();
  await rm(home, { recursive: true, force: true });
});

test('40 concurrent selection saves all succeed and leave valid JSON', async () => {
  const { port } = await boot();
  const replies = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      raw(port, 'POST', '/viewer/api/selection', JSON.stringify({ points: [{ x: i, y: 0, z: 0 }] })),
    ),
  );
  assert.deepEqual(
    replies.map((r) => r.status).filter((s) => s !== 200),
    [],
  );
  const doc = JSON.parse(await readFile(join(home, '.cqview', 'selection.json'), 'utf8'));
  assert.equal(doc.count, 1);
});

test('8 concurrent folder registrations all succeed and all land in roots.json', async () => {
  const { port } = await boot();
  const replies = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      raw(port, 'POST', '/viewer/api/roots', JSON.stringify({ path: join(home, `folder${i}`) })),
    ),
  );
  assert.deepEqual(
    replies.map((r) => r.status),
    Array(8).fill(200),
  );
  const { roots } = JSON.parse(await readFile(join(home, '.cqview', 'roots.json'), 'utf8'));
  for (let i = 0; i < 8; i++) assert.ok(roots.some((r) => r.path === join(home, `folder${i}`)), `folder${i} kept`);
});

test('page and MCP registering at the same time keep every folder', async () => {
  const { port } = await boot();
  await rm(join(home, '.cqview', 'roots.json'), { force: true });
  const jobs = [];
  for (let i = 0; i < 8; i++) {
    const path = join(home, `folder${i}`);
    jobs.push(
      i % 2
        ? raw(port, 'POST', '/viewer/api/roots', JSON.stringify({ path }))
        : raw(
            port,
            'POST',
            '/mcp/cq-viewer',
            JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'add_model_folder', arguments: { path, select: false } } }),
          ),
    );
  }
  const replies = await Promise.all(jobs);
  assert.deepEqual(
    replies.map((r) => r.status),
    Array(8).fill(200),
  );
  const { roots } = JSON.parse(await readFile(join(home, '.cqview', 'roots.json'), 'utf8'));
  assert.equal(roots.length, 8);
});

test('dispose during a STEP conversion kills Python and starts no fallback', { skip: !unix && 'needs a POSIX shell' }, async () => {
  await writeFile(fakeLog, '');
  const { port, lifecycle } = await boot();
  const rootId = await register(port, join(home, 'proj'));
  const pending = raw(port, 'GET', `/viewer/api/file?root=${rootId}&rel=part.step`).catch(() => null);
  const pid = await waitForMeshPid();
  await lifecycle.dispose();
  await sleep(1500);
  const log = await readFile(fakeLog, 'utf8');
  assert.ok(!log.includes('fallback'), `no fallback after dispose; log:\n${log}`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'step_mesh.py was killed');
  await pending;
});

test('a conversion killed by a signal fails without starting the fallback', { skip: !unix && 'needs a POSIX shell' }, async () => {
  await writeFile(fakeLog, '');
  const { port } = await boot();
  const rootId = await register(port, join(home, 'proj'));
  const res = await raw(port, 'GET', `/viewer/api/file?root=${rootId}&rel=crash.step`);
  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.text).error, 'step_convert_failed');
  const log = await readFile(fakeLog, 'utf8');
  assert.ok(log.includes('mesh'), 'step_mesh.py ran');
  assert.ok(!log.includes('fallback'), `no fallback after a signal; log:\n${log}`);
});

test('a native crash of step_mesh.py (SIGSEGV) still tries the simpler fallback', { skip: !unix && 'needs a POSIX shell' }, async () => {
  await writeFile(fakeLog, '');
  const { port } = await boot();
  const rootId = await register(port, join(home, 'proj'));
  const res = await raw(port, 'GET', `/viewer/api/file?root=${rootId}&rel=segv.step`);
  assert.equal(res.status, 422); // the fake fallback writes no mesh
  assert.ok((await readFile(fakeLog, 'utf8')).includes('fallback'));
});

test('step-cache pruning removes stale entries and leftovers, nothing else', { skip: !unix && 'needs a POSIX shell' }, async () => {
  const dataDir = await mkdtemp(join(home, 'data-'));
  const cache = join(dataDir, 'step-cache');
  await mkdir(cache, { recursive: true });
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const files = {
    stale: `${'a'.repeat(40)}.cqvm`,
    fresh: `${'b'.repeat(40)}.stl`,
    leftover: `${'c'.repeat(40)}.cqvm.123.tmp`,
    other: 'notes.txt',
  };
  for (const name of Object.values(files)) await writeFile(join(cache, name), 'x');
  for (const name of [files.stale, files.leftover, files.other]) await utimes(join(cache, name), old, old);
  const { port } = await boot(dataDir);
  const rootId = await register(port, join(home, 'proj'));
  await raw(port, 'GET', `/viewer/api/file?root=${rootId}&rel=crash.step`); // first conversion triggers pruning
  await sleep(300);
  const left = await readdir(cache);
  assert.ok(!left.includes(files.stale), 'stale entry removed');
  assert.ok(!left.includes(files.leftover), 'old temp file removed');
  assert.ok(left.includes(files.fresh), 'recent entry kept');
  assert.ok(left.includes(files.other), 'unknown files untouched');
});

test('the version in plugin.json, the MCP server info, and the page bridge agree', async () => {
  const { version } = JSON.parse(await readFile(join(PLUGIN_ROOT, '.minimax-plugin', 'plugin.json'), 'utf8'));
  const mcp = await readFile(join(PLUGIN_ROOT, 'miniapp', 'node', 'mcp.mjs'), 'utf8');
  const bridge = await readFile(join(PLUGIN_ROOT, 'miniapp', 'client', 'assets', 'host-bridge.js'), 'utf8');
  assert.match(mcp, new RegExp(`SERVER_INFO = \\{ name: 'cq-viewer', version: '${version.replace(/\./g, '\\.')}' \\}`));
  assert.match(bridge, new RegExp(`APP_INFO = \\{ name: 'cq-viewer', version: '${version.replace(/\./g, '\\.')}' \\}`));
});

test('non-loopback Host or cross-origin requests are refused on every route', async () => {
  const { port } = await boot();
  const body = JSON.stringify({ path: join(home, 'proj') });
  const evilHost = await raw(port, 'POST', '/viewer/api/roots', body, { host: 'evil.example' });
  assert.equal(evilHost.status, 403);
  const evilOrigin = await raw(port, 'POST', '/viewer/api/roots', body, { origin: 'https://evil.example' });
  assert.equal(evilOrigin.status, 403);
  const page = await raw(port, 'GET', '/viewer', undefined, { host: 'evil.example' });
  assert.equal(page.status, 403);
  const file = await raw(port, 'GET', '/viewer/api/roots', undefined, { host: `evil.example:${port}` });
  assert.equal(file.status, 403);
  // the page itself: loopback Host, same-origin Origin
  const own = await raw(port, 'POST', '/viewer/api/roots', body, { origin: `http://127.0.0.1:${port}` });
  assert.equal(own.status, 200);
  const localhost = await raw(port, 'GET', '/viewer', undefined, { host: `localhost:${port}` });
  assert.equal(localhost.status, 200);
});

// ---------------------------------------------------------------- helpers

async function boot(dataDir) {
  const port = await freePort();
  const { start } = await import(new URL('../miniapp/node/server.mjs', import.meta.url).href);
  const noop = () => {};
  const lifecycle = await start({
    pluginId: 'cq-viewer',
    pluginRoot: PLUGIN_ROOT,
    dataDir: dataDir ?? (await mkdtemp(join(home, 'data-'))),
    listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  });
  const entry = { port, lifecycle };
  running.push(entry);
  return entry;
}

async function register(port, path) {
  const res = await raw(port, 'POST', '/viewer/api/roots', JSON.stringify({ path }));
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text).root.id;
}

async function waitForMeshPid() {
  for (let t = 0; t < 10_000; t += 50) {
    const m = /mesh (\d+)/.exec(await readFile(fakeLog, 'utf8').catch(() => ''));
    if (m) return Number(m[1]);
    await sleep(50);
  }
  throw new Error('step_mesh.py never started');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<{status: number, text: string}>} */
function raw(port, method, path, body, headers = {}) {
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
