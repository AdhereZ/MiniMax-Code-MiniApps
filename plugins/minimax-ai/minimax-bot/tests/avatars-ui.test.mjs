import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div class="app"><main id="main"></main><aside id="drawer"></aside></div><div id="overlay-root"></div><div id="toast" hidden></div>', { url: 'http://localhost/bot' });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'FormData']) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
window.matchMedia = () => ({ matches: false });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
// jsdom cannot decode or crop images. Real Chrome validation exercises the actual image pipeline.
const revoked = [];
URL.createObjectURL = (file) => file.name;
URL.revokeObjectURL = (url) => revoked.push(url);
globalThis.Image = class {
  naturalWidth = 1024; naturalHeight = 512;
  async decode() { if (this.src === 'broken.png') throw new Error('decode failed'); }
};
dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
let nextImage = 0;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => `data:image/webp;base64,${btoa(`image-${++nextImage}`)}`;
const { state } = await import('../miniapp/client/core.js');
const { setLocale } = await import('../miniapp/client/i18n.js');
const { renderDrawer, openOverlay, closeOverlay } = await import('../miniapp/client/panels.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let requests, library, uploadFailure;
const success = (data) => ({ ok: true, json: async () => data });
beforeEach(() => {
  closeOverlay(); setLocale('en');
  requests = []; library = ['saved.png']; uploadFailure = false;
  state.bots = [{ id: 'b1', name: 'Chief', skin: 'bubble', isMain: true }]; state.current = 'bot:b1';
  state.drawer = { open: true, view: 'settings', memTab: 'self', dirty: false };
  document.getElementById('drawer').replaceChildren();
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET'; const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method, body });
    if (url === '/api/avatars' && method === 'GET') return success({ avatars: [...library] });
    if (url === '/api/avatars') {
      if (uploadFailure) { uploadFailure = false; return { ok: false, json: async () => ({ message: 'Disk full' }) }; }
      const avatar = `import-${library.length}.webp`; library.push(avatar); return success({ avatar });
    }
    if (url === '/api/bots') return success({ bot: { id: 'b2', ...body } });
    if (url === '/api/models') return success({ models: [] });
    if (url.includes('/api/usage')) return success({ byBot: [] });
    return success({});
  };
});
const picker = () => document.querySelector('.avatar-picker');
const custom = () => [...picker().querySelectorAll('input[data-avatar]')];
const upload = (names) => {
  const input = picker().querySelector('[type="file"]');
  Object.defineProperty(input, 'files', { configurable: true, value: names.map((name) => new dom.window.File(['image'], name, { type: name.endsWith('.txt') ? 'text/plain' : 'image/png' })) });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const submit = () => picker().closest('form').dispatchEvent(new window.Event('submit', { cancelable: true }));

test('saved images remain selectable after built-in switches, reopening and creating another Bot', async () => {
  renderDrawer(); await tick();
  custom()[0].click();
  picker().querySelector('[value="gold"]').click();
  assert.equal(custom().length, 1);
  custom()[0].click(); submit(); await tick();
  assert.equal(requests.find((r) => r.method === 'PATCH').body.avatar, 'saved.png');
  state.drawer = { ...state.drawer, view: 'settings', dirty: false }; renderDrawer(); await tick();
  assert.equal(custom().length, 1);
  state.drawer.open = false; renderDrawer();
  openOverlay({ kind: 'create-bot', name: 'New Bot' }); await tick();
  custom()[0].click(); submit(); await tick();
  assert.equal(requests.find((r) => r.url === '/api/bots').body.avatar, 'saved.png', 'live creation preview must not swallow the selected avatar');
});

test('batch import keeps successful files, reports individual failures and blocks an early form save', async () => {
  renderDrawer(); await tick();
  assert.equal(picker().querySelector('[type="file"]').multiple, true);
  let release;
  const originalFetch = fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/avatars' && options.method === 'POST' && !release) await new Promise((resolve) => { release = resolve; });
    return originalFetch(url, options);
  };
  uploadFailure = true;
  upload(['good-but-disk-full.png', 'broken.png', 'wrong.txt', 'good.png', 'another.png']);
  await tick();
  assert.equal(picker().closest('form').querySelector('[type="submit"]').disabled, true);
  submit(); assert.equal(requests.filter((r) => r.method === 'PATCH').length, 0);
  release(); await tick(); await tick();
  assert.equal(picker().disabled, false);
  assert.equal(custom().length, 3);
  assert.equal(picker().querySelectorAll('.avatar-errors li').length, 3);
  assert.match(picker().textContent, /Added 2\/5/);
  assert.match(picker().textContent, /good-but-disk-full.png: Disk full/);
  assert.ok(revoked.includes('broken.png'));
  assert.equal(custom().filter((el) => el.checked).length, 1);
  assert.equal(custom().find((el) => el.checked).value, 'import-1.webp');
  submit(); await tick();
  assert.equal(requests.find((r) => r.method === 'PATCH').body.avatar, 'import-1.webp');
  state.drawer = { ...state.drawer, view: 'settings', dirty: false }; renderDrawer(); await tick();
  assert.equal(custom().length, 3);
});

test('late library responses preserve imported entries and a pending import cannot dirty a different Bot form', async () => {
  const originalFetch = fetch;
  let resolveLibrary;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/avatars' && (!options.method || options.method === 'GET') && !resolveLibrary) return new Promise((resolve) => { resolveLibrary = resolve; });
    return originalFetch(url, options);
  };
  renderDrawer(); upload(['first.png']); await tick();
  resolveLibrary(success({ avatars: ['saved.png'] })); await tick();
  assert.deepEqual(custom().map((el) => el.value), ['import-1.webp', 'saved.png']);
  let release;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/avatars' && options.method === 'POST') await new Promise((resolve) => { release = resolve; });
    return originalFetch(url, options);
  };
  upload(['later.png']); await tick();
  state.bots.push({ id: 'b2', name: 'Other', skin: 'gold' }); state.current = 'bot:b2';
  state.drawer.dirty = false; renderDrawer(); await tick();
  release(); await tick();
  assert.equal(state.drawer.dirty, false);
  assert.equal(custom().some((el) => el.checked), false);
});

test('library read failures offer a retry without losing the current avatar', async () => {
  state.bots[0].avatar = 'old.png';
  const originalFetch = fetch;
  globalThis.fetch = async (url, options) => url === '/api/avatars' ? { ok: false, json: async () => ({ message: 'Unavailable' }) } : originalFetch(url, options);
  renderDrawer(); await tick();
  assert.equal(custom()[0].checked, true);
  assert.match(picker().textContent, /Could not load/);
  globalThis.fetch = originalFetch;
  picker().querySelector('button').click(); await tick();
  assert.equal(custom().length, 2);
  assert.equal(custom()[0].checked, true);
  assert.equal(picker().querySelector('button').hidden, true);
});
