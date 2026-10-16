import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = resolve(process.env.BOT_PLUGIN_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { MemoryStore, storageBudget, memoryBudget, ENTRY_MAX, STORAGE_MAX, FILE_MAX, MAX_ENTRIES, ENTRY_OVERHEAD } = await import(pathToFileURL(join(pluginRoot, 'miniapp/node/memory.mjs')).href);
const { selectMemoryContext, MEMORY_CONTEXT_MAX } = await import(pathToFileURL(join(pluginRoot, 'miniapp/node/memory-context.mjs')).href);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-memory-storage-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = new MemoryStore(dir);
  await memory.init();
  return { dir, memory };
}
const line = (text, index, extra = {}) => `- ${text} <!-- meta:${Buffer.from(JSON.stringify({ id: index.toString(16).padStart(8, '0'), source: '用户确认', added: '2024-01-02', by: 'Original Bot', ...extra })).toString('base64url')} -->`;
const rows = async (memory) => (await readFile(memory.journal, 'utf8')).trim().split('\n').map(JSON.parse);
const seed = async (memory, lines) => writeFile(memory.pathFor('team'), `# Existing memory\n\n${lines.join('\n')}\n`);

test('storage counts UTF-16 body characters without prompt overhead and preserves compatibility exports', () => {
  assert.equal(ENTRY_MAX, 1200);
  assert.equal(STORAGE_MAX, 100000);
  assert.equal(FILE_MAX, STORAGE_MAX);
  assert.equal(MAX_ENTRIES, 1000);
  assert.equal(ENTRY_OVERHEAD, 0);
  assert.equal(memoryBudget, storageBudget);
  assert.deepEqual(storageBudget([{ text: '😀汉字' }, { text: 'abc' }]), {
    used: 7, limit: 100000, remaining: 99993, entryMax: 1200, entryOverhead: 0,
    entryCount: 2, entryLimit: 1000, unit: 'characters',
  });
});

test('the per-entry boundary counts UTF-16 characters and rejected growth keeps the stored version', async (t) => {
  const { memory } = await fixture(t);
  const text = '😀'.repeat(600);
  const saved = await memory.remember('team', { text, key: 'unicode.boundary' });
  assert.equal(saved.entry.text.length, 1200);
  const raw = await readFile(memory.pathFor('team'));
  await assert.rejects(memory.remember('team', { text: `${text}界`, key: 'unicode.boundary', expectedRevision: saved.entry.revision }), (error) => {
    assert.equal(error.code, 'memory_too_long');
    assert.equal(error.details.actual, 1201);
    assert.equal(error.details.max, 1200);
    return true;
  });
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
});

test('a file at the old 4000 budget accepts more memory, backs up exact bytes and keeps old IDs/text after restart', async (t) => {
  const { dir, memory } = await fixture(t);
  const texts = [...Array.from({ length: 11 }, () => '旧'.repeat(300)), '末'.repeat(220)];
  assert.equal(texts.reduce((used, text) => used + text.length + 40, 0), 4000);
  const raw = Buffer.from(`\uFEFF# 用户原文件（保留）\r\n\r\n${texts.map((text, index) => line(text, index + 1)).join('\r\n')}\r\n`);
  await writeFile(memory.pathFor('team'), raw);
  await memory.init();
  const before = await memory.list('team');
  assert.equal(before.length, 12);
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  await assert.rejects(readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), { code: 'ENOENT' });
  const added = await memory.remember('team', { text: '新'.repeat(1000), key: 'new.preference' });
  assert.equal(added.budget.used, 4520);
  assert.deepEqual(await readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), raw);
  await memory.remember('team', { text: '新'.repeat(900), key: 'new.preference', expectedRevision: added.entry.revision, requireRevision: true });
  assert.deepEqual(await readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), raw);
  const restored = new MemoryStore(dir);
  await restored.init();
  assert.deepEqual((await restored.list('team')).slice(0, 12), before);
  assert.deepEqual(before.map((entry) => entry.text), texts);
});

