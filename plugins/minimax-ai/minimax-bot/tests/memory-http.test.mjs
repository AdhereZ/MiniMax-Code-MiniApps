import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = resolve(process.env.BOT_PLUGIN_ROOT ?? resolve(import.meta.dirname, '..'));
const { start } = await import(pathToFileURL(join(pluginRoot, 'miniapp/node/server.mjs')).href);
const { Store } = await import(pathToFileURL(join(pluginRoot, 'miniapp/node/store.mjs')).href);

function legacyDocument(entries) {
  return Buffer.from(`\uFEFF# Original memory（保留原始字节）\r\n\r\n${entries.map((entry) => {
    const meta = { id: entry.id, source: '用户确认', added: '2024-01-02', by: 'Original Bot' };
    return `- ${entry.text} <!-- meta:${Buffer.from(JSON.stringify(meta)).toString('base64url')} -->`;
  }).join('\r\n')}\r\n`);
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bot-memory-http-'));
  let app;
  t.after(async () => {
    try { await app?.dispose(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const initial = new Store(dataDir);
  await initial.init();
  const botId = initial.state.bots[0].id;
  const oldEntries = Array.from({ length: 12 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(8, '0'),
    text: `旧记忆 ${index} `.padEnd(index === 11 ? 220 : 300, '记'),
  }));
  assert.equal(oldEntries.reduce((size, entry) => size + entry.text.length + 40, 0), 4000);
  const botEntries = [{ id: 'abcdef01', text: 'An original personal preference stays intact.' }];
  const memoryDir = join(dataDir, 'memory');
  const pathFor = (scope) => scope === 'team' ? join(memoryDir, 'team.md') : join(memoryDir, 'bots', `${scope}.md`);
  const backupFor = (scope) => join(memoryDir, 'backups', `${scope}.pre-storage-v2.md`);
  await mkdir(join(memoryDir, 'bots'), { recursive: true });
  const rawTeam = legacyDocument(oldEntries);
  const rawBot = legacyDocument(botEntries);
  await writeFile(pathFor('team'), rawTeam);
  await writeFile(pathFor(botId), rawBot);

  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const boot = () => start({
    pluginRoot, dataDir, listen: { host: '127.0.0.1', port },
    signal: new AbortController().signal, logger: { info() {}, warn() {}, error() {} },
    // This fixture intentionally has no Agent; it validates the real HTTP and disk boundary.
  });
  app = await boot();
  const request = async (method, scope = 'team', body, id) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/memory/${scope}${id ? `/${id}` : ''}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const restart = async () => {
    await app.dispose();
    app = undefined;
    app = await boot();
  };
  return {
    request, restart, botId, oldEntries, botEntries, rawTeam, rawBot, pathFor, backupFor,
    journalPath: join(memoryDir, 'journal.jsonl'),
  };
}

const identitiesAndBodies = (entries) => entries.map(({ id, text }) => ({ id, text }));
const assertConflict = (result) => {
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'memory_conflict');
};

test('HTTP GET exposes separate 100000 storage and 6000 context budgets, derives revisions and leaves old files untouched', async (t) => {
  const f = await fixture(t);
  for (const [scope, oldEntries, raw] of [['team', f.oldEntries, f.rawTeam], [f.botId, f.botEntries, f.rawBot]]) {
    const result = await f.request('GET', scope);
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, scope);
    assert.deepEqual(identitiesAndBodies(result.body.entries), oldEntries);
    assert.deepEqual(result.body.budget, {
      used: oldEntries.reduce((size, entry) => size + entry.text.length, 0),
      limit: 100000, remaining: 100000 - oldEntries.reduce((size, entry) => size + entry.text.length, 0),
      entryMax: 1200, entryOverhead: 0, entryCount: oldEntries.length, entryLimit: 1000, unit: 'characters',
    });
    assert.equal(result.body.chars, result.body.budget.used);
    assert.deepEqual(result.body.contextBudget, { limit: 6000, unit: 'characters' });
    for (const entry of result.body.entries) {
      assert.match(entry.revision, /^[a-f0-9]{64}$/);
      assert.equal(entry.pinned, false);
    }
    assert.deepEqual(await readFile(f.pathFor(scope)), raw);
    await assert.rejects(readFile(f.backupFor(scope)), { code: 'ENOENT' });
  }
});

test('HTTP create and revision update preserve all old memories, pin state, original backup and IDs across restart', async (t) => {
  const f = await fixture(t);
  const before = (await f.request('GET')).body.entries;
  const created = await f.request('POST', 'team', { key: 'writing.preference', text: '新'.repeat(1000), pinned: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.unchanged, false);
  assert.equal(created.body.entry.key, 'writing.preference');
  assert.equal(created.body.entry.pinned, true);
  assert.equal(created.body.budget.used, 4520);
  assert.match(created.body.entry.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(identitiesAndBodies(created.body.entries.slice(0, 12)), f.oldEntries);
  assert.deepEqual(await readFile(f.backupFor('team')), f.rawTeam);

  const updated = await f.request('POST', 'team', {
    key: 'writing.preference', text: 'Changed by a confirmed edit', pinned: false,
    expectedRevision: created.body.entry.revision,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.entry.id, created.body.entry.id);
  assert.notEqual(updated.body.entry.revision, created.body.entry.revision);
  assert.equal(updated.body.entry.pinned, false);
  assert.deepEqual(updated.body.entries.slice(0, 12), before);
  const journal = await readFile(f.journalPath, 'utf8');
  const retry = await f.request('POST', 'team', {
    key: 'writing.preference', text: updated.body.entry.text, pinned: false,
    expectedRevision: created.body.entry.revision,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.unchanged, true);
  assert.deepEqual(retry.body.entry, updated.body.entry);
  assert.equal(await readFile(f.journalPath, 'utf8'), journal);
  assert.deepEqual(await readFile(f.backupFor('team')), f.rawTeam);

  const personal = await f.request('POST', f.botId, { key: 'personal.style', text: 'Use short paragraphs', pinned: true });
  assert.equal(personal.status, 200);
  assert.equal(personal.body.scope, f.botId);
  assert.deepEqual(identitiesAndBodies(personal.body.entries.slice(0, 1)), f.botEntries);
  assert.deepEqual(await readFile(f.backupFor(f.botId)), f.rawBot);
  await f.restart();
  const restored = await f.request('GET');
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.entries, updated.body.entries);
  assert.deepEqual((await f.request('GET', f.botId)).body.entries, personal.body.entries);
  assert.deepEqual(await readFile(f.backupFor('team')), f.rawTeam);
  assert.deepEqual(await readFile(f.backupFor(f.botId)), f.rawBot);
});

test('HTTP concurrent, stale and missing-revision edits return 409 without publishing rejected draft bodies', async (t) => {
  const f = await fixture(t);
  const initial = await f.request('POST', 'team', { key: 'preferences', text: 'Original confirmed preferences' });
  const entry = initial.body.entry;
  assert.equal(initial.status, 200);
  const drafts = ['First concurrent draft', 'Second concurrent draft'];
  const results = await Promise.all(drafts.map((text) => f.request('POST', 'team', {
    key: 'preferences', text, expectedRevision: entry.revision,
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const acceptedIndex = results.findIndex((result) => result.status === 200);
  const accepted = results[acceptedIndex].body.entry;
  assertConflict(results[1 - acceptedIndex]);
  assert.equal(accepted.text, drafts[acceptedIndex]);
  const baseline = await readFile(f.pathFor('team'));
  const journal = await readFile(f.journalPath, 'utf8');
  const stale = await f.request('POST', 'team', { key: 'preferences', text: 'A stale draft must not overwrite the saved edit', expectedRevision: entry.revision });
  assertConflict(stale);
  const missing = await f.request('POST', 'team', { replaceId: entry.id, text: 'A blind draft must not overwrite the saved edit', pinned: true });
  assertConflict(missing);
  assert.deepEqual(await readFile(f.pathFor('team')), baseline);
  assert.equal(await readFile(f.journalPath, 'utf8'), journal);
  const current = await f.request('GET');
  assert.deepEqual(current.body.entries.find((item) => item.id === entry.id), accepted);
  assert.equal(current.body.entries.some((item) => item.text === drafts[1 - acceptedIndex]), false);
  assert.deepEqual(identitiesAndBodies(current.body.entries.slice(0, 12)), f.oldEntries);
  await f.restart();
  assert.deepEqual((await f.request('GET')).body.entries, current.body.entries);
});

test('HTTP simultaneous topic creation conflicts safely, and a deleted topic cannot be revived by its stale revision', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(['Creation A', 'Creation B'].map((text) => f.request('POST', 'team', { key: 'new.topic', text })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const created = results.find((result) => result.status === 200).body.entry;
  assertConflict(results.find((result) => result.status === 409));
  const deleted = await f.request('DELETE', 'team', undefined, created.id);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.entries.some((entry) => entry.key === 'new.topic'), false);
  const before = await readFile(f.pathFor('team'));
  assertConflict(await f.request('POST', 'team', {
    key: 'new.topic', text: created.text, expectedRevision: created.revision,
  }));
  assert.deepEqual(await readFile(f.pathFor('team')), before);
  assert.deepEqual(identitiesAndBodies((await f.request('GET')).body.entries), f.oldEntries);
  assert.deepEqual(await readFile(f.backupFor('team')), f.rawTeam);
});
