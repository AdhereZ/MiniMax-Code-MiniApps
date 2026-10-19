// @ts-check
// Runs MoMo conversation turns and task sessions through the Host Agent API.

import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  MOMO_ROLE,
  ROLE_VERSION,
  autoFixMessage,
  resumeMessage,
  revisionMessage,
  stateDigest,
  taskHandoff,
  verificationPrompt,
} from './prompts.mjs';
import { DomainError } from './store.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppAgentClient} MiniAppAgentClient */
/** @typedef {import('./miniapp-api.js').MiniAppAgentRunEvent} MiniAppAgentRunEvent */
/** @typedef {import('./miniapp-api.js').MiniAppAgentRunResult} MiniAppAgentRunResult */
/** @typedef {import('./miniapp-api.js').MiniAppAgentQuestionAnswer} MiniAppAgentQuestionAnswer */

const MAX_OUTPUT_PREVIEW = 5 * 1024 * 1024;
const TEXT_OUTPUT = /\.(md|markdown|txt|csv|json|ya?ml|html?|js|mjs|ts|tsx|py|go|rs|java|sql|sh|css)$/i;

/** @param {unknown} error */
export function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : '';
}

/** @param {unknown} error */
function errorText(error) {
  return error && typeof error === 'object' && 'message' in error ? String(/** @type {any} */ (error).message) : String(error);
}

