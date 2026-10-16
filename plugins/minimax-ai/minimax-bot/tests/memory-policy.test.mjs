import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, ENTRY_MAX, STORAGE_MAX } from '../miniapp/node/memory.mjs';
import { Store } from '../miniapp/node/store.mjs';
import { Engine } from '../miniapp/node/engine.mjs';
import { Team } from '../miniapp/node/team.mjs';
import { createMcpHandler } from '../miniapp/node/mcp.mjs';
import { setLocale } from '../miniapp/node/i18n.mjs';
import Ajv from 'ajv';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-memory-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = new MemoryStore(dir);
  const store = new Store(dir);
  await memory.init();
  await store.init();
  setLocale('en');
  const engine = new Engine({ store, memory, broadcast() {}, logger: { warn() {} } });
  const team = new Team({ store, memory, engine, broadcast() {} });
  const handle = createMcpHandler({ team, engine });
  const rpc = async (method, params) => {
    let result;
    await handle({ method: 'POST' }, { writeHead() { return this; }, end(body) { result = JSON.parse(body); } },
      { jsonrpc: '2.0', id: 1, method, params });
    return result.result;
  };
  return { dir, memory, store, engine, rpc };
}

test('a topic is updated in place, retains its id across restart and retries do not grow the journal', async (t) => {
  const { dir, memory } = await fixture(t);
  const first = await memory.remember('team', { text: 'Need five seats', key: 'car.seats' });
  const next = await memory.remember('team', { text: 'Need seven seats', key: 'car.seats' });
  assert.equal(next.entry.id, first.entry.id);
  assert.equal((await memory.list('team')).length, 1);
  const restored = new MemoryStore(dir);
  const replaced = await restored.remember('team', { text: 'Need six seats', replaceId: first.entry.id });
  assert.equal(replaced.entry.id, first.entry.id);
  assert.equal(replaced.entry.key, 'car.seats');
  const before = await readFile(memory.journal, 'utf8');
  assert.equal((await restored.remember('team', { text: 'Need six seats', key: 'car.seats' })).unchanged, true);
  assert.equal(await readFile(memory.journal, 'utf8'), before);
});

test('a full legacy context budget does not block persistent storage or erase old topics', async (t) => {
  const { memory } = await fixture(t);
  for (let i = 0; i < 12; i++) await memory.remember('team', { text: `${i}:`.padEnd(290, '字'), key: `topic.${i}` });
  const before = await memory.list('team');
  await memory.remember('team', { text: '新'.repeat(73), key: 'new' });
  assert.deepEqual((await memory.list('team')).slice(0, 12), before);
  await assert.rejects(memory.remember('team', { text: '字'.repeat(ENTRY_MAX + 1) }), (e) => e.code === 'memory_too_long');
});

test('topic keys remain scope-local, concurrent upserts are serialized, conflicts and unknown ids do not overwrite', async (t) => {
  const { memory } = await fixture(t);
  const a = await memory.remember('team', { text: 'A', key: 'topic' });
  const b = await memory.remember('team', { text: 'B', key: 'other' });
  await assert.rejects(memory.remember('team', { text: 'C', key: 'other', replaceId: a.entry.id }));
  await assert.rejects(memory.remember('team', { text: 'C', replaceId: 'deadbeef' }));
  await Promise.all(['D', 'E'].map((text) => memory.remember('team', { text, key: 'topic' })));
  await memory.remember('bot_test', { text: 'private', key: 'topic' });
  assert.deepEqual((await memory.list('team')).map((e) => e.id), [a.entry.id, b.entry.id]);
  assert.equal((await memory.list('team'))[0].text, 'E');
  assert.equal((await memory.list('bot_test'))[0].text, 'private');
});

test('MCP exposes required helper identity, text bounds and topic upsert; prompts and results show budget', async (t) => {
  const { rpc, store, engine } = await fixture(t);
  const { tools } = await rpc('tools/list');
  const ajv = new Ajv();
  const helper = ajv.compile(tools.find((t) => t.name === 'start_helper').inputSchema);
  assert.equal(helper({ task: 'research' }), false);
  const remember = ajv.compile(tools.find((t) => t.name === 'remember').inputSchema);
  assert.equal(remember({ text: '字'.repeat(ENTRY_MAX + 1), key: 'topic' }), false);
  assert.equal(remember({ text: 'seats', key: 'car.seats' }), true);
  assert.equal(remember({ text: 'seats', replaceId: 'wrong' }), false);
  const bot = store.state.bots[0];
  const result = await rpc('tools/call', { name: 'remember', arguments: { caller_bot_id: bot.id, text: 'Need seven seats', key: 'car.seats' } });
  assert.equal(result.isError, undefined);
  const saved = JSON.parse(result.content[0].text);
  assert.equal(saved.budget.remaining, STORAGE_MAX - 'Need seven seats'.length);
  const brief = await engine.buildBrief(bot, `bot:${bot.id}`);
  assert.match(brief, /car.seats/);
  assert.match(brief, /99984/);
  assert.match(brief, /6000/);
  assert.equal(remember({ text: 'no topic' }), false);
  assert.match(brief, /research/i);
});


