import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkNode } from '../scripts/lib/rules/node.mjs';
import { createReport } from '../scripts/lib/report.mjs';
import { codes, copyExample, makeTmpRoot } from './helpers.mjs';

const ENTRY = 'miniapp/node/server.mjs';

async function run(prepare, { entry = ENTRY, nodeRoots = ['miniapp/node'] } = {}) {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  await prepare?.(dir);
  const report = createReport();
  await checkNode(report, { packageDir: dir, entry, nodeRoots });
  return report.diagnostics;
}

test('node: baseline passes', async () => {
  assert.deepEqual(await run(), []);
});

test('node: stdout calls in the entry are errors, in other files warnings', async () => {
  const entryHit = await run((dir) => appendFile(path.join(dir, ENTRY), "\nconsole.info('x');\n"));
  assert.deepEqual(codes(entryHit), ['ENTRY_STDOUT']);
  assert.equal(entryHit[0].level, 'error');
  const vendorHit = await run(async (dir) => {
    await mkdir(path.join(dir, 'miniapp', 'node', 'vendor'));
    await writeFile(path.join(dir, 'miniapp', 'node', 'vendor', 'x.mjs'), "export const v = 1;\nconsole.log('x');\n");
  });
  assert.deepEqual(codes(vendorHit), ['ENTRY_STDOUT']);
  assert.equal(vendorHit[0].level, 'warning');
});

test('node: entry must export start with ESM syntax', async () => {
  const diagnostics = await run(async (dir) => {
    const file = path.join(dir, ENTRY);
    await writeFile(file, (await readFile(file, 'utf8')).replace('export async function start', 'async function start'));
  });
  assert.deepEqual(codes(diagnostics), ['ENTRY_START_EXPORT_MISSING']);
});

test('node: a syntax error in an .mjs file is an error', async () => {
  const diagnostics = await run((dir) => appendFile(path.join(dir, ENTRY), '\nthis is not javascript\n'));
  assert.deepEqual(codes(diagnostics), ['ENTRY_SYNTAX']);
});

test('node: .js files skip the syntax check and rely on the pattern checks only', async () => {
  const diagnostics = await run(async (dir) => {
    await writeFile(path.join(dir, 'miniapp', 'node', 'helper.js'), 'module.exports = { broken: ( };\n');
  });
  assert.deepEqual(diagnostics, []);
});

test('node: https, http2, net, and tls servers are warnings because the loopback guard covers only node:http', async () => {
  const sources = [
    ['a.mjs', "import https from 'node:https';\nexport const s = https.createServer({});\n"],
    ['b.mjs', "import http2 from 'node:http2';\nexport const s = http2.createSecureServer({});\n"],
    ['c.mjs', "import * as net from 'net';\nexport const s = net.createServer();\n"],
    ['d.mjs', "import { createServer } from 'node:tls';\nexport const s = createServer({});\n"],
    ['e.cjs', "const { createServer: make } = require('node:https');\nmodule.exports = make({});\n"],
  ];
  for (const [file, source] of sources) {
    const diagnostics = await run((dir) => writeFile(path.join(dir, 'miniapp', 'node', file), source));
    assert.deepEqual(codes(diagnostics), ['NODE_UNGUARDED_SERVER'], source);
    assert.equal(diagnostics[0].level, 'warning');
  }
});

test('node: outbound https requests and node:http servers are not flagged', async () => {
  const diagnostics = await run((dir) =>
    writeFile(
      path.join(dir, 'miniapp', 'node', 'client.mjs'),
      "import https from 'node:https';\nimport { createServer } from 'node:http';\nexport const get = (u) => https.get(u);\nexport const s = createServer();\n",
    ),
  );
  assert.deepEqual(diagnostics, []);
});

test('node: handling a /__mavis/ route is a warning', async () => {
  const diagnostics = await run((dir) => appendFile(path.join(dir, ENTRY), "\nexport const reserved = '/__mavis/status';\n"));
  assert.deepEqual(codes(diagnostics), ['NODE_RESERVED_ROUTE']);
  assert.equal(diagnostics[0].level, 'warning');
});