const clip = (/** @type {string} */ text, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

export class Engine {
  /**
   * @param {{
   *   store: import('./store.mjs').Store,
   *   agent: MiniAppAgentClient | undefined,
   *   logger: import('./miniapp-api.js').MiniAppLogger,
   *   broadcast: (event: Record<string, unknown>) => void,
   *   protectedRoots: string[],
   *   outputsRoot: string,
   *   pickPage: (preferred: string | null) => string | null,
   * }} options
   */
  constructor(options) {
    this.store = options.store;
    this.agent = options.agent;
    this.logger = options.logger;
    this.broadcast = options.broadcast;
    this.protectedRoots = options.protectedRoots;
    /** Agent-readable root for outputs of tasks without a project folder. */
    this.outputsRoot = options.outputsRoot;
    /** Returns a connected page client id, preferring `preferred` when it is still connected. */
    this.pickPage = options.pickPage;
    /**
     * Live run activity per task (not persisted; a run never survives a restart):
     * taskId → { steps, tool, toolAt, startedAt, queued }.
     * @type {Map<string, { steps: number, tool: string | null, toolAt: number, startedAt: number, queued: number | null }>}
     */
    this.activity = new Map();
    this.disposed = false;
    /** In-flight task runs: taskId → AbortController. */
    this.taskRuns = new Map();
    /** Verifier runs in flight: taskId → AbortController. */
    this.verifications = new Map();
    /** Queued MoMo inputs, drained one turn at a time. @type {{ messageId: string, text: string, images: any[], focusIdeaId: string | null, clientId: string | null }[]} */
    this.momoQueue = [];
    /** @type {AbortController | null} */
    this.momoRun = null;
    /** MoMo pending questionnaire and approvals (in memory; a restart cancels the run anyway). */
    this.momoPending = { question: /** @type {any} */ (null), approvals: /** @type {any[]} */ ([]) };
    /** The page client that sent the latest MoMo message; dispatch requests go to it first. */
    this.lastClientId = /** @type {string | null} */ (null);
    /** Dispatch requests waiting for a page to create the session: taskId → timer. */
    this.dispatchTimers = new Map();
    this.flushTimers = new Map();
  }

  get available() {
    return Boolean(this.agent);
  }

  requireAgent() {
    if (!this.agent) {
      throw new DomainError('agent_unavailable', '这个 MiniMax Code 版本没有向 Mini App 开放 Agent，无法运行 MoMo');
    }
    return this.agent;
  }

  /** Called once after the store loads: runs that died with the previous process need the user. */
  async recover() {
    for (const task of Object.values(this.store.state.tasks)) {
      if (task.status !== 'in_progress') continue;
      if (task.blocked?.reason === 'need_info' && task.question) continue;
      if (task.blocked?.reason === 'run_failed' || task.blocked?.reason === 'project_unavailable') continue;
      await this.store.updateTask(task.id, {
        blocked: { reason: 'run_failed', detail: '执行被 MiniMax Code 重启中断了，点「继续执行」接着做' },
        patch: { approvals: [], progress: '执行被中断' },
      });
    }
    for (const task of Object.values(this.store.state.tasks)) {
      if (task.dispatch) await this.store.updateTask(task.id, { patch: { dispatch: null } });
    }
    for (const message of this.store.state.chat) {
      if (message.role === 'momo' && (message.status === 'thinking' || message.status === 'streaming')) {
        await this.store.updateChat(message.id, (item) => {
          item.status = 'error';
          item.text = item.text || 'MoMo 这条回复被 MiniMax Code 重启打断了，请再说一次。';
        });
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.momoRun?.abort();
    for (const controller of this.taskRuns.values()) controller.abort();
    for (const controller of this.verifications.values()) controller.abort();
    for (const timer of this.dispatchTimers.values()) clearTimeout(timer);
    for (const timer of this.flushTimers.values()) clearTimeout(timer?.handle ?? timer);
  }

  /** Coalesces streaming updates into at most ~8 broadcasts per second per key. @param {string} key @param {() => void} send */
  throttle(key, send) {
    if (this.flushTimers.has(key)) return;
    this.flushTimers.set(
      key,
      setTimeout(() => {
        this.flushTimers.delete(key);
        if (!this.disposed) send();
      }, 120),
    );
  }

  /** Live activity snapshot sent with every state frame. */
  activityView() {
    return Object.fromEntries(this.activity);
  }

  /**
   * Updates live run activity in memory and pushes it to pages: the first change goes out at
   * once, later ones at most every 500 ms (state.json is not touched per tool event).
   * @param {string} taskId
   * @param {Partial<{ steps: number, tool: string | null, toolAt: number, startedAt: number, queued: number | null }>} patch
   */
  touchActivity(taskId, patch) {
    const current = this.activity.get(taskId) ?? { steps: 0, tool: null, toolAt: 0, startedAt: Date.now(), queued: null };
    this.activity.set(taskId, { ...current, ...patch });
    const key = `activity:${taskId}`;
    const timer = this.flushTimers.get(key);
    if (timer) {
      timer.dirty = true;
      return;
    }
    this.broadcast({ type: 'activity', activity: this.activityView() });
    const entry = { dirty: false, handle: /** @type {any} */ (null) };
    entry.handle = setTimeout(() => {
      this.flushTimers.delete(key);
      if (entry.dirty && !this.disposed) this.broadcast({ type: 'activity', activity: this.activityView() });
    }, 500);
    this.flushTimers.set(key, entry);
  }

  /** @param {string} taskId */
  clearActivity(taskId) {
    const key = `activity:${taskId}`;
    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer.handle);
      this.flushTimers.delete(key);
    }
    if (!this.activity.delete(taskId)) return;
    this.broadcast({ type: 'activity', activity: this.activityView() });
  }

  /** Where a task without a project folder writes its outputs (agent-readable, previewable). @param {string} taskId */
  outputDirFor(taskId) {
    return join(this.outputsRoot, taskId);
  }

  // ======================================================================= MoMo conversation

  /**
   * @param {{ text: string, images: { id: string, name: string, agentPath?: string }[], focusIdeaId: string | null, clientId: string | null, source: 'chat' | 'quick_capture' }} input
   */
  async sendToMomo(input) {
    this.requireAgent();
    const text = input.text.trim();
    if (!text && !input.images.length) throw new DomainError('invalid', '消息不能为空');
    if (input.focusIdeaId) this.store.idea(input.focusIdeaId);
    const userMessage = await this.store.addChat({
      role: 'user',
      text,
      images: input.images,
      focusIdeaId: input.focusIdeaId,
      kind: input.source,
    });
    const momoMessage = await this.store.addChat({ role: 'momo', text: '', status: 'thinking', focusIdeaId: input.focusIdeaId });
    if (input.clientId) this.lastClientId = input.clientId;
    this.momoQueue.push({ messageId: momoMessage.id, text, images: input.images, focusIdeaId: input.focusIdeaId, clientId: input.clientId });
    if (input.source === 'quick_capture') {
      await this.store.emit('collab_quick_capture', {
        idea_id: input.focusIdeaId ?? '',
        is_unattributed: !input.focusIdeaId,
        has_tag: /#\S/.test(text),
        has_image: input.images.length > 0,
        char_count: text.length,
      });
    }
    void this.drainMomo();
    return { userMessage, momoMessage };
  }

  async drainMomo() {
    if (this.momoRun || this.disposed) return;
    const batch = this.momoQueue.splice(0, this.momoQueue.length);
    if (!batch.length) return;
    // Several messages typed while MoMo was busy become one turn; the last placeholder answers them.
    const answerId = batch[batch.length - 1].messageId;
    for (const item of batch.slice(0, -1)) {
      await this.store.updateChat(item.messageId, (message) => {
        message.status = 'merged';
        message.text = '';
      });
    }
    const focusIdeaId = batch[batch.length - 1].focusIdeaId;
    const lines = batch.map((item) => {
      const images = item.images.map((image) => `  - 图片「${image.name}」（附件 id: ${image.id}）：${image.agentPath}`).join('\n');
      return `${item.text || '（只发了图片）'}${images ? `\n[附件，可用 read 工具查看]\n${images}` : ''}`;
    });
    await this.runMomoTurn(answerId, focusIdeaId, { kind: 'run', lines });
  }

  /**
   * @param {string} answerId
   * @param {string | null} focusIdeaId
   * @param {{ kind: 'run', lines: string[] } | { kind: 'answer', requestId: string, answers: readonly MiniAppAgentQuestionAnswer[] }} input
   */
  async runMomoTurn(answerId, focusIdeaId, input) {
    const agent = this.requireAgent();
    const controller = new AbortController();
    this.momoRun = controller;
    const session = this.store.state.momoSession;
    let streamed = '';
    const flush = () =>
      this.broadcast({ type: 'chat.stream', messageId: answerId, text: streamed });
    /** @param {MiniAppAgentRunEvent} event */
    const onEvent = (event) => {
      switch (event.type) {
        case 'turn.started':
          if (session.sessionId !== event.sessionId) void this.store.updateMomoSession({ sessionId: event.sessionId, role: ROLE_VERSION });
          void this.store.updateChat(answerId, (message) => {
            message.status = 'streaming';
          });
          break;
        case 'text.delta':
          streamed += event.text;
          this.throttle(`chat:${answerId}`, flush);
          break;
        case 'message.committed':
          // A turn may commit several assistant messages; keep them as one MoMo reply.
          streamed = streamed && !event.text.startsWith(streamed) && !streamed.endsWith(event.text) ? `${streamed}\n\n${event.text}` : event.text;
          this.throttle(`chat:${answerId}`, flush);
          break;
        case 'tool.started':
          void this.store.updateChat(answerId, (message) => {
            message.tools.push({ name: event.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''), ok: null });
          });
          break;
        case 'tool.finished':
          void this.store.updateChat(answerId, (message) => {
            const short = event.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
            const tool = [...message.tools].reverse().find((item) => item.name === short && item.ok === null);
            if (tool) tool.ok = event.ok;
          });
          break;
        case 'permission.requested':
          this.momoPending.approvals.push({
            requestId: event.requestId,
            sessionId: event.sessionId,
            toolName: event.toolName,
            toolInput: clip(event.toolInput ?? '', 1500),
            reason: event.reason,
            messageId: answerId,
          });
          this.broadcastMomoPending();
          break;
        default:
          break;
      }
    };
    try {
      let result;
      if (input.kind === 'answer') {
        result = await agent.answer(
          { sessionId: /** @type {string} */ (session.sessionId), requestId: input.requestId, answers: input.answers },
          { signal: controller.signal, onEvent },
        );
      } else {
        const fresh = !session.sessionId || session.role !== ROLE_VERSION;
        const text = [
          fresh ? MOMO_ROLE : '',
          stateDigest(this.store, focusIdeaId),
          `[本轮消息头] reply_to: ${answerId}${focusIdeaId ? `；用户正在聊想法 ${focusIdeaId}，默认针对这个想法` : ''}`,
          '[用户消息]',
          ...input.lines,
        ]
          .filter(Boolean)
          .join('\n\n');
        try {
          result = await agent.run({ text, ...(fresh ? {} : { sessionId: session.sessionId }) }, { signal: controller.signal, onEvent });
        } catch (error) {
          // A deleted or foreign MoMo session: start a new one with the full role.
          if (errorCode(error) !== 'SESSION_NOT_FOUND') throw error;
          await this.store.updateMomoSession({ sessionId: null });
          const retryText = [MOMO_ROLE, stateDigest(this.store, focusIdeaId), `[本轮消息头] reply_to: ${answerId}`, '[用户消息]', ...input.lines].join('\n\n');
          result = await agent.run({ text: retryText }, { signal: controller.signal, onEvent });
        }
      }
      await this.store.updateMomoSession({ sessionId: result.sessionId, role: ROLE_VERSION, runs: (session.runs ?? 0) + 1 });
      this.momoPending.question = result.pendingQuestion ? { ...result.pendingQuestion, messageId: answerId } : null;
      const finalText = result.text?.trim() || streamed.trim();
      await this.store.updateChat(answerId, (message) => {
        message.status = result.status === 'finished' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error';
        message.text =
          result.status === 'error'
            ? `${finalText ? `${finalText}\n\n` : ''}MoMo 这一轮出错了：${result.error?.message ?? '未知错误'}`
            : finalText || (result.pendingQuestion ? '我有个问题想先确认一下：' : result.status === 'aborted' ? '已停止。' : '好的。');
      });
    } catch (error) {
      const code = errorCode(error);
      this.logger.warn('momo.turn_failed', { code });
      await this.store.updateChat(answerId, (message) => {
        message.status = 'error';
        message.text =
          code === 'AGENT_OUTCOME_UNKNOWN'
            ? 'MoMo 这一轮的结果不确定，可能已经做了一部分。请看看看板和想法再决定要不要重说。'
            : code === 'REQUEST_CANCELLED'
              ? '已停止。'
              : `MoMo 暂时没法回复（${code || errorText(error)}）。稍后再试。`;
      });
    } finally {
      this.momoRun = null;
      this.momoPending.approvals = [];
      this.broadcastMomoPending();
      void this.drainMomo();
    }
  }

  stopMomo() {
    this.momoRun?.abort();
  }

  broadcastMomoPending() {
    this.broadcast({ type: 'momo.pending', pending: this.momoPendingView() });
  }

  momoPendingView() {
    return {
      busy: Boolean(this.momoRun),
      question: this.momoPending.question,
      approvals: this.momoPending.approvals,
    };
  }

  /** @param {string} requestId @param {readonly MiniAppAgentQuestionAnswer[]} answers */
  async answerMomoQuestion(requestId, answers) {
    const pending = this.momoPending.question;
    if (!pending || pending.requestId !== requestId) throw new DomainError('not_found', '这个问题已经结束了');
    if (this.momoRun) throw new DomainError('busy', 'MoMo 正在回复，请稍等');
    this.momoPending.question = null;
    const steps = /** @type {any} */ (pending).request?.steps ?? [];
    const picked = answers
      .map((answer) => {
        const step = steps.find((/** @type {any} */ item) => item.id === answer.stepId) ?? steps[0];
        const labels = (answer.selectedOptionIds ?? []).map((id) => step?.options?.find((/** @type {any} */ option) => option.id === id)?.label ?? id);
        if (answer.otherText) labels.push(answer.otherText);
        return labels.join('、');
      })
      .filter(Boolean);
    await this.store.addChat({ role: 'user', text: picked.length ? picked.join('\n') : '（跳过）' });
    const reply = await this.store.addChat({ role: 'momo', text: '', status: 'thinking' });
    void this.runMomoTurn(reply.id, null, { kind: 'answer', requestId, answers }).catch(() => {});
    return reply;
  }

  /** @param {string} requestId @param {'allowOnce' | 'deny'} decision */
  async replyMomoApproval(requestId, decision) {
    const approval = this.momoPending.approvals.find((item) => item.requestId === requestId);
    if (!approval) throw new DomainError('not_found', '这个请求已经结束了');
    try {
      await this.requireAgent().reply({ sessionId: approval.sessionId, requestId, decision });
    } catch (error) {
      if (errorCode(error) !== 'REQUEST_NOT_FOUND') throw error;
    } finally {
      this.momoPending.approvals = this.momoPending.approvals.filter((item) => item.requestId !== requestId);
      this.broadcastMomoPending();
    }
  }

  /**
   * Attaches a receipt to the MoMo reply named by `reply_to`, or posts a standalone notice when the
   * tool was called from somewhere else (an ordinary chat handing a session over).
   * @param {string | undefined} replyTo
   * @param {Record<string, unknown>} receipt
   */
  async receipt(replyTo, receipt) {
    const target = replyTo ? this.store.state.chat.find((message) => message.id === replyTo && message.role === 'momo') : undefined;
    if (target) {
      await this.store.updateChat(target.id, (message) => message.receipts.push(receipt));
      return;
    }
    await this.store.addChat({ role: 'system', kind: 'notice', text: '', receipts: [receipt] });
  }

  /** A short system line in the chat; with `taskId` the page renders the live task card under it. @param {string} text @param {{ taskId?: string }} [link] */
  notice(text, link = {}) {
    return this.store.addChat({ role: 'system', kind: 'notice', text, receipts: link.taskId ? [{ kind: 'task_card', taskId: link.taskId }] : [] });
  }

  // ======================================================================= task dispatch

  /**
   * Asks a page to create the task session (`agent.create()` binds the host chat's agent and
   * model). The session works in `task.projectDir` when set, otherwise in the task's own output
   * folder. Without a connected page the task waits; Node never silently starts it.
   * @param {string} taskId
   * @param {string | null} clientId the page that asked, when the request came from a page
   */
  async requestDispatch(taskId, clientId) {
    this.requireAgent();
    const task = this.store.task(taskId);
    if (task.status === 'done') throw new DomainError('invalid', '任务已经完成了');
    if (this.taskRuns.has(taskId)) throw new DomainError('busy', '任务正在执行');
    if (task.projectDir) {
      const problem = await this.checkProjectDir(task.projectDir);
      if (problem) {
        await this.store.updateTask(taskId, { blocked: { reason: 'project_unavailable', detail: problem } });
        throw new DomainError('project_unavailable', problem);
      }
    }
    // Agreeing to start confirms what MoMo inferred for this idea.
    await this.store.confirmInferredGates(task.ideaId);
    await this.store.updateTask(taskId, { patch: { consent: 'given', interrupted: null } });
    if (task.sessionId) {
      await this.continueTask(taskId);
      return { mode: 'reuse' };
    }
    const target = this.pickPage(clientId ?? this.lastClientId);
    if (!target) {
      await this.store.updateTask(taskId, {
        blocked: { reason: 'project_unavailable', detail: '协作页面没有打开，打开后点「开始」' },
      });
      throw new DomainError('no_page', '需要先打开协作页面');
    }
    await this.store.updateTask(taskId, { blocked: null, patch: { dispatch: { requestedAt: Date.now(), clientId: target } } });
    this.broadcast({ type: 'dispatch.request', taskId, clientId: target });
    clearTimeout(this.dispatchTimers.get(taskId));
    this.dispatchTimers.set(
      taskId,
      setTimeout(() => {
        this.dispatchTimers.delete(taskId);
        void this.dispatchTimedOut(taskId);
      }, 20_000),
    );
    return { mode: 'new' };
  }

  /** @param {string} taskId */
  async dispatchTimedOut(taskId) {
    const task = this.store.state.tasks[taskId];
    if (!task?.dispatch || task.sessionId) return;
    await this.store.updateTask(taskId, {
      patch: { dispatch: null },
      blocked: { reason: 'project_unavailable', detail: '协作页面没有响应开工请求，刷新页面后再点「开始」' },
    });
  }

  /**
   * A page created the session (`agent.create()` in its host chat). First claim wins.
   * @param {string} taskId @param {string} sessionId
   */
  async claimDispatch(taskId, sessionId) {
    const task = this.store.task(taskId);
    if (task.sessionId) return { claimed: false, sessionId: task.sessionId };
    if (task.status === 'done') throw new DomainError('invalid', '任务已经完成了');
    clearTimeout(this.dispatchTimers.get(taskId));
    this.dispatchTimers.delete(taskId);
    await this.store.updateTask(taskId, {
      status: 'in_progress',
      blocked: null,
      note: '已新开会话执行',
      patch: { sessionId, dispatch: null, startedAt: task.startedAt ?? Date.now(), progress: '正在开工' },
    });
    const updated = this.store.task(taskId);
    await this.store.emit('task_session_dispatch', {
      idea_id: updated.ideaId,
      task_id: taskId,
      task_session_id: sessionId,
      project_name: projectName(updated.projectDir),
      mode: 'new',
      handoff_item_count: this.handoffItemCount(updated),
    });
    const outputDir = this.outputDirFor(taskId);
    if (!updated.projectDir) await mkdir(outputDir, { recursive: true });
    void this.runTask(taskId, { kind: 'run', text: taskHandoff(this.store, updated, { outputDir }) });
    return { claimed: true, sessionId };
  }

  /** "先不做": keeps the task in 待办 without nagging. @param {string} taskId */
  async deferTask(taskId) {
    const task = this.store.task(taskId);
    if (task.status !== 'todo') throw new DomainError('invalid', '只有待办任务可以先不做');
    await this.store.updateTask(taskId, { blocked: null, patch: { consent: 'later' } });
    await this.store.emit('collab_confirm_ask', { action_type: 'dispatch', result: 'decline' });
  }

  /** Returns a user-facing problem, or '' when the folder can be used. @param {string} dir */
  async checkProjectDir(dir) {
    if (!isAbsolute(dir)) return `项目目录不是绝对路径：${dir}`;
    if (this.isProtected(resolve(dir))) return '不能把 MiniMax Code 的数据目录当作项目';
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return `项目目录不存在：${dir}`;
    return '';
  }

  /** @param {any} task */
  handoffItemCount(task) {
    const idea = this.store.state.ideas[task.ideaId];
    const facts = (idea?.facts ?? []).filter((/** @type {any} */ fact) => fact.certainty === 'confirmed').length;
    const records = idea ? this.store.recordsOf(idea.id).filter((record) => record.certainty === 'confirmed').length : 0;
    return 3 + facts + Math.min(records, 20);
  }

  /** "继续执行" after a failure or interruption: resumes in the same session. @param {string} taskId */
  async continueTask(taskId) {
    const task = this.store.task(taskId);
    if (!task.sessionId) throw new DomainError('invalid', '任务还没有会话');
    if (this.taskRuns.has(taskId)) throw new DomainError('busy', '任务正在执行');
    await this.store.updateTask(taskId, { status: 'in_progress', blocked: null, note: '继续执行', patch: { retryUsed: false, interrupted: null, consent: 'given', progress: '继续执行' } });
    await this.store.emit('task_session_dispatch', {
      idea_id: task.ideaId,
      task_id: taskId,
      task_session_id: task.sessionId,
      project_name: projectName(task.projectDir ?? task.workspace),
      mode: 'reuse',
      handoff_item_count: 0,
    });
    void this.runTask(taskId, { kind: 'run', text: resumeMessage(task) });
  }

  /** @param {string} taskId @param {string} feedback */
  async reviseTask(taskId, feedback) {
    const task = this.store.task(taskId);
    if (task.status !== 'pending_review' && task.status !== 'done') throw new DomainError('invalid', '只有待审核的任务可以提修改意见');
    if (!task.sessionId) throw new DomainError('invalid', '任务没有会话');
    const text = feedback.trim();
    if (!text) throw new DomainError('invalid', '修改意见不能为空');
    const round = task.reviewRound + 1;
    await this.store.addRecord({ text, target: task.ideaId, source: 'review', certainty: 'confirmed', attribution: 'confirmed', originTitle: `任务「${task.title}」的修改意见` });
    await this.store.updateTask(taskId, {
      status: 'in_progress',
      blocked: null,
      note: `修改意见（第 ${round} 轮）`,
      patch: { reviewRound: round, verification: null, autoFixUsed: false, retryUsed: false, progress: '按修改意见继续改' },
    });
    await this.store.emit('task_session_dispatch', {
      idea_id: task.ideaId,
      task_id: taskId,
      task_session_id: task.sessionId,
      project_name: projectName(task.projectDir ?? task.workspace),
      mode: 'reuse',
      handoff_item_count: 0,
    });
    void this.runTask(taskId, { kind: 'run', text: revisionMessage(task, text, round) });
  }

  /** @param {string} taskId */
  async approveTask(taskId) {
    const task = this.store.task(taskId);
    if (task.status !== 'pending_review') throw new DomainError('invalid', '只有待审核的任务可以确认完成');
    const outputs = task.outputs.map((/** @type {any} */ output) => output.file);
    await this.store.addRecord({
      text: `任务「${task.title}」已完成。${task.summary ? `结论：${task.summary}` : ''}${outputs.length ? `\n产出：${outputs.join('、')}` : ''}`,
      target: task.ideaId,
      source: 'session_return',
      certainty: 'confirmed',
      attribution: 'confirmed',
      originTitle: `任务「${task.title}」`,
      originSessionId: task.sessionId ?? undefined,
      userActivity: true,
    });
    await this.store.updateTask(taskId, {
      status: 'done',
      blocked: null,
      note: '用户确认完成',
      patch: { outputs: task.outputs.map((/** @type {any} */ output) => ({ ...output, reviewed: true })) },
    });
  }

  /** Stops a running task; it returns to todo and keeps its session for later. @param {string} taskId */
  async stopTask(taskId) {
    const task = this.store.task(taskId);
    if (task.status === 'done') throw new DomainError('invalid', '任务已经完成了');
    const controller = this.taskRuns.get(taskId);
    await this.store.updateTask(taskId, { patch: { stopRequested: true } });
    controller?.abort();
    this.verifications.get(taskId)?.abort();
    clearTimeout(this.dispatchTimers.get(taskId));
    this.dispatchTimers.delete(taskId);
    if (!controller) {
      await this.store.updateTask(taskId, {
        status: 'todo',
        blocked: null,
        note: '用户先不做了',
        patch: { stopRequested: false, dispatch: null, approvals: [], question: null, progress: '', interrupted: task.sessionId ? { at: Date.now(), by: 'user' } : null },
      });
    }
  }

  /**
   * One run of a task session, followed to its end: question → need_info, failure → one retry,
   * finish → MoMo verification → pending_review.
   * @param {string} taskId
   * @param {{ kind: 'run', text: string } | { kind: 'answer', requestId: string, answers: readonly MiniAppAgentQuestionAnswer[] }} input
   */
  async runTask(taskId, input) {
    const agent = this.requireAgent();
    if (this.taskRuns.has(taskId)) throw new DomainError('busy', '任务正在执行');
    const controller = new AbortController();
    this.taskRuns.set(taskId, controller);
    const runStartedAt = Date.now();
    let toolStarted = false;
    let steps = this.activity.get(taskId)?.steps ?? 0;
    this.touchActivity(taskId, { startedAt: runStartedAt, queued: null, tool: null, toolAt: 0, steps });
    /** @param {MiniAppAgentRunEvent} event */
    const onEvent = (event) => {
      switch (event.type) {
        case 'run.queued':
          this.touchActivity(taskId, { queued: event.position });
          break;
        case 'turn.started':
          this.touchActivity(taskId, { queued: null });
          break;
        case 'tool.started':
          toolStarted = true;
          steps += 1;
          this.touchActivity(taskId, { tool: event.name, toolAt: Date.now(), steps });
          this.clearSettledApprovals(taskId, event.sessionId);
          break;
        case 'tool.finished':
          this.touchActivity(taskId, { tool: null });
          break;
        case 'text.delta':
        case 'message.committed':
          this.clearSettledApprovals(taskId, event.sessionId);
          break;
        case 'permission.requested':
          void this.addTaskApproval(taskId, event);
          break;
        default:
          break;
      }
    };
    let result;
    try {
      const task = this.store.task(taskId);
      result =
        input.kind === 'answer'
          ? await agent.answer({ sessionId: task.sessionId, requestId: input.requestId, answers: input.answers }, { signal: controller.signal, onEvent })
          : await agent.run({ text: input.text, sessionId: task.sessionId }, { signal: controller.signal, onEvent });
    } catch (error) {
      this.taskRuns.delete(taskId);
      await this.taskRunRejected(taskId, error, toolStarted);
      this.clearActivityUnlessRerun(taskId);
      return;
    }
    this.taskRuns.delete(taskId);
    await this.taskRunSettled(taskId, result, runStartedAt);
    this.clearActivityUnlessRerun(taskId);
  }

  /** Live activity ends with the run unless a follow-up run (retry, nudge, auto-fix) took over. @param {string} taskId */
  clearActivityUnlessRerun(taskId) {
    if (!this.taskRuns.has(taskId) && !this.verifications.has(taskId)) this.clearActivity(taskId);
  }

  /**
   * A run that ended by abort: back to 待办 with the session kept, so 「继续执行」 resumes it.
   * `by` tells the user whether they stopped it here or in the MiniMax Code session itself.
   * @param {string} taskId @param {'user' | 'session'} by
   */
  async markInterrupted(taskId, by) {
    const task = this.store.state.tasks[taskId];
    if (!task) return;
    await this.store.updateTask(taskId, {
      status: 'todo',
      blocked: null,
      note: by === 'user' ? '你先不做了' : '会话里停止了执行',
      patch: {
        stopRequested: false,
        approvals: [],
        question: null,
        progress: '',
        interrupted: task.sessionId ? { at: Date.now(), by } : null,
      },
    });
  }

  /** @param {string} taskId @param {Extract<MiniAppAgentRunEvent, { type: 'permission.requested' }>} event */
  async addTaskApproval(taskId, event) {
    const task = this.store.state.tasks[taskId];
    if (!task) return;
    const approval = {
      requestId: event.requestId,
      sessionId: event.sessionId,
      toolName: event.toolName,
      toolInput: clip(event.toolInput ?? '', 1500),
      reason: event.reason,
      at: Date.now(),
    };
    await this.store.updateTask(taskId, {
      blocked: { reason: 'need_approval', detail: `等你批准：${event.toolName}` },
      patch: { approvals: [...task.approvals.filter((/** @type {any} */ item) => item.requestId !== event.requestId), approval] },
    });
    await this.store.emit('permission_request_view', { collab_task_id: taskId, tool_name: event.toolName });
  }

  /**
   * Progress in a session after an approval means the user answered it elsewhere (side panel).
   * @param {string} taskId @param {string} sessionId
   */
  clearSettledApprovals(taskId, sessionId) {
    const task = this.store.state.tasks[taskId];
    if (!task?.approvals.length) return;
    const left = task.approvals.filter((/** @type {any} */ item) => item.sessionId !== sessionId);
    if (left.length === task.approvals.length) return;
    void this.store.updateTask(taskId, {
      patch: { approvals: left },
      blocked: left.length ? task.blocked : null,
    });
  }

  /** @param {string} taskId @param {string} requestId @param {'allowOnce' | 'deny'} decision */
  async replyTaskApproval(taskId, requestId, decision) {
    const task = this.store.task(taskId);
    const approval = task.approvals.find((/** @type {any} */ item) => item.requestId === requestId);
    if (!approval) throw new DomainError('not_found', '这个请求已经结束了');
    try {
      await this.requireAgent().reply({ sessionId: approval.sessionId, requestId, decision });
    } catch (error) {
      if (errorCode(error) !== 'REQUEST_NOT_FOUND') throw error;
    }
    const left = this.store.task(taskId).approvals.filter((/** @type {any} */ item) => item.requestId !== requestId);
    await this.store.updateTask(taskId, {
      patch: { approvals: left },
      blocked: left.length ? this.store.task(taskId).blocked : null,
    });
    await this.store.emit('permission_request_click', { collab_task_id: taskId, decision });
    if (decision === 'deny') await this.notice(`已拒绝「${task.title}」的请求，任务会换个做法`, { taskId });
  }

  /** @param {string} taskId @param {string} requestId @param {readonly MiniAppAgentQuestionAnswer[]} answers */
  async answerTaskQuestion(taskId, requestId, answers) {
    const task = this.store.task(taskId);
    if (!task.question || task.question.requestId !== requestId) throw new DomainError('not_found', '这个问题已经结束了');
    if (this.taskRuns.has(taskId)) throw new DomainError('busy', '任务正在执行');
    await this.store.updateTask(taskId, { blocked: null, patch: { question: null, progress: '已补充信息，继续执行' } });
    void this.runTask(taskId, { kind: 'answer', requestId, answers });
  }

  /** @param {string} taskId @param {unknown} error @param {boolean} toolStarted */
  async taskRunRejected(taskId, error, toolStarted) {
    const code = errorCode(error);
    const task = this.store.state.tasks[taskId];
    if (!task) return;
    this.logger.warn('momo.task_run_rejected', { code });
    if (task.stopRequested || code === 'REQUEST_CANCELLED') {
      await this.markInterrupted(taskId, task.stopRequested ? 'user' : 'session');
      return;
    }
    if (code === 'SESSION_NOT_FOUND') {
      await this.store.updateTask(taskId, {
        blocked: { reason: 'project_unavailable', detail: '任务会话已不存在。点「重新开工」会新开一个会话' },
        patch: { sessionId: null, approvals: [], progress: '' },
      });
      return;
    }
    const retryable = /** @type {any} */ (error)?.retryable === true && code !== 'AGENT_OUTCOME_UNKNOWN';
    if (retryable && !task.retryUsed && !toolStarted) {
      await this.store.updateTask(taskId, { patch: { retryUsed: true, progress: '执行没起来，MoMo 正在重试' } });
      await new Promise((done) => setTimeout(done, 3000));
      if (!this.disposed) void this.runTask(taskId, { kind: 'run', text: resumeMessage(task) });
      return;
    }
    await this.store.updateTask(taskId, {
      blocked: {
        reason: 'run_failed',
        detail:
          code === 'AGENT_OUTCOME_UNKNOWN'
            ? '执行结果不确定，可能已做了一部分。去会话里看看，再决定「继续执行」'
            : `执行失败（${code || errorText(error)}）`,
      },
      patch: { approvals: [], progress: '' },
    });
  }

  /** @param {string} taskId @param {MiniAppAgentRunResult} result @param {number} runStartedAt */
  async taskRunSettled(taskId, result, runStartedAt) {
    const task = this.store.state.tasks[taskId];
    if (!task) return;
    if (task.sessionId !== result.sessionId) await this.store.updateTask(taskId, { patch: { sessionId: result.sessionId } });
    if (result.status === 'aborted') {
      await this.markInterrupted(taskId, task.stopRequested ? 'user' : 'session');
      return;
    }
    if (result.pendingQuestion) {
      await this.store.updateTask(taskId, {
        blocked: { reason: 'need_info', detail: result.pendingQuestion.request.steps[0]?.question ?? '需要你补充信息' },
        patch: { question: result.pendingQuestion, approvals: [], progress: '等你补充信息' },
      });
      return;
    }
    if (result.status === 'error') {
      if (!task.retryUsed) {
        await this.store.updateTask(taskId, { patch: { retryUsed: true, approvals: [], progress: `出错了（${result.error?.message ?? '未知'}），MoMo 正在重试` } });
        void this.runTask(taskId, { kind: 'run', text: resumeMessage(task) });
        return;
      }
      await this.store.updateTask(taskId, {
        blocked: { reason: 'run_failed', detail: `执行失败：${clip(result.error?.message ?? '未知错误', 200)}` },
        patch: { approvals: [], progress: '' },
      });
      await this.notice(`「${task.title}」重试后仍然失败`, { taskId });
      return;
    }
    const submitted = (task.submittedAt ?? 0) >= runStartedAt;
    if (!submitted && !task.nudged) {
      // The session finished without calling submit_task_result: ask once in the same session.
      await this.store.updateTask(taskId, { patch: { nudged: true, approvals: [], progress: '提醒执行会话提交结果' } });
      void this.runTask(taskId, {
        kind: 'run',
        text: `请调用 momo 的 submit_task_result（task_id: ${taskId}）提交这次的结论和全部产出文件；如果任务还没做完，先做完再提交。`,
      });
      return;
    }
    if (!submitted) {
      await this.store.updateTask(taskId, { patch: { summary: result.text?.trim() ?? '', criteria: [] } });
    }
    await this.store.updateTask(taskId, { patch: { nudged: false, approvals: [], retryUsed: false } });
    await this.verifyTask(taskId);
  }

  /**
   * Called by `submit_task_result`. When no Node run follows the session (the user sent a message
   * in the session directly), verification starts here instead of after a run.
   * @param {string} taskId
   * @param {{ summary: string, outputs: { file: string, description: string }[], criteria: { criterion: string, met: boolean, evidence: string }[] }} submission
   */
  async submitResult(taskId, submission) {
    const task = this.store.task(taskId);
    if (task.status === 'done') throw new DomainError('invalid', '任务已经完成了；需要再改请先在协作里提修改意见');
    await this.store.updateTask(taskId, {
      patch: {
        summary: submission.summary,
        outputs: submission.outputs.map((output) => ({ ...output, reviewed: false })),
        criteria: submission.criteria,
        submittedAt: Date.now(),
        progress: '已提交结果，等待 MoMo 核对',
      },
    });
    if (!this.taskRuns.has(taskId) && !this.verifications.has(taskId)) {
      if (task.status !== 'in_progress') await this.store.updateTask(taskId, { status: 'in_progress', blocked: null, note: '会话里直接提交了结果' });
      void this.verifyTask(taskId);
    }
  }

  /** @param {string} taskId */
  async verifyTask(taskId) {
    const agent = this.requireAgent();
    const task = this.store.task(taskId);
    const fileCheck = await this.checkOutputs(task);
    await this.store.updateTask(taskId, { patch: { progress: 'MoMo 正在核对', verification: null, fileCheck } });
    this.touchActivity(taskId, { tool: 'momo_verify', toolAt: Date.now() });
    const controller = new AbortController();
    this.verifications.set(taskId, controller);
    let verdict;
    try {
      const result = await agent.run(
        { text: verificationPrompt(this.store.task(taskId), fileCheck) },
        {
          signal: controller.signal,
          // The verifier may only read; any approval request is declined so it never acts for the user.
          onEvent: (event) => {
            if (event.type === 'permission.requested') {
              void agent.reply({ sessionId: event.sessionId, requestId: event.requestId, decision: 'deny' }).catch(() => {});
            }
          },
        },
      );
      verdict = this.store.task(taskId).verification;
      if (!verdict) {
        verdict = {
          verdict: fileCheck.missing.length ? 'fail' : 'pass',
          notes: result.status === 'finished' ? clip(result.text?.trim() || 'MoMo 核对完成。', 400) : 'MoMo 核对没有完成，请你直接审核产出。',
          fixRequest: fileCheck.missing.length ? `这些产出文件找不到：${fileCheck.missing.join('、')}` : '',
          at: Date.now(),
          fallback: true,
        };
      }
    } catch (error) {
      verdict = { verdict: 'pass', notes: `MoMo 核对没有完成（${errorCode(error) || errorText(error)}），请你直接审核产出。`, fixRequest: '', at: Date.now(), fallback: true };
    } finally {
      this.verifications.delete(taskId);
      this.clearActivityUnlessRerun(taskId);
    }
    const current = this.store.state.tasks[taskId];
    if (!current || current.stopRequested) {
      if (current) await this.markInterrupted(taskId, 'user');
      return;
    }
    if (verdict.verdict === 'fail' && !current.autoFixUsed && verdict.fixRequest) {
      await this.store.updateTask(taskId, { patch: { verification: verdict, autoFixUsed: true, progress: 'MoMo 核对发现问题，让执行会话补做' } });
      void this.runTask(taskId, { kind: 'run', text: autoFixMessage(current, verdict.fixRequest) });
      return;
    }
    await this.store.updateTask(taskId, {
      status: 'pending_review',
      blocked: null,
      note: verdict.verdict === 'pass' ? 'MoMo 核对通过' : 'MoMo 核对有疑问，交给你判断',
      patch: { verification: verdict, autoFixUsed: false, progress: '' },
    });
    await this.notice(`「${current.title}」可以审核了${verdict.verdict === 'pass' ? '' : '（MoMo 核对有疑问）'}`, { taskId });
  }

  /**
   * @param {string} taskId
   * @param {{ verdict: 'pass' | 'fail', notes: string, fixRequest: string, checks: { criterion: string, met: boolean, evidence: string }[] }} input
   */
  async recordVerification(taskId, input) {
    if (!this.verifications.has(taskId)) throw new DomainError('invalid', '这个任务现在没有在核对');
    await this.store.updateTask(taskId, { patch: { verification: { ...input, at: Date.now() } } });
  }

  /**
   * Checks each reported output exists and inlines a bounded text preview. The verifier session
   * runs outside the project folder, so file reads there would need approvals it cannot get.
   * @param {any} task
   */
  async checkOutputs(task) {
    const present = [];
    const missing = [];
    let budget = 24_000;
    for (const output of task.outputs ?? []) {
      const file = this.resolveOutput(task, output.file);
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      if (!info || !(info.isFile() || info.isDirectory())) {
        missing.push(output.file);
        continue;
      }
      let preview = '';
      if (info.isFile() && budget > 0 && TEXT_OUTPUT.test(output.file) && !this.isProtected(/** @type {string} */ (file))) {
        const text = await readFile(/** @type {string} */ (file), 'utf8').catch(() => '');
        preview = text.slice(0, Math.min(8_000, budget));
        budget -= preview.length;
      }
      present.push({ file: output.file, size: info.size, ...(preview ? { preview, truncated: preview.length < info.size } : {}) });
    }
    return { present, missing };
  }

  /**
   * MiniMax Code's private data is never previewed or used as a project, except this Mini App's
   * own agent-readable outputs folder.
   * @param {string} file
   */
  isProtected(file) {
    const within = (/** @type {string} */ root) => file === root || file.startsWith(`${root}/`) || file.startsWith(`${root}\\`);
    if (within(this.outputsRoot)) return false;
    return this.protectedRoots.some(within);
  }

  /** @param {any} task @param {string} file */
  resolveOutput(task, file) {
    if (typeof file !== 'string' || !file) return undefined;
    if (isAbsolute(file)) return resolve(file);
    const base = task.projectDir ?? task.workspace ?? this.outputDirFor(task.id);
    return resolve(base, file);
  }

  /** A regular output file outside MiniMax Code's private data, small enough to preview. @param {string} taskId @param {number} index */
  async outputFile(taskId, index) {
    const task = this.store.task(taskId);
    const output = task.outputs[index];
    if (!output) throw new DomainError('not_found', '产出不存在');
    const file = this.resolveOutput(task, output.file);
    if (!file) throw new DomainError('not_found', '产出路径无法解析');
    if (this.isProtected(file)) {
      throw new DomainError('forbidden', '这个位置的文件不能在协作里预览');
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new DomainError('not_found', '产出文件已不存在');
    if (info.size > MAX_OUTPUT_PREVIEW) throw new DomainError('too_large', '文件太大，无法在协作里预览，请在项目文件夹里打开');
    return { file, size: info.size };
  }
}

/** @param {string | null | undefined} workspace */
export function projectName(workspace) {
  return workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
}
