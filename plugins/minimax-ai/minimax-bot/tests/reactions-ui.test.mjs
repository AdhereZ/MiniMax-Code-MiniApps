import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="toast" hidden></div><main></main>', { url: 'http://localhost/bot' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
// jsdom has no top-layer implementation; real browser validation covers light-dismiss/position.
dom.window.HTMLElement.prototype.showPopover = function () {};
const { state, clearMessages } = await import('../miniapp/client/core.js');
const { setLocale } = await import('../miniapp/client/i18n.js');
const { reactionButton, reactionBar, applyReactionUpdate, closeReactionPicker } = await import('../miniapp/client/reactions.js');
setLocale('en');
const main = document.querySelector('main');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount() {
  closeReactionPicker();
  clearMessages();
  const m = { id: 'msg_test', chatId: 'bot:bot_test', role: 'bot', status: 'done', userReactions: [] };
  state.messages.set(m.chatId, [m]);
  main.replaceChildren(reactionBar(m), reactionButton(m));
  return m;
}

test('only bot messages expose a reaction action', () => {
  for (const role of ['user', 'relay', 'system']) assert.equal(reactionButton({ role }), null);
  assert.equal(reactionButton({ role: 'bot', status: 'streaming' }), null);
});

test('quick select, more picker, bilingual search, empty results, Escape and removal', async () => {
  const m = mount();
  let revision = 0;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => ({ messageId: m.id, userReactions: body.selected ? [body.emoji] : [], reactionsRevision: ++revision }) };
  };
  main.querySelector('.reaction-trigger').click();
  const quick = document.querySelectorAll('.emoji-quick [data-emoji]');
  assert.deepEqual([...quick].map((el) => el.dataset.emoji), ['👍', '❤️', '🙌', '😂', '😭', '😮']);
  quick[0].click();
  await tick();
  assert.deepEqual(m.userReactions, ['👍']);
  assert.equal(main.querySelector('.reaction-chip').textContent, '👍');
  assert.equal(document.querySelector('.reaction-picker'), null);
  main.querySelector('.reaction-trigger').click();
  document.querySelector('.emoji-quick [data-emoji="❤️"]').click();
  await tick();
  assert.deepEqual(m.userReactions, ['❤️']);
  assert.deepEqual([...main.querySelectorAll('.reaction-chip')].map((b) => b.textContent), ['❤️']);
  main.querySelector('.reaction-trigger').click();
  assert.equal(document.querySelectorAll('.emoji-quick [aria-pressed="true"]').length, 1);
  document.querySelector('.emoji-quick [data-emoji="❤️"]').click();
  await tick();
  assert.deepEqual(m.userReactions, []);
  assert.deepEqual(calls, [{ emoji: '👍', selected: true }, { emoji: '❤️', selected: true }, { emoji: '❤️', selected: false }]);
  main.querySelector('.reaction-trigger').click();
  document.querySelector('[aria-label="More emoji"]').click();
  const search = document.querySelector('input');
  document.querySelector('[data-category="gestures"]').click();
  assert.ok(document.querySelector('.emoji-grid [data-emoji="👍"]'));
  assert.equal(document.querySelector('.emoji-grid [data-emoji="😀"]'), null);
  for (const query of ['庆祝', 'celebrate']) {
    search.value = query;
    search.dispatchEvent(new window.Event('input'));
    assert.ok([...document.querySelectorAll('.emoji-grid button')].some((b) => b.dataset.emoji === '🎉'));
    assert.equal(document.querySelectorAll('.emoji-results h3').length, 1);
  }
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement, document.querySelector('.emoji-grid button'));
  const firstResult = document.activeElement;
  firstResult.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.notEqual(document.activeElement, firstResult);
  document.querySelector('[aria-label="Back to quick reactions"]').click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'More emoji');
  assert.equal(document.querySelector('input'), null);
  document.activeElement.click();
  const newSearch = document.querySelector('input');
  newSearch.value = 'no such emoji';
  newSearch.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelector('.emoji-results [role="status"]').textContent, 'No emoji found');
  newSearch.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.reaction-picker'), null);
  assert.equal(document.activeElement, main.querySelector('.reaction-trigger'));
});

test('legacy multi-selection displays only the latest and lets an earlier emoji replace it', async () => {
  const m = mount();
  applyReactionUpdate({ chatId: m.chatId, messageId: m.id, userReactions: ['👍', '❤️'], reactionsRevision: 1 });
  assert.deepEqual([...main.querySelectorAll('.reaction-chip')].map((b) => b.textContent), ['❤️']);
  main.querySelector('.reaction-trigger').click();
  assert.equal(document.querySelector('.emoji-quick [data-emoji="👍"]').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.emoji-quick [data-emoji="❤️"]').getAttribute('aria-pressed'), 'true');
  document.querySelector('[aria-label="More emoji"]').click();
  globalThis.fetch = async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { emoji: '👍', selected: true });
    return { ok: true, json: async () => ({ messageId: m.id, userReactions: ['👍'], reactionsRevision: 2 }) };
  };
  document.querySelector('.emoji-grid [data-emoji="👍"]').click();
  await tick();
  assert.deepEqual([...main.querySelectorAll('.reaction-chip')].map((b) => b.textContent), ['👍']);
  assert.equal(document.querySelector('.reaction-picker'), null);
  globalThis.fetch = async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { emoji: '👍', selected: false });
    return { ok: true, json: async () => ({ messageId: m.id, userReactions: [], reactionsRevision: 3 }) };
  };
  main.querySelector('.reaction-chip').click();
  await tick();
  assert.equal(main.querySelector('.reaction-chip'), null);
});

test('failed replacement preserves selection and permits retry; duplicate clicks send once', async () => {
  const m = mount();
  applyReactionUpdate({ chatId: m.chatId, messageId: m.id, userReactions: ['❤️'], reactionsRevision: 1 });
  let reject;
  let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise((_, r) => { reject = r; }); };
  main.querySelector('.reaction-trigger').click();
  const button = document.querySelector('[data-emoji="👍"]');
  button.click();
  button.click();
  assert.equal(calls, 1);
  reject(new Error('offline'));
  await tick();
  assert.deepEqual(m.userReactions, ['❤️']);
  assert.equal(main.querySelector('.reaction-chip').textContent, '❤️');
  assert.equal(document.querySelector('#toast').hidden, false);
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  applyReactionUpdate({ chatId: m.chatId, messageId: m.id, userReactions: ['😂'], reactionsRevision: 2 });
  assert.equal(document.querySelector('.emoji-quick [data-emoji="❤️"]').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('.emoji-quick [data-emoji="😂"]').getAttribute('aria-pressed'), 'true');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ messageId: m.id, userReactions: ['👍'], reactionsRevision: 3 }) });
  button.click();
  await tick();
  assert.deepEqual(m.userReactions, ['👍']);
  assert.equal(document.querySelector('.reaction-picker'), null);
});

test('SSE updates badges without replacing message content; stale HTTP response is ignored', () => {
  const m = mount();
  applyReactionUpdate({ chatId: m.chatId, messageId: m.id, userReactions: ['❤️'], reactionsRevision: 2 });
  applyReactionUpdate({ chatId: m.chatId, messageId: m.id, userReactions: ['👍'], reactionsRevision: 1 });
  assert.deepEqual(m.userReactions, ['❤️']);
  assert.equal(main.querySelector('.reaction-chip').dataset.emoji, '❤️');
});
