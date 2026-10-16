import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<main></main>', { url: 'http://localhost/bot' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { setLocale } = await import('../miniapp/client/i18n.js');
const { toolFailureNode } = await import('../miniapp/client/tool-feedback.js');
setLocale('en');
const failure = () => ({ type: 'tool', name: 'mcp__minimax-bot__remember', state: 'failed' });

test('an unlinked later success stays uncertain, with historical capacity and the precise shortfall', () => {
  setLocale('en');
  const failed = { ...failure(), issue: { code: 'memory_full', remaining: 40, needed: 113 } };
  const node = toolFailureNode(failed, [failed, { ...failure(), state: 'ok' }], 'remember');
  document.querySelector('main').replaceChildren(node);
  assert.match(node.querySelector('summary').textContent, /a later call succeeded/);
  assert.match(node.querySelector('summary').textContent, /cannot be linked/);
  assert.doesNotMatch(node.querySelector('summary').textContent, /40/);
  assert.match(node.textContent, /At that time: 40 remaining; this write would add 113, exceeding the limit by 73/);
  const details = node.querySelector('details');
  assert.equal(details.open, false);
  node.querySelector('summary').click();
  assert.equal(details.open, true);
});

test('memory failures explain their impact and offer recovery before expanding technical history', () => {
  setLocale('en');
  for (const issue of [
    { code: 'memory_too_long', actual: 354, max: 300 },
    { code: 'memory_full', remaining: 2, needed: 50 },
  ]) {
    let opened = false;
    const failed = { ...failure(), issue };
    const node = toolFailureNode(failed, [failed], 'remember', undefined, () => { opened = true; });
    document.querySelector('main').replaceChildren(node);
    const details = node.querySelector('details');
    assert.equal(details.open, false);
    assert.match(details.querySelector('summary').textContent, /did not succeed/);
    assert.doesNotMatch(details.querySelector('summary').textContent, /mcp__minimax-bot/);
    assert.equal(details.querySelector('code').textContent, failed.name);
    const manage = node.querySelector('button');
    assert.equal(manage.textContent, 'Manage memory');
    assert.equal(manage.closest('details'), null);
    manage.click();
    assert.equal(opened, true);
    assert.equal(details.open, false);
  }
});

test('a confirmed later save identifies the same scope and topic without claiming identical saved text', () => {
  setLocale('en');
  for (const identity of [{ key: 'car.requirements' }, { entryId: '123abcde' }]) {
    const failed = { ...failure(), issue: { code: 'memory_full', remaining: 40, needed: 113, shortfall: 73, scope: 'team', ...identity } };
    for (const outcome of ['created', 'updated', 'saved', 'unchanged']) {
      const later = { ...failure(), state: 'ok', memoryReceipt: { scope: 'team', entryId: '123abcde', ...identity, revision: 'v2', outcome } };
      const node = toolFailureNode(failed, [failed, later], 'remember', undefined, () => {});
      assert.equal(node.querySelector('summary').textContent, 'This topic was saved or updated in a later call');
      assert.match(node.textContent, /does not mean the original failed text was saved verbatim/);
      assert.match(node.textContent, /At that time: 40 remaining/);
      assert.equal(node.querySelector('button'), null);
    }
  }
});

test('cross-scope, other topics and legacy failures cannot be resolved by the same tool name', () => {
  setLocale('zh');
  const issue = { code: 'memory_conflict', scope: 'team', key: 'car.requirements' };
  for (const [failedIssue, receipt] of [
    [issue, { scope: 'bot_a', key: issue.key }],
    [issue, { scope: 'team', key: 'reply.preferences' }],
    [{ code: 'memory_conflict' }, { scope: 'team', key: issue.key }],
  ]) {
    const failed = { ...failure(), issue: failedIssue };
    const later = { ...failure(), state: 'ok', memoryReceipt: { ...receipt, entryId: '123abcde', revision: 'v2', outcome: 'updated' } };
    const node = toolFailureNode(failed, [failed, later], '记忆');
    assert.match(node.querySelector('summary').textContent, /无法确认对应这条/);
    assert.doesNotMatch(node.querySelector('summary').textContent, /该主题后续已保存/);
    assert.match(node.textContent, /当时该主题已被其他操作更新/);
  }
});

test('Chinese recovery is topic-specific and entry-count rejection does not claim a zero character shortfall', () => {
  setLocale('zh');
  const failed = { ...failure(), issue: { code: 'memory_full', scope: 'team', key: 'car.requirements', remaining: 90000, needed: 100, shortfall: 0, entryLimit: 1000, entryShortfall: 1 } };
  const first = toolFailureNode(failed, [failed], '记忆');
  assert.match(first.querySelector('summary').textContent, /超过 1000 条记忆的上限，超出 1 条/);
  assert.doesNotMatch(first.textContent, /超出 0 字符/);
  const later = { ...failure(), state: 'ok', memoryReceipt: { scope: 'team', key: 'car.requirements', entryId: 'abcd1234', revision: 'v2', outcome: 'updated' } };
  const node = toolFailureNode(failed, [failed, later], '记忆');
  assert.equal(node.querySelector('summary').textContent, '该主题后续已保存或更新');
  assert.match(node.textContent, /不代表先前失败的原文逐字保存/);
  const missing = { ...failure(), issue: { code: 'memory_topic_required', scope: 'team' } };
  assert.match(toolFailureNode(missing, [missing], '记忆').textContent, /缺少稳定的主题标识/);
});

test('an earlier success, another tool and a pending call do not resolve a later failure', () => {
  setLocale('en');
  const failed = failure();
  for (const parts of [
    [{ ...failed, state: 'ok' }, failed],
    [failed, { ...failed, name: 'other', state: 'ok' }],
    [failed, { ...failed, state: 'running' }],
  ]) {
    const node = toolFailureNode(failed, parts, 'remember');
    assert.equal(node.querySelector('summary').textContent, 'remember failed');
    assert.match(node.textContent, /did not provide the error details/);
  }
});

test('legacy messages, unsupported hosts and untrusted error text remain readable and safe in Chinese', () => {
  setLocale('zh');
  const failed = { ...failure(), issue: { code: '<script>alert(1)</script>' } };
  const node = toolFailureNode(failed, [failed], 'remember', 'session');
  assert.equal(node.querySelector('script'), null);
  assert.equal(node.querySelector('button'), null);
  assert.match(node.textContent, /未提供/);
});
