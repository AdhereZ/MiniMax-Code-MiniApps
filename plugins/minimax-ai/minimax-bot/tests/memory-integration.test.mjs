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

const decoded = (result) => JSON.parse(result.content[0].text);
const call = (rpc, name, args) => rpc('tools/call', { name, arguments: args });

test('MCP requires a topic for every caller, checks revisions and treats identical retries as unchanged', async (t) => {
  const { rpc, store, memory } = await fixture(t);
  const bot = store.state.bots[0];
  for (const args of [{ scope: 'team', text: 'no topic' }, { caller_bot_id: bot.id, text: 'no topic' }]) {
    assert.equal((await call(rpc, 'remember', args)).isError, true);
  }
  const args = { caller_bot_id: bot.id, key: 'travel.requirements', text: 'Seven seats, child seats, and luggage space' };
  const created = decoded(await call(rpc, 'remember', args));
  assert.equal((await call(rpc, 'remember', { ...args, text: 'Six seats' })).isError, true);
  const updated = decoded(await call(rpc, 'remember', { ...args, text: 'Six seats, child seats, and luggage space', expected_revision: created.entry.revision, pinned: true }));
  const retried = decoded(await call(rpc, 'remember', { ...args, text: updated.entry.text, expected_revision: created.entry.revision, pinned: true }));
  assert.equal(retried.unchanged, true);
  assert.equal((await memory.list(bot.id)).length, 1);
  assert.equal((await call(rpc, 'remember', { ...args, text: 'Overwrite from stale version', expected_revision: created.entry.revision })).isError, true);
  assert.equal((await memory.list(bot.id))[0].text, updated.entry.text);
});

test('recall pages preserve scope permissions, exact topics, versions, and a serialized response bound', async (t) => {
  const { rpc, store, memory } = await fixture(t);
  const bot = store.state.bots[0];
  for (let i = 0; i < 18; i++) await memory.remember(bot.id, { key: `topic.${i}`, text: `${i}：${'事实。'.repeat(300)}` });
  await memory.remember('team', { key: 'team.language', text: '中文' });
  let offset = 0, gathered = [];
  do {
    const result = await call(rpc, 'recall', { caller_bot_id: bot.id, scope: 'self', limit: 20, offset });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.length <= 6000);
    const page = decoded(result);
    assert.equal(page.storage.length, 1);
    assert.equal(page.storage[0].budget.limit, STORAGE_MAX);
    assert.ok(page.entries.every((entry) => entry.scope === bot.id && entry.revision && entry.textComplete));
    gathered.push(...page.entries);
    assert.ok(page.nextOffset === null || page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(gathered.map((entry) => entry.id)).size, 18);
  const exact = decoded(await call(rpc, 'recall', { caller_bot_id: bot.id, key: 'topic.2' }));
  assert.equal(exact.entries.length, 1);
  assert.equal(exact.entries[0].key, 'topic.2');
  const defaults = decoded(await call(rpc, 'recall', { caller_bot_id: bot.id, query: '中文' }));
  assert.equal(defaults.entries[0].scope, 'team');
  store.state.bots.push({ id: 'bot_private', name: 'Private', isMain: false });
  const denied = await call(rpc, 'recall', { caller_bot_id: 'bot_private', scope: 'bot', target_bot: bot.id });
  assert.equal(denied.isError, true);
});

test('oversized escaped legacy memory can be retrieved completely without stalled pagination', async (t) => {
  const { rpc, memory } = await fixture(t);
  const original = '\u0001'.repeat(5000) + '末尾仍保留';
  await writeFile(memory.pathFor('team'), `# Team\n\n- ${original}\n`);
  const [entry] = await memory.list('team');
  let textOffset = 0, text = '';
  do {
    const result = await call(rpc, 'recall', { scope: 'team', entry_id: entry.id, text_offset: textOffset });
    assert.ok(result.content[0].text.length <= 6000);
    const page = decoded(result);
    assert.equal(page.entries.length, 1);
    const chunk = page.entries[0];
    assert.equal(chunk.textComplete, false);
    text += chunk.text;
    assert.ok(chunk.nextTextOffset === null || chunk.nextTextOffset > textOffset);
    textOffset = chunk.nextTextOffset;
  } while (textOffset !== null);
  assert.equal(text, original);
  assert.equal((await memory.list('team'))[0].text, original);
});

