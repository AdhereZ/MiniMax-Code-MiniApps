// @ts-check
// Single owner of MoMo collaboration state. Every mutation goes through `commit`, which applies the
// change in memory, persists atomically, records telemetry, and only then notifies listeners.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TASK_STATUSES = /** @type {const} */ (['todo', 'in_progress', 'pending_review', 'done']);
export const BLOCKED_REASONS = /** @type {const} */ (['need_approval', 'need_info', 'run_failed', 'project_unavailable']);
export const GATE_KEYS = /** @type {const} */ (['objective', 'deliverable', 'done_criteria']);
export const GATE_LABELS = { objective: '做什么', deliverable: '产出什么', done_criteria: '怎么算做完' };
export const RECORD_SOURCES = /** @type {const} */ (['chat', 'quick_capture', 'session_handoff', 'session_return', 'review']);

const TEXT_MAX = 20_000;
const TITLE_MAX = 80;

export class DomainError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

/** @param {unknown} value @param {string} label @param {number} [max] */
export function cleanText(value, label, max = TEXT_MAX) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DomainError('invalid', `${label}不能为空`);
  if (text.length > max) throw new DomainError('invalid', `${label}超过 ${max} 字`);
  return text;
}

/** @param {unknown} value */
function optionalText(value, max = TEXT_MAX) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, max) : undefined;
}

function emptyState() {
  return {
    version: 1,
    ideas: /** @type {Record<string, any>} */ ({}),
    records: /** @type {Record<string, any>} */ ({}),
    tasks: /** @type {Record<string, any>} */ ({}),
    chat: /** @type {any[]} */ ([]),
    activity: /** @type {number[]} */ ([]),
    settings: { momoColor: 'sky', avatarUploadId: null, lastSeenAt: 0 },
    momoSession: { sessionId: null, runs: 0 },
  };
}

