// MiniMax Pet — dev-only smoke test for the Node service. Run: node dev/smoke-api.mjs

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { start } = await import(resolve(packageRoot, 'miniapp/node/server.mjs'));
const { readImageHeader, atlasVersionFromSize } = await import(resolve(packageRoot, 'miniapp/node/image-header.mjs'));

const SHINCHAN = 'shinchan--chenxin-dlut';
const BUTTERCUP = 'buttercup--legeling';
const petsRoot = join(packageRoot, 'miniapp/client/pets');

const results = [];
const notes = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function boot(dataDir, pluginRoot = packageRoot) {
  const port = await freePort();
  const controller = new AbortController();
  const lifecycle = await start({
    pluginId: 'minimax-pet',
    pluginRoot,
    dataDir,
    listen: { host: '127.0.0.1', port },
    signal: controller.signal,
    logger: silentLogger,
  });
  return { port, controller, lifecycle };
}

/** Raw HTTP request; path is sent verbatim (no client-side normalization). */
function call(port, method, path, { headers = {}, body, chunks } = {}) {
  return new Promise((resolveCall, reject) => {
    let settled = false;
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        settled = true;
        const buf = Buffer.concat(parts);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {}
        resolveCall({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (chunks) {
      let i = 0;
      const pump = () => {
        while (i < chunks.length) {
          if (req.destroyed) return;
          const ok = req.write(chunks[i++]);
          if (!ok) return void req.once('drain', pump);
        }
        req.end();
      };
      pump();
    } else {
      req.end(body);
    }
  });
}

const jsonHeaders = { 'content-type': 'application/json' };
function postPet(port, payload, raw) {
  const body = raw ?? JSON.stringify(payload);
  return call(port, 'POST', '/api/pets', {
    headers: { ...jsonHeaders, 'content-length': Buffer.byteLength(body) },
    body,
  });
}

function patchPreferences(port, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return call(port, 'PATCH', '/api/preferences', { headers: { ...jsonHeaders, ...headers }, body });
}

function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

function webpVp8xHeader(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBPVP8X', 8, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

function webpVp8Header(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBPVP8 ', 8, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x10; // keyframe
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

async function stagingLeftovers(dataDir) {
  try {
    return await readdir(join(dataDir, '.staging'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------

const shinchanSprite = await readFile(join(petsRoot, SHINCHAN, 'spritesheet.webp'));
const shinchanJson = JSON.parse(await readFile(join(petsRoot, SHINCHAN, 'pet.json'), 'utf8'));
const buttercupSprite = await readFile(join(petsRoot, BUTTERCUP, 'spritesheet.webp'));

await test('image-header: bundled shinchan webp is 1536x1872 (v1)', () => {
  const info = readImageHeader(shinchanSprite);
  notes.push(`shinchan header: ${JSON.stringify(info)}`);
  assert.deepEqual([info.format, info.width, info.height], ['webp', 1536, 1872]);
  assert.equal(atlasVersionFromSize(info.width, info.height), 1);
});
await test('image-header: bundled buttercup webp is 1536x2288 (v2)', () => {
  const info = readImageHeader(buttercupSprite);
  notes.push(`buttercup header: ${JSON.stringify(info)}`);
  assert.deepEqual([info.format, info.width, info.height], ['webp', 1536, 2288]);
  assert.equal(atlasVersionFromSize(info.width, info.height), 2);
});
await test('image-header: synthetic PNG / VP8X / VP8 / garbage', () => {
  assert.deepEqual(readImageHeader(pngHeader(1536, 2288)), { format: 'png', width: 1536, height: 2288 });
  assert.deepEqual(readImageHeader(pngHeader(100, 100)), { format: 'png', width: 100, height: 100 });
  const x = readImageHeader(webpVp8xHeader(1536, 1872));
  assert.deepEqual([x.format, x.variant, x.width, x.height], ['webp', 'VP8X', 1536, 1872]);
  const v = readImageHeader(webpVp8Header(1536, 2288));
  assert.deepEqual([v.format, v.variant, v.width, v.height], ['webp', 'VP8', 1536, 2288]);
  assert.equal(readImageHeader(Buffer.from('GIF89a........................')), null);
  assert.equal(readImageHeader(pngHeader(1, 1).subarray(0, 20)), null);
});

const dataDir = await mkdtemp(join(tmpdir(), 'minimax-pet-smoke-'));
const { port, lifecycle } = await boot(dataDir);

try {
  await test('GET preferences defaults are explicit and no-store', async () => {
    const r = await call(port, 'GET', '/api/preferences');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.json, { preferences: { petId: null, scale: 0.75, autoCycle: false, windowPosition: null }, persisted: false });
  });

  await test('PATCH preferences persists only supported values, merges concurrent patches', async () => {
    const responses = await Promise.all([patchPreferences(port, { petId: SHINCHAN }), patchPreferences(port, { scale: 0.5 }), patchPreferences(port, { autoCycle: true })]);
    for (const r of responses) { assert.equal(r.status, 200); assert.equal(r.json.persisted, true); }
    assert.deepEqual((await call(port, 'GET', '/api/preferences')).json.preferences, { petId: SHINCHAN, scale: 0.5, autoCycle: true, windowPosition: null });
  });

  await test('invalid preferences fail without modifying persisted preferences', async () => {
    const before = await readFile(join(dataDir, 'preferences.json'), 'utf8');
    for (const payload of [null, [], {}, { scale: 2 }, { petId: '../bad' }, { autoCycle: 1 }, { sessionId: 'private' }]) {
      const r = await patchPreferences(port, payload);
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'invalid_preferences');
    }
    assert.equal(await readFile(join(dataDir, 'preferences.json'), 'utf8'), before);
  });

  await test('conditional migration cannot overwrite existing stable preferences', async () => {
    const r = await patchPreferences(port, { petId: 'stale-localstorage' }, { 'if-none-match': '*' });
    assert.equal(r.status, 412);
    assert.equal(r.json.error, 'preferences_exists');
    assert.equal((await call(port, 'GET', '/api/preferences')).json.preferences.petId, SHINCHAN);
  });

  await test('preferences reject wrong methods, media type, oversized bodies and cross-origin writes', async () => {
    assert.equal((await call(port, 'POST', '/api/preferences')).status, 405);
    assert.equal((await call(port, 'PATCH', '/api/preferences', { body: '{}' })).status, 415);
    assert.equal((await call(port, 'PATCH', '/api/preferences', { headers: jsonHeaders, body: 'x'.repeat(16 * 1024 + 1) })).status, 413);
    const foreign = await patchPreferences(port, { scale: 1 }, { origin: 'https://unrelated.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error, 'origin_not_allowed');
    assert.equal((await patchPreferences(port, { scale: 0.5 }, { origin: `http://127.0.0.1:${port}` })).status, 200);
  });

  await test('GET /pet → 200 html or 503 client_missing', async () => {
    const r = await call(port, 'GET', '/pet');
    let hasIndex = true;
    await access(join(packageRoot, 'miniapp/client/index.html')).catch(() => (hasIndex = false));
    if (hasIndex) {
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^text\/html/);
      notes.push('GET /pet: index.html present → 200 text/html');
    } else {
      assert.equal(r.status, 503);
      assert.equal(r.json.error, 'client_missing');
      notes.push('GET /pet: index.html missing → 503 client_missing');
    }
  });

  await test('POST /pet → 405', async () => {
    const r = await call(port, 'POST', '/pet');
    assert.equal(r.status, 405);
  });

  await test('GET bundled pet.json via /assets → 200 application/json, no-cache', async () => {
    const r = await call(port, 'GET', `/assets/pets/${SHINCHAN}/pet.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.json.id, SHINCHAN);
  });

  await test('production activity, preferences and draft modules are served as JavaScript', async () => {
    for (const name of ['activity.mjs', 'preferences.mjs', 'chat-draft.mjs', 'window-position.mjs', 'speech-input.mjs', 'pet-presentation.mjs', 'activity-reminders.mjs', 'compact-pet-view.mjs', 'notification-previews.mjs', 'ask-observer.mjs', 'workbench-window.mjs']) {
      const r = await call(port, 'GET', `/assets/${name}`);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^text\/javascript/);
      assert.ok(r.body.length > 0);
    }
  });

  await test('GET bundled spritesheet via /assets → 200 image/webp', async () => {
    const r = await call(port, 'GET', `/assets/pets/${BUTTERCUP}/spritesheet.webp`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(r.body.length, buttercupSprite.length);
  });

  for (const path of [
    '/assets/../node/server.mjs',
    '/assets/%2e%2e/node/server.mjs',
    '/assets/..%2fnode%2fserver.mjs',
    '/assets/pets\\..\\..\\node\\server.mjs',
    '/assets/pets/%2e%2e/%2e%2e/node/server.mjs',
    '/assets/./pets/' + SHINCHAN + '/pet.json',
    '/assets/pets/%00/pet.json',
    '/assets/pets/%E0%A4%A/pet.json',
    '/assets/pets/' + SHINCHAN + '/spritesheet.txt',
    '/assets/pets',
  ]) {
    await test(`traversal/invalid ${JSON.stringify(path)} → not 200`, async () => {
      const r = await call(port, 'GET', path);
      assert.notEqual(r.status, 200);
      assert.ok(!r.body.toString('utf8').includes('createServer'));
    });
  }

  await test('GET /api/pets lists bundled pets v1 & v2 with petJsonUrl, no-store', async () => {
    const r = await call(port, 'GET', '/api/pets');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const pets = r.json.pets;
    assert.deepEqual(
      pets.map((p) => [p.id, p.version, p.source, p.petJsonUrl]),
      [
        [BUTTERCUP, 2, 'bundled', `/assets/pets/${BUTTERCUP}/pet.json`],
        [SHINCHAN, 1, 'bundled', `/assets/pets/${SHINCHAN}/pet.json`],
      ],
    );
    assert.equal(typeof pets[0].displayName, 'string');
    assert.equal(typeof pets[0].description, 'string');
  });

  await test('PUT /api/pets → 405', async () => {
    assert.equal((await call(port, 'PUT', '/api/pets')).status, 405);
  });

  const copyJson = { ...shinchanJson, id: 'shinchan-copy', displayName: 'Shin-chan copy' };
  const copyPayload = {
    petJson: copyJson,
    spritesheet: { fileName: 'spritesheet.webp', base64: shinchanSprite.toString('base64') },
  };

  await test('import shinchan-copy → 201', async () => {
    const r = await postPet(port, copyPayload);
    assert.equal(r.status, 201, r.body.toString());
    assert.deepEqual(r.json.pet, {
      id: 'shinchan-copy',
      displayName: 'Shin-chan copy',
      description: shinchanJson.description,
      version: 1,
      source: 'imported',
      petJsonUrl: '/imported/shinchan-copy/pet.json',
    });
  });

  await test('listing contains imported shinchan-copy after bundled', async () => {
    const r = await call(port, 'GET', '/api/pets');
    const ids = r.json.pets.map((p) => `${p.source}:${p.id}`);
    assert.deepEqual(ids, [`bundled:${BUTTERCUP}`, `bundled:${SHINCHAN}`, 'imported:shinchan-copy']);
  });

  await test('/imported/shinchan-copy/pet.json → 200 normalized subset', async () => {
    const r = await call(port, 'GET', '/imported/shinchan-copy/pet.json');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(r.json, {
      id: 'shinchan-copy',
      displayName: 'Shin-chan copy',
      description: shinchanJson.description,
      spritesheetPath: 'spritesheet.webp',
    });
  });

  await test('/imported/shinchan-copy/spritesheet.webp → 200 image/webp', async () => {
    const r = await call(port, 'GET', '/imported/shinchan-copy/spritesheet.webp');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.ok(r.body.equals(shinchanSprite));
  });

  await test('/imported/shinchan-copy/other.txt → 404 JSON', async () => {
    await writeFile(join(dataDir, 'pets/shinchan-copy/other.txt'), 'nope');
    const r = await call(port, 'GET', '/imported/shinchan-copy/other.txt');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
  });

  await test('/imported traversal → not 200', async () => {
    for (const p of ['/imported/shinchan-copy/..%2f..%2fpets', '/imported/../pets/x', '/imported/shinchan-copy']) {
      assert.notEqual((await call(port, 'GET', p)).status, 200, p);
    }
  });

  await test('re-import same id → 409 pet_exists', async () => {
    const r = await postPet(port, copyPayload);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'pet_exists');
  });

  await test('re-import with replace:true → 201 and content replaced', async () => {
    const r = await postPet(port, {
      ...copyPayload,
      petJson: { ...copyJson, displayName: 'Replaced' },
      replace: true,
    });
    assert.equal(r.status, 201, r.body.toString());
    const j = await call(port, 'GET', '/imported/shinchan-copy/pet.json');
    assert.equal(j.json.displayName, 'Replaced');
    const leftover = await call(port, 'GET', '/imported/shinchan-copy/other.txt');
    assert.equal(leftover.status, 404);
  });

  await test('import v2 buttercup copy → 201 stores spriteVersionNumber 2', async () => {
    const r = await postPet(port, {
      petJson: { id: 'bc2', displayName: 'BC', spriteVersionNumber: 2, spritesheetPath: 'atlas.webp' },
      spritesheet: { fileName: 'atlas.webp', base64: buttercupSprite.toString('base64') },
    });
    assert.equal(r.status, 201, r.body.toString());
    assert.equal(r.json.pet.version, 2);
    const j = await call(port, 'GET', '/imported/bc2/pet.json');
    assert.deepEqual(j.json, {
      id: 'bc2',
      displayName: 'BC',
      description: '',
      spritesheetPath: 'atlas.webp',
      spriteVersionNumber: 2,
    });
  });

  const errorCases = [
    ['bundled id → 409 bundled_conflict', 409, 'bundled_conflict', { ...copyPayload, petJson: shinchanJson }],
    [
      'synthetic 100x100 PNG → 400 sprite_size_invalid',
      400,
      'sprite_size_invalid',
      {
        petJson: { id: 'tiny', displayName: 'Tiny', spritesheetPath: 'a.png' },
        spritesheet: { fileName: 'a.png', base64: pngHeader(100, 100).toString('base64') },
      },
    ],
    [
      'v1 image with spriteVersionNumber 2 → 400 sprite_version_mismatch',
      400,
      'sprite_version_mismatch',
      { ...copyPayload, petJson: { ...copyJson, id: 'mismatch', spriteVersionNumber: 2 } },
    ],
    [
      'webp bytes with .png name → 400 sprite_format_invalid',
      400,
      'sprite_format_invalid',
      {
        petJson: { ...copyJson, id: 'wrongext', spritesheetPath: 'a.png' },
        spritesheet: { fileName: 'a.png', base64: shinchanSprite.toString('base64') },
      },
    ],
    [
      'non-image bytes → 400 sprite_format_invalid',
      400,
      'sprite_format_invalid',
      {
        petJson: { ...copyJson, id: 'garbage' },
        spritesheet: { fileName: 'spritesheet.webp', base64: Buffer.from('hello world!').toString('base64') },
      },
    ],
    [
      'invalid base64 → 400 sprite_format_invalid',
      400,
      'sprite_format_invalid',
      { ...copyPayload, petJson: { ...copyJson, id: 'badb64' }, spritesheet: { fileName: 'spritesheet.webp', base64: 'UklG*RiI=' } },
    ],
    [
      'fileName ≠ spritesheetPath → 400 invalid_sprite_name',
      400,
      'invalid_sprite_name',
      { ...copyPayload, petJson: { ...copyJson, id: 'namediff' }, spritesheet: { ...copyPayload.spritesheet, fileName: 'other.webp' } },
    ],
    [
      'spritesheetPath with directory → 400 invalid_sprite_name',
      400,
      'invalid_sprite_name',
      {
        petJson: { ...copyJson, id: 'withdir', spritesheetPath: 'sprites/spritesheet.webp' },
        spritesheet: { ...copyPayload.spritesheet, fileName: 'sprites/spritesheet.webp' },
      },
    ],
    [
      'spritesheetPath ../x.webp → 400 invalid_sprite_name',
      400,
      'invalid_sprite_name',
      {
        petJson: { ...copyJson, id: 'dotdot', spritesheetPath: '../x.webp' },
        spritesheet: { ...copyPayload.spritesheet, fileName: '../x.webp' },
      },
    ],
    ['bad id → 400 invalid_id', 400, 'invalid_id', { ...copyPayload, petJson: { ...copyJson, id: 'Bad/ID' } }],
    ['id starting with dot → 400 invalid_id', 400, 'invalid_id', { ...copyPayload, petJson: { ...copyJson, id: '.staging' } }],
    [
      'displayName too long → 400 invalid_pet_json',
      400,
      'invalid_pet_json',
      { ...copyPayload, petJson: { ...copyJson, id: 'longname', displayName: 'x'.repeat(81) } },
    ],
    [
      'description too long → 400 invalid_pet_json',
      400,
      'invalid_pet_json',
      { ...copyPayload, petJson: { ...copyJson, id: 'longdesc', description: 'x'.repeat(301) } },
    ],
    [
      'spriteVersionNumber 3 → 400 invalid_pet_json',
      400,
      'invalid_pet_json',
      { ...copyPayload, petJson: { ...copyJson, id: 'v3', spriteVersionNumber: 3 } },
    ],
    ['petJson not object → 400 invalid_pet_json', 400, 'invalid_pet_json', { ...copyPayload, petJson: 'nope' }],
    ['spritesheet missing → 400 invalid_json', 400, 'invalid_json', { petJson: { ...copyJson, id: 'nosprite' } }],
  ];
  for (const [name, status, code, payload] of errorCases) {
    await test(name, async () => {
      const r = await postPet(port, payload);
      assert.equal(r.status, status, r.body.toString().slice(0, 200));
      assert.equal(r.json.error, code);
      assert.equal(typeof r.json.message, 'string');
    });
  }

  await test('malformed JSON → 400 invalid_json', async () => {
    const r = await postPet(port, null, '{"petJson": ');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_json');
  });

  await test('wrong content-type → 415', async () => {
    const r = await call(port, 'POST', '/api/pets', { headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
  });

  await test('> 12 MB body with content-length → 413 payload_too_large', async () => {
    const big = Buffer.alloc(13 * 1024 * 1024, 0x20);
    const r = await call(port, 'POST', '/api/pets', {
      headers: { ...jsonHeaders, 'content-length': big.length },
      body: big,
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.error, 'payload_too_large');
  });

  await test('> 12 MB chunked body (no content-length) → 413 payload_too_large', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const r = await call(port, 'POST', '/api/pets', {
      headers: { ...jsonHeaders },
      chunks: Array.from({ length: 13 }, () => chunk),
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.error, 'payload_too_large');
  });

  await test('server still healthy after 413', async () => {
    assert.equal((await call(port, 'GET', '/api/pets')).status, 200);
  });

  await test('DELETE bundled → 403 bundled_read_only', async () => {
    const r = await call(port, 'DELETE', `/api/pets/${SHINCHAN}`);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'bundled_read_only');
  });

  await test('DELETE unknown → 404, bad id → 400 invalid_id', async () => {
    assert.equal((await call(port, 'DELETE', '/api/pets/does-not-exist')).status, 404);
    const bad = await call(port, 'DELETE', '/api/pets/BAD');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_id');
  });

  await test('GET /api/pets/<id> → 405', async () => {
    assert.equal((await call(port, 'GET', '/api/pets/shinchan-copy')).status, 405);
  });

  await test('DELETE imported → 204, then GET 404 and not listed', async () => {
    const d = await call(port, 'DELETE', '/api/pets/shinchan-copy');
    assert.equal(d.status, 204);
    assert.equal((await call(port, 'GET', '/imported/shinchan-copy/pet.json')).status, 404);
    const list = await call(port, 'GET', '/api/pets');
    assert.ok(!list.json.pets.some((p) => p.id === 'shinchan-copy'));
  });

  await test('concurrent imports of same id: exactly one 201, rest 409', async () => {
    const payload = { ...copyPayload, petJson: { ...copyJson, id: 'race' } };
    const rs = await Promise.all(Array.from({ length: 4 }, () => postPet(port, payload)));
    const statuses = rs.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409]);
  });

  await test('no leftover staging dirs in dataDir', async () => {
    assert.deepEqual(await stagingLeftovers(dataDir), []);
    const petDirs = (await readdir(join(dataDir, 'pets'))).sort();
    assert.deepEqual(petDirs, ['bc2', 'race']);
  });

  await test('/unknown-route-for-smoke not handled by plugin → 404', async () => {
    const r = await call(port, 'GET', '/unknown-route-for-smoke');
    assert.equal(r.status, 404);
  });

  await test('unknown route → 404 JSON', async () => {
    const r = await call(port, 'GET', '/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
  });
} finally {
  await lifecycle.dispose();
}

const restarted = await boot(dataDir);
try {
  await test('preferences survive a fresh listener at another loopback origin', async () => {
    assert.notEqual(restarted.port, port);
    const r = await call(restarted.port, 'GET', '/api/preferences');
    assert.equal(r.status, 200);
    assert.equal(r.json.persisted, true);
    assert.deepEqual(r.json.preferences, { petId: SHINCHAN, scale: 0.5, autoCycle: true, windowPosition: null });
  });
} finally { await restarted.lifecycle.dispose(); }

// Fault injection: `pets` is a regular file, so the final rename fails after staging was written.
const faultDir = await mkdtemp(join(tmpdir(), 'minimax-pet-smoke-fault-'));
await writeFile(join(faultDir, 'pets'), 'not a directory');
const fault = await boot(faultDir);
try {
  await test('write failure mid-import → 500 internal_error, no staging leftovers', async () => {
    const r = await postPet(fault.port, {
      petJson: { ...shinchanJson, id: 'faulty' },
      spritesheet: { fileName: 'spritesheet.webp', base64: shinchanSprite.toString('base64') },
    });
    assert.equal(r.status, 500, r.body.toString());
    assert.equal(r.json.error, 'internal_error');
    assert.deepEqual(await stagingLeftovers(faultDir), []);
  });
} finally {
  fault.controller.abort();
  await fault.lifecycle.dispose();
}

// Symlink escape: a fake plugin root whose client dir contains a symlink pointing outside it.
const fakeRoot = await mkdtemp(join(tmpdir(), 'minimax-pet-smoke-root-'));
await mkdir(join(fakeRoot, 'miniapp/client/pets'), { recursive: true });
await writeFile(join(fakeRoot, 'secret.json'), '{"secret":true}');
await writeFile(join(fakeRoot, 'miniapp/client/ok.json'), '{"ok":true}');
await symlink(join(fakeRoot, 'secret.json'), join(fakeRoot, 'miniapp/client/evil.json'));
await symlink(join(fakeRoot, 'miniapp/client/ok.json'), join(fakeRoot, 'miniapp/client/inner.json'));
const fakeData = await mkdtemp(join(tmpdir(), 'minimax-pet-smoke-fakedata-'));
const fake = await boot(fakeData, fakeRoot);
try {
  await test('symlink escaping client root → 404; symlink inside → 200', async () => {
    assert.equal((await call(fake.port, 'GET', '/assets/ok.json')).status, 200);
    assert.equal((await call(fake.port, 'GET', '/assets/inner.json')).status, 200);
    const evil = await call(fake.port, 'GET', '/assets/evil.json');
    assert.equal(evil.status, 404);
    assert.ok(!evil.body.toString().includes('secret'));
  });
} finally {
  await fake.lifecycle.dispose();
}
await rm(fakeRoot, { recursive: true, force: true });
await rm(fakeData, { recursive: true, force: true });

await test('dispose closed the listener', async () => {
  await assert.rejects(call(port, 'GET', '/api/pets'));
});

await rm(dataDir, { recursive: true, force: true });
await rm(faultDir, { recursive: true, force: true });

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error?.message?.split('\n').join('\n      ')}`}`);
}
for (const n of notes) console.log(`note: ${n}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