test('a failed original backup rejects the write before WAL/journal and permits a later retry', async (t) => {
  const { memory } = await fixture(t);
  await seed(memory, [line('Original body', 1, { key: 'topic' })]);
  const raw = await readFile(memory.pathFor('team'));
  const original = (await memory.list('team'))[0];
  await writeFile(join(memory.dir, 'backups'), 'blocked directory');
  await assert.rejects(memory.remember('team', { text: 'Changed body', key: 'topic', expectedRevision: original.revision }), { code: 'memory_backup_failed' });
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  await assert.rejects(readFile(memory.pendingPath), { code: 'ENOENT' });
  await assert.rejects(readFile(memory.journal), { code: 'ENOENT' });
  await rm(join(memory.dir, 'backups'));
  await memory.remember('team', { text: 'Changed body', key: 'topic', expectedRevision: original.revision });
  assert.deepEqual(await readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), raw);
});

test('backup publication failure leaves no final or staged backup and rejects mutation before WAL', async (t) => {
  const { memory } = await fixture(t);
  await seed(memory, [line('Original bytes survive failed publication', 1, { key: 'topic' })]);
  const raw = await readFile(memory.pathFor('team'));
  const original = (await memory.list('team'))[0];
  const backup = join(memory.dir, 'backups', 'team.pre-storage-v2.md');
  const link = fs.promises.link;
  let stagedBytes;
  fs.promises.link = async (source, target) => {
    assert.equal(target, backup);
    stagedBytes = await readFile(source);
    throw Object.assign(new Error('backup publication unavailable'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(memory.remember('team', { text: 'Changed after publication', key: 'topic', expectedRevision: original.revision }), { code: 'memory_backup_failed' });
  } finally {
    fs.promises.link = link;
    syncBuiltinESMExports();
  }
  assert.deepEqual(stagedBytes, raw);
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  await assert.rejects(readFile(backup), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(memory.dir, 'backups')), []);
  await assert.rejects(readFile(memory.pendingPath), { code: 'ENOENT' });
  await assert.rejects(readFile(memory.journal), { code: 'ENOENT' });
  await memory.remember('team', { text: 'Changed after publication', key: 'topic', expectedRevision: original.revision });
  assert.deepEqual(await readFile(backup), raw);
  assert.deepEqual(await readdir(join(memory.dir, 'backups')), ['team.pre-storage-v2.md']);
  await memory.remember('team', { text: 'Changed again', key: 'topic' });
  assert.deepEqual(await readFile(backup), raw);
  assert.deepEqual(await readdir(join(memory.dir, 'backups')), ['team.pre-storage-v2.md']);
});

test('oversized legacy scopes remain readable and can shrink without losing other entries', async (t) => {
  const { dir, memory } = await fixture(t);
  await seed(memory, [line('长'.repeat(1300), 1, { key: 'long.topic' }), ...Array.from({ length: 1000 }, (_, index) => line('保'.repeat(110), index + 2))]);
  const raw = await readFile(memory.pathFor('team'));
  const before = await memory.list('team');
  assert.equal(before.length, 1001);
  assert.ok(storageBudget(before).used > STORAGE_MAX);
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  const shortened = await memory.remember('team', { text: '长'.repeat(1250), key: 'long.topic', expectedRevision: before[0].revision, requireRevision: true });
  assert.equal(shortened.entry.id, before[0].id);
  await assert.rejects(memory.remember('team', { text: '长'.repeat(1251), key: 'long.topic', expectedRevision: shortened.entry.revision }), { code: 'memory_too_long' });
  await assert.rejects(memory.remember('team', { text: `${before[1].text}增`, replaceId: before[1].id, expectedRevision: before[1].revision }), (error) => {
    assert.equal(error.code, 'memory_full');
    assert.equal(error.details.scope, 'team');
    assert.equal(error.details.needed, 1);
    assert.equal(error.details.remaining, 0);
    assert.equal(error.details.shortfall, 11251);
    return true;
  });
  await memory.forget('team', before.at(-1).id);
  const restored = new MemoryStore(dir);
  await restored.init();
  const after = await restored.list('team');
  assert.equal(after.length, 1000);
  assert.equal(after[0].text.length, 1250);
  assert.deepEqual(after.slice(1), before.slice(1, -1));
  assert.deepEqual(await readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), raw);
});