export class Store {
  /** @param {string} dataDir @param {{ info: Function, warn: Function, error: Function }} logger */
  constructor(dataDir, logger) {
    this.dir = dataDir;
    this.file = join(dataDir, 'state.json');
    this.telemetryFile = join(dataDir, 'telemetry.jsonl');
    this.logger = logger;
    this.state = emptyState();
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
    /** @type {Set<(state: any) => void>} */
    this.listeners = new Set();
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.state = { ...emptyState(), ...raw, settings: { ...emptyState().settings, ...raw.settings } };
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of overwriting the user's data.
        const aside = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, aside).catch(() => {});
        this.logger.error('momo.state_unreadable', { aside });
      }
    }
  }

  /** @param {(state: any) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Serializes one mutation: apply, persist, telemetry, then notify. A failed write rolls the
   * in-memory state back so memory never runs ahead of disk.
   * @template T
   * @param {(state: ReturnType<typeof emptyState>, emit: (event: string, fields: Record<string, unknown>) => void) => T} mutate
   * @returns {Promise<T>}
   */
  commit(mutate) {
    const run = async () => {
      const before = JSON.stringify(this.state);
      /** @type {{ event: string, fields: Record<string, unknown> }[]} */
      const events = [];
      let result;
      try {
        result = mutate(this.state, (event, fields) => events.push({ event, fields }));
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.state));
        await rename(temp, this.file);
      } catch (error) {
        this.state = JSON.parse(before);
        throw error;
      }
      if (events.length) await this.track(events);
      for (const listener of this.listeners) {
        try {
          listener(this.state);
        } catch {
          /* a listener failure never undoes a committed change */
        }
      }
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /** @param {{ event: string, fields: Record<string, unknown> }[]} events */
  async track(events) {
    const lines = events.map(({ event, fields }) => JSON.stringify({ event, ts: Date.now(), ...fields })).join('\n');
    await appendFile(this.telemetryFile, `${lines}\n`).catch((error) =>
      this.logger.warn('momo.telemetry_write_failed', { code: String(error?.code ?? '') }),
    );
  }

  async readTelemetry() {
    try {
      return (await readFile(this.telemetryFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- reads

  /** @param {string} id */
  idea(id) {
    const idea = this.state.ideas[id];
    if (!idea || idea.deleted) throw new DomainError('not_found', `想法 ${id} 不存在`);
    return idea;
  }

  /** @param {string} id */
  task(id) {
    const task = this.state.tasks[id];
    if (!task) throw new DomainError('not_found', `任务 ${id} 不存在`);
    return task;
  }

  /** @param {string} id */
  record(id) {
    const record = this.state.records[id];
    if (!record) throw new DomainError('not_found', `记录 ${id} 不存在`);
    return record;
  }

  liveIdeas() {
    return Object.values(this.state.ideas).filter((idea) => !idea.deleted);
  }

  /** Resolves an idea by id or exact (case-insensitive) title. @param {string} ref */
  findIdea(ref) {
    const key = String(ref ?? '').trim();
    if (!key) return undefined;
    if (this.state.ideas[key] && !this.state.ideas[key].deleted) return this.state.ideas[key];
    const lower = key.toLowerCase();
    return this.liveIdeas().find((idea) => idea.title.toLowerCase() === lower);
  }

  /** @param {any} idea */
  gateProgress(idea) {
    const missing = GATE_KEYS.filter((key) => !idea.gates[key]?.text);
    return { filled: GATE_KEYS.length - missing.length, missing: missing.map((key) => GATE_LABELS[key]) };
  }

  /** @param {string} ideaId */
  recordsOf(ideaId) {
    return Object.values(this.state.records)
      .filter((record) => record.ideaId === ideaId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** @param {string} ideaId */
  tasksOf(ideaId) {
    return Object.values(this.state.tasks)
      .filter((task) => task.ideaId === ideaId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---------------------------------------------------------------- ideas & records

  /** @param {any} state @param {string} title @param {'user'|'momo'} actor @param {Function} emit */
  static createIdeaIn(state, title, actor, emit) {
    const now = Date.now();
    const idea = {
      id: newId('idea'),
      title: cleanText(title, '想法名', TITLE_MAX),
      createdAt: now,
      updatedAt: now,
      gates: { objective: null, deliverable: null, done_criteria: null },
      facts: [],
      deleted: false,
    };
    state.ideas[idea.id] = idea;
    emit('idea_change', { idea_id: idea.id, action: 'create', actor });
    return idea;
  }

  /**
   * Adds a record. `target` is an idea id, `{ newIdeaTitle }`, or null for unattributed.
   * @param {{ text: string, target: string | { newIdeaTitle: string } | null, source: string,
   *   certainty?: 'inferred' | 'confirmed', attribution?: 'inferred' | 'confirmed', originTitle?: string,
   *   originSessionId?: string, images?: { id: string, name: string }[], userActivity?: boolean }} input
   */
  addRecord(input) {
    if (!RECORD_SOURCES.includes(/** @type {any} */ (input.source))) throw new DomainError('invalid', '记录来源无效');
    const text = input.text ? cleanText(input.text, '记录内容') : '';
    const images = (input.images ?? []).slice(0, 9);
    if (!text && !images.length) throw new DomainError('invalid', '记录内容不能为空');
    return this.commit((state, emit) => {
      let ideaId = null;
      let createdIdea = false;
      if (input.target && typeof input.target === 'object') {
        const existing = this.findIdea(input.target.newIdeaTitle);
        if (existing) ideaId = existing.id;
        else {
          ideaId = Store.createIdeaIn(state, input.target.newIdeaTitle, 'momo', emit).id;
          createdIdea = true;
        }
      } else if (typeof input.target === 'string') {
        ideaId = this.idea(input.target).id;
      }
      const now = Date.now();
      const record = {
        id: newId('rec'),
        ideaId,
        text,
        images,
        source: input.source,
        certainty: input.certainty ?? 'confirmed',
        attribution: ideaId ? (input.attribution ?? 'inferred') : 'inferred',
        originTitle: optionalText(input.originTitle, 120),
        originSessionId: optionalText(input.originSessionId, 128),
        movedFrom: null,
        createdAt: now,
      };
      state.records[record.id] = record;
      if (ideaId) state.ideas[ideaId].updatedAt = now;
      if (input.userActivity !== false) state.activity.push(now);
      emit('idea_record_add', {
        idea_id: ideaId ?? '',
        record_id: record.id,
        source: input.source,
        material_types: [text ? 'text' : '', images.length ? 'image' : ''].filter(Boolean),
        text_length: text.length,
        image_count: images.length,
        attribution_type: !ideaId ? 'unattributed' : createdIdea ? 'new' : 'supplement',
        certainty: record.certainty,
      });
      if (ideaId && record.attribution === 'inferred') emit('idea_fact_infer', { idea_id: ideaId, fact_type: 'attribution' });
      return { record, idea: ideaId ? state.ideas[ideaId] : null, createdIdea };
    });
  }

  /** @param {string} recordId @param {string | { newIdeaTitle: string }} target */
  moveRecord(recordId, target) {
    return this.commit((state, emit) => {
      const record = this.record(recordId);
      const from = record.ideaId ? state.ideas[record.ideaId] : null;
      let to;
      let createdIdea = false;
      if (typeof target === 'object') {
        to = this.findIdea(target.newIdeaTitle);
        if (!to) {
          to = Store.createIdeaIn(state, target.newIdeaTitle, 'user', emit);
          createdIdea = true;
        }
      } else to = this.idea(target);
      record.movedFrom = from ? { ideaId: from.id, title: from.title } : { ideaId: null, title: '未归属' };
      record.ideaId = to.id;
      record.attribution = 'confirmed';
      to.updatedAt = Date.now();
      state.activity.push(Date.now());
      emit('idea_fact_revise', { idea_id: to.id, fact_type: 'attribution', revise_type: from ? 'correct' : 'confirm' });
      return { record, idea: to, from, createdIdea };
    });
  }

  /** @param {string} recordId */
  confirmRecord(recordId) {
    return this.commit((state, emit) => {
      const record = this.record(recordId);
      if (record.ideaId) record.attribution = 'confirmed';
      record.certainty = 'confirmed';
      emit('idea_fact_revise', { idea_id: record.ideaId ?? '', fact_type: 'record', revise_type: 'confirm' });
      return record;
    });
  }

  /** @param {string} recordId */
  deleteRecord(recordId) {
    return this.commit((state) => {
      const record = this.record(recordId);
      delete state.records[recordId];
      return record;
    });
  }

  /** @param {string} ideaId @param {'user'|'momo'} actor */
  deleteIdea(ideaId, actor) {
    return this.commit((state, emit) => {
      const idea = this.idea(ideaId);
      idea.deleted = true;
      idea.updatedAt = Date.now();
      // Records keep their text; they fall back to unattributed so nothing the user said is lost.
      for (const record of Object.values(state.records)) {
        if (record.ideaId === ideaId) {
          record.movedFrom = { ideaId, title: idea.title };
          record.ideaId = null;
          record.attribution = 'inferred';
        }
      }
      emit('idea_change', { idea_id: ideaId, action: 'delete', actor });
      const keptTasks = Object.values(state.tasks).filter((task) => task.ideaId === ideaId);
      return { idea, keptTasks };
    });
  }

  /** @param {string} ideaId @param {string} title */
  renameIdea(ideaId, title) {
    return this.commit(() => {
      const idea = this.idea(ideaId);
      idea.title = cleanText(title, '想法名', TITLE_MAX);
      idea.updatedAt = Date.now();
      return idea;
    });
  }

  /**
   * Updates gates. Confirmed gates are only changed when `userOverride` is set (the user explicitly
   * overturned them); MoMo's own inferences never overwrite what the user confirmed.
   * @param {string} ideaId
   * @param {Partial<Record<typeof GATE_KEYS[number], string>>} values
   * @param {{ confirmed?: boolean, userOverride?: boolean }} options
   */
  updateGates(ideaId, values, options = {}) {
    return this.commit((state, emit) => {
      const idea = this.idea(ideaId);
      const refused = [];
      const changed = [];
      for (const key of GATE_KEYS) {
        const raw = values[key];
        if (raw === undefined || raw === null) continue;
        const text = cleanText(raw, GATE_LABELS[key], 2000);
        const current = idea.gates[key];
        if (current?.certainty === 'confirmed' && !options.userOverride && current.text !== text) {
          refused.push(GATE_LABELS[key]);
          continue;
        }
        const certainty = options.confirmed || options.userOverride ? 'confirmed' : 'inferred';
        if (current && current.text !== text) {
          emit('idea_fact_revise', {
            idea_id: idea.id,
            fact_type: 'gate',
            revise_type: current.certainty === 'confirmed' ? 'overturn' : 'correct',
          });
        } else if (current && certainty === 'confirmed' && current.certainty !== 'confirmed') {
          emit('idea_fact_revise', { idea_id: idea.id, fact_type: 'gate', revise_type: 'confirm' });
        }
        idea.gates[key] = { text, certainty, updatedAt: Date.now() };
        if (certainty === 'inferred') emit('idea_fact_infer', { idea_id: idea.id, fact_type: 'gate' });
        changed.push(GATE_LABELS[key]);
      }
      idea.updatedAt = Date.now();
      return { idea, changed, refused, progress: this.gateProgress(idea) };
    });
  }

  /** Agreeing to start a task confirms the gates MoMo inferred for its idea. @param {string} ideaId */
  confirmInferredGates(ideaId) {
    return this.commit((state, emit) => {
      const idea = state.ideas[ideaId];
      if (!idea || idea.deleted) return;
      for (const key of GATE_KEYS) {
        const gate = idea.gates[key];
        if (gate && gate.certainty !== 'confirmed') {
          gate.certainty = 'confirmed';
          emit('idea_fact_revise', { idea_id: idea.id, fact_type: 'gate', revise_type: 'confirm' });
        }
      }
    });
  }

  /** @param {string} ideaId @param {string} text @param {boolean} confirmed */
  addFact(ideaId, text, confirmed) {
    return this.commit((_state, emit) => {
      const idea = this.idea(ideaId);
      const fact = { id: newId('fact'), text: cleanText(text, '内容', 2000), certainty: confirmed ? 'confirmed' : 'inferred', createdAt: Date.now() };
      idea.facts.push(fact);
      if (!confirmed) emit('idea_fact_infer', { idea_id: idea.id, fact_type: 'record' });
      idea.updatedAt = Date.now();
      return { idea, fact };
    });
  }

  /**
   * @param {string} ideaId
   * @param {{ kind: 'gate' | 'fact', id: string, text?: string }} item
   * @param {'confirm' | 'correct' | 'remove'} action
   * @param {{ userOverride?: boolean }} options
   */
  reviseItem(ideaId, item, action, options = {}) {
    return this.commit((state, emit) => {
      const idea = this.idea(ideaId);
      /** @type {any} */
      let target;
      if (item.kind === 'gate') {
        if (!GATE_KEYS.includes(/** @type {any} */ (item.id))) throw new DomainError('invalid', '门槛名称无效');
        target = idea.gates[item.id];
        if (!target && action !== 'correct') throw new DomainError('not_found', '该门槛还没有内容');
      } else {
        target = idea.facts.find((/** @type {any} */ fact) => fact.id === item.id);
        if (!target) throw new DomainError('not_found', '内容不存在');
      }
      const wasConfirmed = target?.certainty === 'confirmed';
      if (wasConfirmed && action !== 'confirm' && !options.userOverride) {
        throw new DomainError('forbidden', '这条内容用户已确认，只有用户明确推翻时才能修改（传 user_override: true）');
      }
      if (action === 'confirm') {
        target.certainty = 'confirmed';
      } else if (action === 'correct') {
        const text = cleanText(item.text, '修正内容', 2000);
        if (item.kind === 'gate') idea.gates[item.id] = { text, certainty: options.userOverride ? 'confirmed' : 'inferred', updatedAt: Date.now() };
        else {
          target.text = text;
          target.certainty = options.userOverride ? 'confirmed' : 'inferred';
        }
      } else if (item.kind === 'gate') idea.gates[item.id] = null;
      else idea.facts = idea.facts.filter((/** @type {any} */ fact) => fact.id !== item.id);
      idea.updatedAt = Date.now();
      emit('idea_fact_revise', {
        idea_id: idea.id,
        fact_type: item.kind === 'gate' ? 'gate' : 'record',
        revise_type: action === 'confirm' ? 'confirm' : wasConfirmed ? 'overturn' : 'correct',
      });
      return idea;
    });
  }

  // ---------------------------------------------------------------- tasks

  /** @param {{ ideaId: string, title: string, notes?: string, projectDir?: string | null }} input */
  createTask(input) {
    return this.commit(() => {
      const idea = this.idea(input.ideaId);
      const progress = this.gateProgress(idea);
      if (progress.filled < GATE_KEYS.length) {
        throw new DomainError('gates_incomplete', `还差：${progress.missing.join('、')}。三项门槛写清后才能写成任务`);
      }
      const now = Date.now();
      const task = {
        id: newId('task'),
        ideaId: idea.id,
        title: cleanText(input.title, '任务名', TITLE_MAX),
        objective: idea.gates.objective.text,
        deliverable: idea.gates.deliverable.text,
        doneCriteria: idea.gates.done_criteria.text,
        notes: optionalText(input.notes, 4000) ?? '',
        status: 'todo',
        blocked: null,
        sessionId: null,
        projectDir: input.projectDir ?? null,
        workspace: null,
        consent: 'pending',
        interrupted: null,
        reviewRound: 0,
        outputs: [],
        summary: '',
        verification: null,
        approvals: [],
        question: null,
        progress: '',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        runStartedAt: null,
        finishedAt: null,
        history: [{ at: now, to: 'todo', note: '任务已写好' }],
      };
      this.state.tasks[task.id] = task;
      idea.updatedAt = now;
      return task;
    });
  }

  /**
   * The only status writer. Emits `task_status_result` for every status or blocked-reason change.
   * @param {string} taskId
   * @param {{ status?: typeof TASK_STATUSES[number], blocked?: null | { reason: typeof BLOCKED_REASONS[number], detail: string }, note?: string, patch?: Record<string, unknown> }} change
   */
  updateTask(taskId, change) {
    return this.commit((state, emit) => {
      const task = this.task(taskId);
      const fromStatus = task.status;
      const fromBlocked = task.blocked?.reason ?? '';
      if (change.patch) Object.assign(task, change.patch);
      const now = Date.now();
      if (change.status && change.status !== task.status) {
        task.status = change.status;
        if (change.status === 'in_progress') task.runStartedAt = now;
        if (change.status === 'done') task.finishedAt = now;
        task.history.push({ at: now, from: fromStatus, to: change.status, note: change.note ?? '' });
        if (task.history.length > 100) task.history.splice(0, task.history.length - 100);
      }
      if (change.blocked !== undefined) {
        task.blocked = change.blocked ? { ...change.blocked, since: now } : null;
      }
      task.updatedAt = now;
      const toBlocked = task.blocked?.reason ?? '';
      if (fromStatus !== task.status || fromBlocked !== toBlocked) {
        emit('task_status_result', {
          idea_id: task.ideaId,
          task_id: task.id,
          task_session_id: task.sessionId ?? '',
          project_name: task.workspace ? task.workspace.split(/[\\/]/).filter(Boolean).pop() ?? '' : '',
          from_status: fromStatus,
          status_type: task.status,
          blocked_reason: toBlocked,
          review_round: task.reviewRound,
          duration_ms: task.startedAt ? now - task.startedAt : 0,
        });
      }
      return task;
    });
  }

  /** @param {string} event @param {Record<string, unknown>} fields */
  emit(event, fields) {
    return this.commit((_state, emit) => emit(event, fields));
  }

  noteUserActivity() {
    return this.commit((state) => {
      state.activity.push(Date.now());
      if (state.activity.length > 5000) state.activity.splice(0, state.activity.length - 5000);
    });
  }

  // ---------------------------------------------------------------- MoMo conversation log

  /**
   * One message in the global MoMo conversation. `parts` for MoMo turns hold text and receipts.
   * @param {{ role: 'user' | 'momo' | 'system', text: string, images?: { id: string, name: string }[], focusIdeaId?: string | null, kind?: string, status?: string, receipts?: any[], tools?: any[] }} input
   */
  addChat(input) {
    return this.commit((state) => {
      const message = {
        id: newId('msg'),
        role: input.role,
        text: input.text,
        images: input.images ?? [],
        focusIdeaId: input.focusIdeaId ?? null,
        kind: input.kind ?? 'message',
        status: input.status ?? 'done',
        receipts: input.receipts ?? [],
        tools: input.tools ?? [],
        createdAt: Date.now(),
      };
      state.chat.push(message);
      if (state.chat.length > 500) state.chat.splice(0, state.chat.length - 500);
      if (input.role === 'user') state.activity.push(Date.now());
      return message;
    });
  }

  /** @param {string} messageId @param {(message: any) => void} update */
  updateChat(messageId, update) {
    return this.commit((state) => {
      const message = state.chat.find((item) => item.id === messageId);
      if (message) update(message);
      return message;
    });
  }

  /** @param {Record<string, unknown>} patch */
  updateSettings(patch) {
    return this.commit((state) => Object.assign(state.settings, patch));
  }

  /** @param {Record<string, unknown>} patch */
  updateMomoSession(patch) {
    return this.commit((state) => Object.assign(state.momoSession, patch));
  }

  // ---------------------------------------------------------------- projections

  /** What MoMo and the page show as "needs you": review, blocked, todo — in that order. */
  briefing() {
    const tasks = Object.values(this.state.tasks);
    const ideaTitle = (/** @type {string} */ id) => this.state.ideas[id]?.title ?? '已删除的想法';
    const view = (/** @type {any} */ task) => ({
      task_id: task.id,
      title: task.title,
      idea: ideaTitle(task.ideaId),
      status: task.status,
      blocked: task.blocked?.reason ?? null,
      blocked_detail: task.blocked?.detail ?? null,
    });
    const needsYou = [
      ...tasks.filter((task) => task.status === 'pending_review'),
      ...tasks.filter((task) => task.blocked && task.status !== 'pending_review'),
      ...tasks.filter((task) => task.status === 'todo' && !task.blocked && task.consent !== 'later'),
    ].map(view);
    const running = tasks.filter((task) => task.status === 'in_progress' && !task.blocked).map(view);
    const almost = this.liveIdeas()
      .map((idea) => ({ idea, progress: this.gateProgress(idea) }))
      .filter(({ idea, progress }) => progress.filled === 2 && !this.tasksOf(idea.id).some((task) => task.status !== 'done'))
      .sort((a, b) => b.idea.updatedAt - a.idea.updatedAt)[0];
    const unattributed = Object.values(this.state.records).filter((record) => !record.ideaId).length;
    return {
      needs_you: needsYou,
      running,
      almost_ready_idea: almost ? { idea_id: almost.idea.id, title: almost.idea.title, missing: almost.progress.missing } : null,
      unattributed_records: unattributed,
    };
  }

  /** Changes since the user last looked: drives the "while you were away" report. */
  changesSince(/** @type {number} */ since) {
    if (!since) return false;
    return Object.values(this.state.tasks).some((task) => task.updatedAt > since && task.history.some((entry) => entry.at > since));
  }

  snapshot() {
    const ideas = this.liveIdeas()
      .map((idea) => ({ ...idea, progress: this.gateProgress(idea) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      ideas,
      records: Object.values(this.state.records).sort((a, b) => a.createdAt - b.createdAt),
      tasks: Object.values(this.state.tasks).sort((a, b) => b.updatedAt - a.updatedAt),
      chat: this.state.chat.slice(-200),
      settings: this.state.settings,
      briefing: this.briefing(),
      hasChangesSinceSeen: this.changesSince(this.state.settings.lastSeenAt),
    };
  }
}
