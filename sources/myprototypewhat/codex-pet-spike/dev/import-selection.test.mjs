import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the page's production handlers. Only browser/file/network boundaries are substituted.
const source = await readFile(new URL('../miniapp/client/pet-app.js', import.meta.url), 'utf8');
const selectionSource = source.slice(source.indexOf('function resetImport()'), source.indexOf('function startImportPreview('));
const submitSource = source.slice(source.indexOf('async function confirmImport()'), source.indexOf('// Rendering (inline panel)'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pet = (id) => ({ id, displayName: id, spritesheetPath: `${id}.webp` });
const files = (id, text = async () => JSON.stringify(pet(id))) => [{ name: 'pet.json', text }, { name: `${id}.webp`, size: 1 }];
function harness(overrides = {}) {
  const element = () => ({ textContent: '', hidden: false, disabled: false, dataset: {}, removeAttribute() {}, replaceChildren() {} });
  const els = Object.fromEntries(['importSprite', 'importPreview', 'importErrors', 'importStateText', 'importConfirm', 'importMsg', 'importName', 'importMeta', 'importPick', 'importInput', 'importCancel', 'galleryMsg'].map((name) => [name, element()]));
  const importState = { generation: 0, player: null, blobUrl: null, cycleTimer: null, busy: false, errors: [] };
  let blob = 0;
  const context = vm.createContext({
    importState, els, disposed: false, panelNavigation: null, app: { pets: [] }, ID_RE: /^[a-z0-9][a-z0-9._-]{0,79}$/, IMPORT_BODY_LIMIT: 12 * 1024 * 1024,
    clearInterval() {}, URL: { createObjectURL: () => `blob:${++blob}`, revokeObjectURL() {} },
    document: { createElement: () => ({ append() {} }) },
    setMsg: (el, text) => { el.textContent = text; }, basename: (value) => value.split(/[\\/]/).pop(),
    loadPetFromParts: async (value) => ({ ...value, version: 1 }), startImportPreview() {},
    fileToBase64: async () => 'aQ==', postPet: async () => ({ res: { ok: true, status: 200 }, data: { pet: pet('new') } }),
    refreshPets: async () => {}, selectPet: async () => {}, errCode: (error) => error?.message, console: { warn() {}, error() {} },
    ...overrides,
  });
  vm.runInContext(`${selectionSource}\n${submitSource}\nglobalThis.api = { handleImportFiles, resetImport, confirmImport };`, context);
  return { state: importState, els, context, ...context.api };
}

test('a late older JSON read cannot replace the latest selected pet', async () => {
  const h = harness(), slow = deferred();
  const older = h.handleImportFiles(files('old', () => slow.promise));
  await h.handleImportFiles(files('new'));
  slow.resolve(JSON.stringify(pet('old'))); await older;
  assert.equal(h.state.petJson.id, 'new');
  assert.equal(h.state.loaded.id, 'new');
  assert.equal(h.els.importName.textContent, 'new');
});

test('cancelling pending JSON invalidates both successful and failed old reads', async () => {
  for (const fail of [false, true]) {
    const h = harness(), slow = deferred();
    const pending = h.handleImportFiles(files('old', () => slow.promise));
    h.resetImport(); h.els.importMsg.textContent = '已取消导入';
    if (fail) slow.reject(new Error('bad JSON')); else slow.resolve(JSON.stringify(pet('old')));
    await pending;
    assert.equal(h.state.petJson, null);
    assert.equal(h.els.importPreview.hidden, true);
    assert.equal(h.els.importMsg.textContent, '已取消导入');
  }
});

test('an old image decode cannot paint over a new selection or report its failure', async () => {
  const slow = deferred(), started = deferred(), h = harness({ loadPetFromParts: (value) => {
    if (value.id === 'old') { started.resolve(); return slow.promise; }
    return Promise.resolve({ ...value, version: 1 });
  } });
  const older = h.handleImportFiles(files('old')); await started.promise;
  await h.handleImportFiles(files('new'));
  slow.reject(new Error('old decode failed')); await older;
  assert.equal(h.state.loaded.id, 'new');
  assert.equal(h.state.errors.length, 0);
});

test('submitting holds the selected files and disables replacement controls until completion', async () => {
  const slow = deferred(); let submitted;
  const h = harness({ postPet: (body) => { submitted = body; return slow.promise; } });
  await h.handleImportFiles(files('old'));
  const submitting = h.confirmImport(); await Promise.resolve();
  assert.equal(h.state.busy, true);
  for (const name of ['importConfirm', 'importCancel', 'importInput', 'importPick']) assert.equal(h.els[name].disabled, true);
  await h.handleImportFiles(files('new'));
  assert.equal(h.state.petJson.id, 'old');
  assert.equal(submitted.petJson.id, 'old');
  slow.resolve({ res: { ok: true, status: 200 }, data: { pet: pet('old') } });
  await submitting;
  assert.equal(h.state.busy, false);
  assert.equal(h.els.importPick.disabled, false);
  assert.match(h.els.importMsg.textContent, /导入成功/);
  assert.match(h.els.galleryMsg.textContent, /导入成功/);
});

test('a failed upload releases controls without discarding the selected preview', async () => {
  const h = harness({ postPet: async () => { throw new Error('network failed'); } });
  await h.handleImportFiles(files('old')); await h.confirmImport();
  assert.equal(h.state.busy, false);
  assert.equal(h.state.loaded.id, 'old');
  assert.equal(h.els.importConfirm.disabled, false);
  assert.match(h.els.importMsg.textContent, /导入失败/);
});
