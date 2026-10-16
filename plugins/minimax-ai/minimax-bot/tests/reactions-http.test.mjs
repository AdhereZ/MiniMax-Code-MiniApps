import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { start } from '../miniapp/node/server.mjs';

test('HTTP reactions persist, broadcast only reaction events and reject user messages', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bot-reactions-http-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const app = await start({
    pluginRoot: resolve(import.meta.dirname, '..'), dataDir,
    listen: { host: '127.0.0.1', port }, signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await app.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const chat = `bot:${state.bots[0].id}`;
  const url = `${base}/api/chats/${chat}/messages`;
  const { messages } = await (await fetch(url)).json();
  const events = await fetch(`${base}/api/events`);
  const reader = events.body.getReader();
  t.after(() => reader.cancel());
  await reader.read(); // hello
  const put = (id, body) => fetch(`${url}/${id}/reactions`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const response = await put(messages[0].id, { emoji: '🎉', selected: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.userReactions, ['🎉']);
  const frame = new TextDecoder().decode((await reader.read()).value);
  const event = JSON.parse(frame.trim().slice(6));
  assert.equal(event.type, 'message.reactions');
  assert.equal(event.chatId, chat);
  assert.equal(event.messageId, messages[0].id);
  assert.deepEqual((await (await fetch(url)).json()).messages[0].userReactions, ['🎉']);
  const replacement = await put(messages[0].id, { emoji: '❤️', selected: true });
  assert.deepEqual((await replacement.json()).userReactions, ['❤️']);
  const replacementFrame = new TextDecoder().decode((await reader.read()).value);
  const replacementEvent = JSON.parse(replacementFrame.trim().slice(6));
  assert.equal(replacementEvent.type, 'message.reactions');
  assert.deepEqual(replacementEvent.userReactions, ['❤️']);
  assert.deepEqual((await (await fetch(url)).json()).messages[0].userReactions, ['❤️']);
  const removal = await put(messages[0].id, { emoji: '❤️', selected: false });
  assert.deepEqual((await removal.json()).userReactions, []);
  assert.equal((await put(messages[0].id, null)).status, 400);
  assert.equal((await put('msg_missing', { emoji: '👍', selected: true })).status, 404);
  // No Agent is configured: sending still stores the user message, then reports the unavailable host.
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  const user = (await (await fetch(url)).json()).messages.find((m) => m.role === 'user');
  assert.ok(user);
  assert.equal((await put(user.id, { emoji: '👍', selected: true })).status, 400);
});