test('changing the retrieval query sends only a new bounded selection, not repeated standing instructions', async (t) => {
  const { store, memory, engine } = await fixture(t);
  const bot = store.state.bots[0], chatId = `bot:${bot.id}`;
  await memory.remember(bot.id, { key: 'car.requirements', text: '购车预算七座家庭需求'.repeat(60) });
  for (let i = 0; i < 14; i++) await memory.remember(bot.id, { key: `coffee.${i}`, text: `${i}咖啡烘焙偏好`.repeat(70) });
  const sent = [];
  engine.agent = { async run(input) { sent.push(input.text); return { status: 'finished', sessionId: 'session-memory', text: 'done' }; } };
  for (const text of ['咖啡', '购车', '购车']) await engine.runBotTurn({ bot, chatId, text, kind: 'private' });
  assert.match(sent[0], /<minimax-bot-context>/);
  assert.doesNotMatch(sent[1], /<minimax-bot-context>/);
  assert.match(sent[1], /car.requirements/);
  assert.equal(sent[2], '购车');
  for (const request of sent.slice(0, 2)) {
    const lines = request.split('\n').filter((line) => line.startsWith('{"scope":'));
    assert.ok(lines.join('\n').length <= 6000);
  }
  assert.equal((await memory.list(bot.id)).length, 15);
});

test('a new relayed group topic controls memory selection and survives retry preparation', async (t) => {
  const { store, memory, engine } = await fixture(t);
  const bot = store.state.bots[0];
  const group = { id: 'grp_memory', name: 'Memory', adminId: bot.id, memberIds: [bot.id], replyMode: 'admin' };
  store.state.groups.push(group);
  const chatId = `group:${group.id}`;
  await store.appendMessage(chatId, { role: 'user', text: '咖啡' });
  await store.appendMessage(chatId, { role: 'relay', text: '购车预算', fromName: 'Rob' });
  const prepared = await engine.prepareGroupInput({ bot, chatId, text: '', kind: 'group' });
  assert.equal(prepared.memoryQuery, '购车预算');
  const retried = { ...prepared, text: 'Continue' };
  assert.equal(retried.memoryQuery, prepared.memoryQuery);
});

test('parallel remember completions never move a receipt or failure to another tool part', async (t) => {
  const { rpc, store, engine, memory } = await fixture(t);
  const bot = store.state.bots[0], chatId = `bot:${bot.id}`;
  let entered, release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const remember = memory.remember.bind(memory);
  memory.remember = async (scope, input) => {
    if (input.key === 'slow.topic') { entered(); await gate; }
    return remember(scope, input);
  };
  engine.agent = { async run(input, { onEvent }) {
    onEvent({ type: 'turn.started', sessionId: 'parallel-memory', turnId: 'turn-memory' });
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    const slow = call(rpc, 'remember', { caller_bot_id: bot.id, key: 'slow.topic', text: 'saved' });
    await enteredPromise;
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    const failed = await call(rpc, 'remember', { caller_bot_id: bot.id, key: 'other.topic', text: '字'.repeat(1201) });
    assert.equal(failed.isError, true);
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: false });
    release(); await slow;
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: true });
    return { status: 'finished', sessionId: 'parallel-memory', text: 'done' };
  } };
  const result = await engine.runBotTurn({ bot, chatId, text: 'Remember', kind: 'private' });
  const message = (await store.getMessages(chatId)).find((item) => item.id === result.messageId);
  const parts = message.parts.filter((part) => part.type === 'tool');
  assert.equal(parts[0].state, 'ok');
  assert.equal(parts[0].memoryReceipt.key, 'slow.topic');
  assert.equal(parts[0].issue, undefined);
  assert.equal(parts[1].memoryReceipt, undefined);
  assert.equal(parts[1].state, 'unknown');
});

test('a Host-only failure cannot borrow a delayed successful remember completion', async (t) => {
  const { rpc, store, engine } = await fixture(t);
  const bot = store.state.bots[0], chatId = `bot:${bot.id}`;
  engine.agent = { async run(input, { onEvent }) {
    onEvent({ type: 'turn.started', sessionId: 'host-memory', turnId: 'host-memory-turn' });
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    await call(rpc, 'remember', { caller_bot_id: bot.id, key: 'first.topic', text: 'saved' });
    onEvent({ type: 'tool.started', name: 'mcp__minimax-bot__remember' });
    // The second call fails before reaching MCP; finish events have no call IDs.
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: false });
    onEvent({ type: 'tool.finished', name: 'mcp__minimax-bot__remember', ok: true });
    return { status: 'finished', sessionId: 'host-memory', text: 'done' };
  } };
  const result = await engine.runBotTurn({ bot, chatId, text: 'Remember', kind: 'private' });
  const message = (await store.getMessages(chatId)).find((item) => item.id === result.messageId);
  const parts = message.parts.filter((part) => part.type === 'tool');
  assert.equal(parts[0].state, 'ok');
  assert.equal(parts[0].memoryReceipt.key, 'first.topic');
  assert.equal(parts[1].state, 'unknown');
  assert.equal(parts[1].memoryReceipt, undefined);
});
