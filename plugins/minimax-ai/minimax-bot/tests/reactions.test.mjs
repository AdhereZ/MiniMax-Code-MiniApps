import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../miniapp/node/store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-reactions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();
  const chat = store.chatIds()[0];
  const message = (await store.getMessages(chat))[0];
  return { dir, store, chat, message };
}

test('new selection replaces the old one, survives restart and ignores stale cancellation', async (t) => {
  const { dir, store, chat, message } = await fixture(t);
  await store.setUserReaction(chat, message.id, '👍', true);
  await store.setUserReaction(chat, message.id, '👍', true);
  assert.deepEqual(message.userReactions, ['👍']);
  await Promise.all(['❤️', '😂'].map((emoji) => store.setUserReaction(chat, message.id, emoji, true)));
  assert.deepEqual(message.userReactions, ['😂']);
  await store.setUserReaction(chat, message.id, '❤️', false);
  const restored = new Store(dir);
  await restored.init();
  assert.deepEqual((await restored.getMessages(chat))[0].userReactions, ['😂']);
  assert.equal(message.reactionsRevision, 5);
  await restored.setUserReaction(chat, message.id, '😂', false);
  await restored.setUserReaction(chat, message.id, '😂', false);
  assert.deepEqual((await restored.getMessages(chat))[0].userReactions, []);
  const reopened = new Store(dir);
  await reopened.init();
  assert.deepEqual((await reopened.getMessages(chat))[0].userReactions, []);
});

test('old multi-selection records retain only the last selection and never revive earlier ones', async (t) => {
  const { dir, store, chat, message } = await fixture(t);
  const path = store.messagePath(chat);
  const messages = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(messages[0], { userReactions: ['👍', '❤️', '😂'], reactionsRevision: 4 });
  await writeFile(path, JSON.stringify(messages));
  const restored = new Store(dir);
  await restored.init();
  assert.deepEqual((await restored.getMessages(chat))[0].userReactions, ['😂']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8'))[0].userReactions, ['😂']);
  await restored.setUserReaction(chat, message.id, '😂', false);
  assert.deepEqual((await restored.getMessages(chat))[0].userReactions, []);
});

test('reject non-bot/streaming/pass messages, unknown chats/messages and invalid input', async (t) => {
  const { store, chat, message } = await fixture(t);
  for (const partial of [{ role: 'user' }, { role: 'system' }, { role: 'relay' }, { role: 'bot', status: 'streaming' }, { role: 'bot', status: 'pass' }]) {
    const target = await store.appendMessage(chat, partial);
    await assert.rejects(store.setUserReaction(chat, target.id, '👍', true), { code: 'invalid' });
  }
  await assert.rejects(store.setUserReaction(chat, 'msg_missing', '👍', true), { code: 'not_found' });
  await assert.rejects(store.setUserReaction('bot:missing', message.id, '👍', true), { code: 'not_found' });
  for (const emoji of ['not-emoji', '<script>', '👍👍', null, {}, '']) {
    await assert.rejects(store.setUserReaction(chat, message.id, emoji, true), { code: 'invalid' });
  }
  await assert.rejects(store.setUserReaction(chat, message.id, '👍', 'true'), { code: 'invalid' });
  assert.equal(message.userReactions, undefined);
});

test('group bot messages work, do not alter message time or sidebar summary', async (t) => {
  const { store } = await fixture(t);
  store.state.groups.push({ id: 'grp_test' });
  const chat = 'group:grp_test';
  const message = await store.appendMessage(chat, { role: 'bot', text: 'Reply' });
  const before = store.summary(chat);
  await store.setUserReaction(chat, message.id, '🎉', true);
  assert.deepEqual(store.summary(chat), before);
  assert.deepEqual(message.userReactions, ['🎉']);
});

test('failed persistence leaves memory unchanged and the next request can recover', async (t) => {
  const { store, chat, message } = await fixture(t);
  await store.setUserReaction(chat, message.id, '👍', true);
  const original = store.messagePath.bind(store);
  store.messagePath = () => join(store.dir, 'absent', 'file.json');
  await assert.rejects(store.setUserReaction(chat, message.id, '❤️', true), { code: 'ENOENT' });
  assert.deepEqual(message.userReactions, ['👍']);
  assert.equal(message.reactionsRevision, 1);
  store.messagePath = original;
  await store.setUserReaction(chat, message.id, '❤️', true);
  assert.deepEqual(message.userReactions, ['❤️']);
});