test('character and entry limits report incremental need and net shortage without changing storage', async (t) => {
  const { memory } = await fixture(t);
  await seed(memory, Array.from({ length: 100 }, (_, index) => line('满'.repeat(1000), index + 1)));
  const raw = await readFile(memory.pathFor('team'));
  await assert.rejects(memory.remember('team', { text: '新增', key: 'new.topic' }), (error) => {
    assert.equal(error.code, 'memory_full');
    assert.equal(error.details.used, 100000);
    assert.equal(error.details.needed, 2);
    assert.equal(error.details.shortfall, 2);
    assert.equal(error.details.remaining, 0);
    return true;
  });
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  await seed(memory, Array.from({ length: 1000 }, (_, index) => line(`条目 ${index}`, index + 1)));
  await assert.rejects(memory.remember('team', { text: 'Another distinct entry' }), (error) => {
    assert.equal(error.code, 'memory_full');
    assert.equal(error.details.entryCount, 1000);
    assert.equal(error.details.entryNeeded, 1);
    assert.equal(error.details.entryShortfall, 1);
    assert.equal(error.details.shortfall, 0);
    return true;
  });
});

test('revision checks serialize concurrent edits, preserve identity/metadata and make a successful retry idempotent', async (t) => {
  const { dir, memory } = await fixture(t);
  const initial = await memory.remember('team', { text: 'Initial preferences', key: 'preferences', source: 'Confirmed by user', by: 'Bot A', added: '2020-02-03' });
  const outcomes = await Promise.allSettled([
    memory.remember('team', { text: 'First edit', key: 'preferences', pinned: true, expectedRevision: initial.entry.revision, requireRevision: true }),
    memory.remember('team', { text: 'Second edit', key: 'preferences', expectedRevision: initial.entry.revision, requireRevision: true }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'memory_conflict');
  const updated = outcomes[0].value.entry;
  assert.equal(updated.id, initial.entry.id);
  assert.equal(updated.source, initial.entry.source);
  assert.equal(updated.by, initial.entry.by);
  assert.equal(updated.added, initial.entry.added);
  assert.equal(updated.pinned, true);
  assert.notEqual(updated.revision, initial.entry.revision);
  const journal = await readFile(memory.journal, 'utf8');
  const retried = await memory.remember('team', { text: 'First edit', key: 'preferences', pinned: true, expectedRevision: initial.entry.revision, requireRevision: true });
  assert.equal(retried.unchanged, true);
  assert.equal(await readFile(memory.journal, 'utf8'), journal);
  const replacement = (await rows(memory)).at(-1);
  assert.equal(replacement.before, 'Initial preferences');
  assert.equal(replacement.after, 'First edit');
  assert.equal(replacement.beforeEntry.pinned, false);
  assert.equal(replacement.afterEntry.pinned, true);
  await assert.rejects(memory.remember('team', { text: 'Blind overwrite', key: 'preferences', requireRevision: true }), { code: 'memory_conflict' });
  const restored = new MemoryStore(dir);
  await restored.init();
  assert.deepEqual((await restored.list('team'))[0], updated);
});

test('two revision-required creates for one topic cannot silently overwrite each other', async (t) => {
  const { memory } = await fixture(t);
  const outcomes = await Promise.allSettled([
    memory.remember('team', { text: 'First creation', key: 'new.topic', requireRevision: true }),
    memory.remember('team', { text: 'Concurrent creation', key: 'new.topic', requireRevision: true }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'memory_conflict');
  const initial = outcomes[0].value.entry;
  const pinned = await memory.remember('team', { text: initial.text, key: initial.key, pinned: true, expectedRevision: initial.revision, requireRevision: true });
  assert.notEqual(pinned.entry.revision, initial.revision);
  assert.equal(pinned.entry.text, initial.text);
  assert.equal(pinned.entry.id, initial.id);
  assert.equal((await memory.list('team')).length, 1);
});

test('stale revisions cannot resurrect a deleted topic or a missing replacement', async (t) => {
  const { memory } = await fixture(t);
  const { entry } = await memory.remember('team', { text: 'Old topic', key: 'old.topic', requireRevision: true });
  await memory.forget('team', entry.id);
  await assert.rejects(memory.remember('team', { text: 'Old topic', key: 'old.topic', expectedRevision: entry.revision, requireRevision: true }), { code: 'memory_conflict' });
  await assert.rejects(memory.remember('team', { text: 'Old topic', replaceId: entry.id, expectedRevision: entry.revision }), { code: 'memory_conflict' });
  assert.equal((await memory.list('team')).length, 0);
});

test('WAL failure recovers one audited revision and retry keeps both the original backup and operation unique', async (t) => {
  const { dir, memory } = await fixture(t);
  await seed(memory, [line('Before recovery', 1, { key: 'recovery' })]);
  const original = (await memory.list('team'))[0];
  const raw = await readFile(memory.pathFor('team'));
  memory.log = async () => { throw Object.assign(new Error('journal unavailable'), { code: 'EIO' }); };
  await assert.rejects(memory.remember('team', { text: 'After recovery', key: 'recovery', pinned: true, expectedRevision: original.revision, requireRevision: true }), { code: 'memory_pending' });
  assert.deepEqual(await readFile(memory.pathFor('team')), raw);
  const restored = new MemoryStore(dir);
  await restored.init();
  const result = await restored.remember('team', { text: 'After recovery', key: 'recovery', pinned: true, expectedRevision: original.revision, requireRevision: true });
  assert.equal(result.unchanged, true);
  assert.equal(result.entry.id, original.id);
  assert.equal((await rows(restored)).length, 1);
  assert.equal((await rows(restored))[0].afterEntry.revision, result.entry.revision);
  assert.deepEqual(await readFile(join(memory.dir, 'backups', 'team.pre-storage-v2.md')), raw);
  await assert.rejects(readFile(restored.pendingPath), { code: 'ENOENT' });
});

const contextEntry = (id, text, extra = {}) => ({ scope: 'self', id, key: '', revision: `revision-${id}`, pinned: false, text, added: '2024-01-01', ...extra });

test('context ranking keeps pinned and old Chinese/key matches ahead of unrelated recent records without mutating sources', () => {
  const entries = [
    contextEntry('older', '用户偏爱纯电动汽车，购车预算二十万元', { key: 'car.requirements' }),
    contextEntry('pinned', '所有回复都先给结论', { scope: 'team', pinned: true }),
    contextEntry('newer', '用户喜欢无糖咖啡', { added: '2026-01-01' }),
  ];
  const before = structuredClone(entries);
  const selected = selectMemoryContext(entries, { query: '购车预算是多少' });
  assert.deepEqual(selected.entries.map((entry) => entry.id), ['pinned', 'older', 'newer']);
  assert.equal(selected.entries[1], entries[0]);
  assert.deepEqual(entries, before);
  assert.equal(selectMemoryContext(entries, { query: 'car' }).entries[1].id, 'older');
  assert.deepEqual(selected.text.split('\n').map(JSON.parse).map((entry) => [entry.scope, entry.id, entry.key, entry.revision, entry.pinned, entry.text]), selected.entries.map((entry) => [entry.scope, entry.id, entry.key, entry.revision, entry.pinned, entry.text]));
});

test('one 6000 context limit covers self/team, whole entries, metadata, escapes and separators', () => {
  assert.equal(MEMORY_CONTEXT_MAX, 6000);
  const entries = Array.from({ length: 12 }, (_, index) => contextEntry(`entry-${index}`, '正文'.repeat(500), { scope: index % 2 ? 'team' : 'self', key: `topic.${index}`, revision: 'r'.repeat(64) }));
  const selected = selectMemoryContext(entries);
  assert.ok(selected.entries.length > 0 && selected.entries.length < entries.length);
  assert.equal(selected.used, selected.text.length);
  assert.ok(selected.used <= 6000);
  assert.equal(selected.total, 12);
  assert.equal(selected.omitted, entries.length - selected.entries.length);
  for (const entry of selected.entries) assert.equal(entry.text, '正文'.repeat(500));
  const pair = [contextEntry('a', '第一行\n第二行 "quoted"'), contextEntry('b', '😀')];
  const all = selectMemoryContext(pair);
  assert.equal(all.used, all.text.length);
  assert.equal(selectMemoryContext(pair, { limit: all.used }).entries.length, 2);
  assert.equal(selectMemoryContext(pair, { limit: all.used - 1 }).entries.length, 1);
  assert.equal(selectMemoryContext(pair, { limit: 0 }).text, '');
});

test('an overlong pinned record is skipped whole and no-query ordering is stable and recent first', () => {
  const entries = [contextEntry('huge', '大'.repeat(7000), { pinned: true }), contextEntry('old', 'Old'), contextEntry('new', 'New')];
  const selected = selectMemoryContext(entries);
  assert.deepEqual(selected.entries.map((entry) => entry.id), ['new', 'old']);
  assert.equal(selected.omitted, 1);
  assert.equal(entries[0].text.length, 7000);
  assert.deepEqual(selectMemoryContext(entries), selected);
  assert.throws(() => selectMemoryContext(entries, { limit: -1 }), RangeError);
});