test('legacy entries keep their ids and gain a topic without losing metadata or other entries', async (t) => {
  const { memory, dir } = await fixture(t);
  const meta = Buffer.from(JSON.stringify({ source: 'chat', added: '2026-10-01', by: 'Rob' })).toString('base64url');
  await writeFile(memory.pathFor('team'), `# Team memory\n\n- old preference <!-- meta:${meta} -->\n- old requirement [source: chat; added: 2026-10-01; by: Rob]\n`);
  const before = await memory.list('team');
  const result = await memory.remember('team', { text: 'updated preference', replaceId: before[0].id, key: 'preference' });
  assert.equal(result.entry.id, before[0].id);
  assert.deepEqual((await memory.list('team'))[1], before[1]);
  const restored = new MemoryStore(dir);
  assert.equal((await restored.list('team'))[0].id, before[0].id);
});

test('disk write/read failures preserve prior memories and journal; the next request can retry', async (t) => {
  const { dir, memory } = await fixture(t);
  await memory.remember('team', { text: 'must keep', key: 'important' });
  const path = memory.pathFor('team');
  const before = await readFile(path, 'utf8');
  const journal = await readFile(memory.journal, 'utf8');
  const pathFor = memory.pathFor.bind(memory);
  memory.pathFor = () => join(dir, 'missing', 'team.md');
  await assert.rejects(memory.remember('team', { text: 'write fails' }), { code: 'ENOENT' });
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(memory.journal, 'utf8'), journal);
  memory.pathFor = () => dir;
  await assert.rejects(memory.remember('team', { text: 'read fails' }), { code: 'EISDIR' });
  memory.pathFor = pathFor;
  await memory.remember('team', { text: 'updated', key: 'important' });
  assert.equal((await memory.list('team'))[0].text, 'updated');
});

test('real turn and MCP paths persist only bounded memory failure details through finish and reload', async (t) => {
  const { dir, store, engine, rpc } = await fixture(t);
  const bot = store.state.bots[0];
  const chatId = `bot:${bot.id}`;
  engine.agent = { async run(input, { onEvent }) {
    onEvent({ type: 'turn.started', sessionId: 'session-test', turnId: 'turn-test' });
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    const bad = await rpc('tools/call', { name: 'remember', arguments: { caller_bot_id: bot.id, text: '字'.repeat(ENTRY_MAX + 1), key: 'car.seats' } });
    assert.equal(bad.isError, true);
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: false });
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    await rpc('tools/call', { name: 'remember', arguments: { caller_bot_id: bot.id, text: 'Need seven seats', key: 'car.seats' } });
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: true });
    return { status: 'finished', sessionId: 'session-test', text: 'Saved' };
  } };
  const result = await engine.runBotTurn({ bot, chatId, text: 'Remember my requirement', kind: 'private' });
  assert.equal(result.status, 'done');
  const restored = new Store(dir); await restored.init();
  const message = (await restored.getMessages(chatId)).find((m) => m.id === result.messageId);
  const tools = message.parts.filter((p) => p.type === 'tool');
  assert.deepEqual(tools.map((p) => p.state), ['failed', 'ok']);
  assert.deepEqual(tools[0].issue, { code: 'memory_too_long', max: ENTRY_MAX, actual: ENTRY_MAX + 1, scope: bot.id, key: 'car.seats' });
  assert.equal(tools[1].issue, undefined);
  assert.equal(tools[1].memoryReceipt.key, 'car.seats');
  assert.equal(tools[1].memoryReceipt.scope, bot.id);
});

test('ambiguous callers and parallel same-name calls never receive guessed diagnostics', async (t) => {
  const { engine } = await fixture(t);
  const first = { type: 'tool', name: 'mcp__minimax-bot__remember', state: 'running' };
  const second = { ...first };
  const turn = { botId: 'bot_test', message: { parts: [first, second] }, flush() {} };
  engine.running.set('one', turn);
  engine.captureToolIssue('bot_test', 'remember', { code: 'memory_full' });
  assert.equal(first.issue, undefined); assert.equal(second.issue, undefined);
  turn.message.parts = [first];
  engine.running.set('two', { ...turn });
  engine.captureToolIssue('bot_test', 'remember', { code: 'memory_full' });
  engine.captureToolIssue(undefined, 'remember', { code: 'memory_full' });
  assert.equal(first.issue, undefined);
});


test('topic updates retain secret rejection and Bot scope permissions', async (t) => {
  const { memory, rpc, store } = await fixture(t);
  const original = await memory.remember('team', { text: 'safe', key: 'topic', source: 'test' });
  await assert.rejects(memory.remember('team', { text: 'password: test-value', key: 'topic' }));
  for (const key of ['../escape', 'with space', 'UPPER', '', 'a'.repeat(65)]) {
    await assert.rejects(memory.remember('team', { text: 'invalid key', key }));
  }
  assert.deepEqual((await memory.list('team'))[0], original.entry);
  store.state.bots.push({ id: 'bot_member', name: 'Member', isMain: false });
  const denied = await rpc('tools/call', { name: 'remember', arguments: { caller_bot_id: 'bot_member', text: 'overwrite', scope: 'team', key: 'topic' } });
  assert.equal(denied.isError, true);
  assert.equal((await memory.list('team'))[0].text, 'safe');
});
