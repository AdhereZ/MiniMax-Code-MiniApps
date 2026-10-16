import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPackageName, validatePackage } from '../scripts/lib/package.mjs';
import { hasErrors } from '../scripts/lib/report.mjs';
import { codes, copyExample, editJson, makeTmpRoot } from './helpers.mjs';

test('package: the example is a clean baseline', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  assert.deepEqual(await validatePackage(dir), []);
  assert.equal(await readPackageName(dir), 'hello-miniapp');
});

test('package: a UTF-8 BOM in plugin.json is reported by name', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  const file = path.join(dir, '.minimax-plugin', 'plugin.json');
  await writeFile(file, `\uFEFF${await readFile(file, 'utf8')}`);
  const diagnostics = await validatePackage(dir);
  assert.deepEqual(codes(diagnostics), ['MANIFEST_UNREADABLE']);
  assert.match(diagnostics[0].message, /UTF-8 BOM/u);
});

test('package: directory renamed away from the manifest name', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root, { dirName: 'renamed' });
  assert.deepEqual(codes(await validatePackage(dir)), ['LAYOUT_NAME_MISMATCH']);
});

test('package: a missing miniapp.json is reported once by layout, not twice', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  await rm(path.join(dir, 'miniapp', 'miniapp.json'));
  assert.deepEqual(codes(await validatePackage(dir)), ['LAYOUT_FILE_MISSING']);
});

test('package: warnings alone do not make hasErrors true', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  await mkdir(path.join(dir, 'miniapp', 'node', 'vendor'));
  await writeFile(path.join(dir, 'miniapp', 'node', 'vendor', 'lib.mjs'), "console.log('vendored');\n");
  const diagnostics = await validatePackage(dir);
  assert.deepEqual(codes(diagnostics), ['ENTRY_STDOUT']);
  assert.equal(hasErrors(diagnostics), false);
});

test('package: an example is not subject to the lowercase-author rule', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root, { author: 'Examples' });
  assert.deepEqual(await validatePackage(dir, { requireLowercaseAuthor: false }), []);
});

test('package: features from plugin.json and miniapp.json reach the README minimum-version check', async () => {
  const root = await makeTmpRoot();
  const { dir } = await copyExample(root);
  await editJson(path.join(dir, 'miniapp', 'miniapp.json'), (m) => ({ ...m, agentAccess: ['session.run'] }));
  await editJson(path.join(dir, '.minimax-plugin', 'plugin.json'), (m) => ({ ...m, agents: ['agents/helper.md'] }));
  await mkdir(path.join(dir, 'agents'));
  await writeFile(path.join(dir, 'agents', 'helper.md'), '# helper\n');
  const diagnostics = await validatePackage(dir);
  assert.deepEqual(codes(diagnostics), ['README_MIN_VERSION_MISSING']);
  assert.match(diagnostics[0].message, /agents, agentAccess/u);
  const readme = path.join(dir, 'README.md');
  await writeFile(readme, (await readFile(readme, 'utf8')).replace('MiniMax Code 3.0.73', 'MiniMax Code 3.1.2'));
  assert.deepEqual(await validatePackage(dir), []);
});
