// @ts-check
/** @typedef {import('./client-api.js').McodeClientAPI} McodeClientAPI */
/** @typedef {import('./client-api.js').MiniAppAgentQuestionnaire} Questionnaire */
/** @typedef {import('./client-api.js').MiniAppAgentQuestionAnswer} QuestionAnswer */

const STATUS = /** @type {const} */ ({ todo: '待办', in_progress: '进行中', pending_review: '待审核', done: '已完成' });
const BLOCKED = /** @type {Record<string, string>} */ ({ need_approval: '待批准', need_info: '待补充信息', run_failed: '执行失败', project_unavailable: '项目不可用' });
const GATES = /** @type {const} */ ([['objective', '做什么'], ['deliverable', '产出什么'], ['done_criteria', '怎么算做完']]);
const COLORS = /** @type {Record<string, string>} */ ({ sky: 'none', mint: 'hue-rotate(-50deg)', peach: 'hue-rotate(150deg) saturate(1.3)', lilac: 'hue-rotate(60deg)', lemon: 'hue-rotate(-150deg) saturate(1.4)' });
const FIRST_PROMPTS = ['把最近在想的一件事告诉我', '贴一张截图试试', '你能帮我做什么？'];
const LATER_PROMPTS = ['现在进展到哪了？', '哪些事需要我处理？', '哪个想法快能开始了？'];
const TOOL_LABELS = /** @type {Record<string, string>} */ ({
  add_record: '记录', move_record: '改记', update_idea: '整理想法', create_task: '写任务', update_task: '改任务', start_task: '派任务',
  get_overview: '查看进展', get_idea: '查看想法', approve_task: '确认完成', revise_task: '提交修改意见', stop_task: '停止任务',
  revise_item: '修正', confirm_record: '确认', delete_record: '删除记录', delete_idea: '删除想法', task_report: '汇报进度',
  submit_task_result: '提交结果', record_verification: '核对', momo_verify: 'MoMo 核对',
  read: '读文件', write: '写文件', edit: '改文件', bash: '执行命令', grep: '搜索', glob: '查找文件', ls: '列目录',
  web_search: '搜索网页', web_fetch: '读网页', task: '委派子任务', ask_user: '提问', todo_write: '整理待办',
});

const host = /** @type {McodeClientAPI | undefined} */ (window.mcode);
const agentApi = host?.miniapp?.agent;
const windowApi = host?.miniapp?.window;
const clientId = sessionStorage.getItem('momo.client') ?? crypto.randomUUID();
sessionStorage.setItem('momo.client', clientId);

/** @type {any} */
let state = null;
const ui = {
  view: /** @type {'chat' | 'inbox' | 'board' | 'ideas'} */ ('chat'),
  focusIdeaId: /** @type {string | null} */ (null),
  drawer: /** @type {null | { kind: 'task' | 'idea', id: string, highlight?: string }} */ (null),
  boardFilter: '',
  attachments: /** @type {{ id: string, url: string }[]} */ ([]),
  streams: /** @type {Map<string, string>} */ (new Map()),
  report: /** @type {any} */ (null),
  windowMode: 'inline',
  claimed: /** @type {Set<string>} */ (new Set()),
  answers: /** @type {Map<string, Map<string, Set<string>>>} */ (new Map()),
};

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const esc = (/** @type {unknown} */ value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const base = (/** @type {string} */ file) => String(file ?? '').split(/[\\/]/).filter(Boolean).pop() ?? file;
const shortPath = (/** @type {string} */ dir) => {
  const parts = String(dir ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
};
function ago(/** @type {number} */ at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function duration(/** @type {number} */ ms) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
function clock(/** @type {number} */ at) {
  const date = new Date(at);
  return new Date().toDateString() === date.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const toolName = (/** @type {string} */ name) => {
  const short = String(name ?? '').replace(/^mcp__.+?__/, '');
  return TOOL_LABELS[short] ?? short;
};

/** Minimal safe Markdown: paragraphs, **bold**, `code`, bullet/number lists, links as text. @param {string} text */
function md(text) {
  const blocks = esc(text).split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const inline = (/** @type {string} */ line) =>
        line.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      if (lines.every((line) => /^\s*\d+[.、)]\s*/.test(line))) return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.、)]\s*/, ''))}</li>`).join('')}</ol>`;
      return `<p>${lines.map(inline).join('<br />')}</p>`;
    })
    .join('');
}

// --------------------------------------------------------------------- theme & avatar

const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.setAttribute('data-theme', media.matches ? 'dark' : 'light');
media.addEventListener('change', applyTheme);
applyTheme();

function applyAvatar() {
  const settings = state?.settings ?? {};
  const root = document.documentElement.style;
  if (settings.avatarUploadId) {
    root.setProperty('--momo-image', `url('/api/uploads/${encodeURIComponent(settings.avatarUploadId)}')`);
    root.setProperty('--momo-filter', 'none');
  } else {
    root.removeProperty('--momo-image');
    root.setProperty('--momo-filter', COLORS[settings.momoColor] ?? 'none');
  }
}

// --------------------------------------------------------------------- network

/** @param {string} path @param {Record<string, unknown>} [body] */
async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, clientId }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message ?? '请求失败'), { code: data.error });
  return data;
}
const taskPost = (/** @type {string} */ id, /** @type {string} */ action, body = {}) => post(`/api/tasks/${encodeURIComponent(id)}/${action}`, body);

/** @param {string} event @param {Record<string, unknown>} [fields] */
function track(event, fields = {}) {
  void post('/api/track', { event, fields }).catch(() => {});
}

let toastTimer = 0;
/** @param {string} text */
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.hidden = true), 3000);
}
/** @param {unknown} error */
const showError = (error) => toast(error instanceof Error ? error.message : String(error));

function connect() {
  const events = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
  events.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'state') {
      const first = !state;
      state = event.state;
      if (first) onFirstState();
      render();
    } else if (event.type === 'activity') {
      if (!state) return;
      state.activity = event.activity;
      renderLive();
    } else if (event.type === 'chat.stream') {
      ui.streams.set(event.messageId, event.text);
      const node = document.querySelector(`[data-stream="${CSS.escape(event.messageId)}"]`);
      if (node) {
        node.innerHTML = md(event.text);
        scrollChat(false);
      }
    } else if (event.type === 'momo.pending') {
      if (!state) return;
      state.momo = event.pending;
      render();
    } else if (event.type === 'dispatch.request') {
      if (event.clientId === clientId) void dispatch(event.taskId);
    }
  };
  events.onerror = () => {
    $('banner').hidden = false;
    $('banner').textContent = '和 MoMo 的连接断开了，正在重连…（MiniMax Code 重启后请点 Mini App 工具栏的刷新）';
  };
  events.onopen = () => {
    if (state?.agentAvailable !== false) $('banner').hidden = true;
  };
}

/** Creates the task session through the Host bridge and hands it to the Node service. @param {string} taskId */
async function dispatch(taskId) {
  if (ui.claimed.has(taskId)) return;
  ui.claimed.add(taskId);
  try {
    if (!agentApi?.create) throw new Error('host_unsupported');
    const { sessionId } = await agentApi.create();
    await taskPost(taskId, 'claim', { sessionId });
  } catch (error) {
    await taskPost(taskId, 'dispatch-failed', { code: error instanceof Error ? error.message : 'unknown' }).catch(() => {});
  } finally {
    ui.claimed.delete(taskId);
  }
}

function onFirstState() {
  track('collab_view', { view: ui.view, entry: windowApi ? 'miniapp' : 'browser' });
  if (state.hasChangesSinceSeen && state.briefing.needs_you.length) {
    ui.report = state.briefing;
    track('collab_report_view', countBy(state.briefing.needs_you));
  }
  void post('/api/seen').catch(() => {});
  if (!state.agentAvailable) {
    $('banner').hidden = false;
    $('banner').textContent = '当前 MiniMax Code 没有向 Mini App 开放 Agent，MoMo 暂时无法对话和派任务。';
  }
}

/** @param {any[]} items */
function countBy(items) {
  return {
    pending_review_count: items.filter((item) => item.status === 'pending_review').length,
    blocked_count: items.filter((item) => item.blocked).length,
    todo_count: items.filter((item) => item.status === 'todo').length,
  };
}

// --------------------------------------------------------------------- derived data

const ideaById = (/** @type {string} */ id) => state.ideas.find((/** @type {any} */ idea) => idea.id === id);
const taskById = (/** @type {string} */ id) => state.tasks.find((/** @type {any} */ task) => task.id === id);
const tasksOf = (/** @type {string} */ ideaId) => state.tasks.filter((/** @type {any} */ task) => task.ideaId === ideaId);
const recordsOf = (/** @type {string | null} */ ideaId) => state.records.filter((/** @type {any} */ record) => record.ideaId === ideaId);

/** Tasks where the user is the bottleneck, ordered by urgency (Claude Projects "Waiting on you"). */
function needsYou() {
  const order = (/** @type {any} */ task) =>
    task.blocked?.reason === 'need_approval' ? 0
      : task.blocked?.reason === 'need_info' ? 1
        : task.status === 'pending_review' ? 2
          : task.blocked ? 3
            : 4;
  return state.tasks
    .filter((/** @type {any} */ task) => task.status === 'pending_review' || task.blocked || (task.status === 'todo' && task.consent !== 'later'))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => order(a) - order(b) || b.updatedAt - a.updatedAt);
}

/** Running = in progress, not blocked, or dispatch in flight. */
const isRunning = (/** @type {any} */ task) => (task.status === 'in_progress' && !task.blocked) || Boolean(task.dispatch);

// --------------------------------------------------------------------- task presentation

/** One-line live status, Multica-style: renders only while a run is active. @param {any} task */
function liveHtml(task) {
  const live = state.activity?.[task.id];
  if (task.dispatch) return '<span class="live"><span class="pulse"></span>正在开工</span>';
  if (!live || task.status !== 'in_progress' || task.blocked) return '';
  if (live.queued) return `<span class="live queued"><span class="pulse"></span>排队中 · 第 ${live.queued} 位</span>`;
  const doing = live.tool ? toolName(live.tool) : task.progress || '思考中';
  const detail = `${doing}${live.steps ? ` · ${live.steps} 步` : ''}`;
  return `<span class="live"><span class="pulse"></span><span class="label">执行中 · ${duration(Date.now() - (task.runStartedAt ?? live.startedAt))}</span><span class="what" title="${esc(detail)}">· ${esc(detail)}</span></span>`;
}

/** The single next step for the task, by state (Multica "what to do" per reason). @param {any} task @param {{ compact?: boolean }} [opts] */
function primaryActions(task, opts = {}) {
  const id = esc(task.id);
  const b = (/** @type {string} */ action, /** @type {string} */ label, kind = 'primary') => `<button type="button" class="${kind} xsmall" data-action="${action}" data-task="${id}">${label}</button>`;
  const reason = task.blocked?.reason;
  if (reason === 'need_approval') return b('open-task', '去批准');
  if (reason === 'need_info') return b('open-task', '去回答');
  if (reason === 'run_failed') return task.sessionId ? b('continue-task', '继续执行') + b('open-session', '看会话', 'secondary') : b('start-task', '重新开始');
  if (reason === 'project_unavailable') return task.sessionId && task.status !== 'todo' ? b('continue-task', '重试') : b('set-project', '设置项目目录') + (task.status === 'todo' ? b('start-task', '重试开始', 'secondary') : '');
  if (task.status === 'pending_review') return b('approve-task', '可以') + b('revise-task', '提修改意见', 'secondary');
  if (task.status === 'todo' && !task.dispatch) {
    if (task.interrupted) return b('continue-task', '继续执行') + (opts.compact ? '' : b('stop-forget', '不做了', 'secondary'));
    return b('start-task', '开始') + (opts.compact || task.consent === 'later' ? '' : b('defer-task', '先不做', 'secondary'));
  }
  return '';
}

/** Explains the state in plain words; empty when the card's live line already says it. @param {any} task */
function reasonLine(task) {
  if (task.blocked) return task.blocked.detail ?? '';
  if (task.status === 'todo' && task.interrupted) return task.interrupted.by === 'user' ? '你停了这次执行，会话还在，可以接着做' : '执行在会话里被停止了，会话还在，可以接着做';
  if (task.status === 'todo' && task.consent === 'later') return '先放着，想做时点开始';
  if (task.status === 'pending_review') return task.verification?.notes ?? `${task.outputs.length} 个产出等你看`;
  if (task.status === 'done') return `${clock(task.finishedAt ?? task.updatedAt)} 完成${task.outputs.length ? ` · ${task.outputs.length} 个产出` : ''}`;
  return '';
}

/** @param {any} task */
function statusChip(task) {
  if (task.blocked) {
    const danger = task.blocked.reason === 'run_failed' || task.blocked.reason === 'project_unavailable';
    return `<span class="chip ${danger ? 'danger' : 'warn'}">${esc(BLOCKED[task.blocked.reason])}</span>`;
  }
  if (task.status === 'pending_review') return '<span class="chip accent">待审核</span>';
  if (task.status === 'done') return '<span class="chip ok">已完成</span>';
  if (task.status === 'todo' && task.interrupted) return '<span class="chip">已暂停</span>';
  return '';
}

/** @param {any} task */
function projectChip(task) {
  const dir = task.projectDir ?? null;
  return dir
    ? `<span class="chip" title="${esc(dir)}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3.5a1 1 0 0 1 1-1h2.2l1 1h3.8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>${esc(base(dir))}</span>`
    : '';
}

/** Compact card (Multica board-card): 2-line title, chips only when informative. @param {any} task @param {{ showStatus?: boolean, showIdea?: boolean }} [opts] */
function taskCard(task, opts = {}) {
  const attention = task.blocked || task.status === 'pending_review';
  const idea = ideaById(task.ideaId);
  const live = liveHtml(task);
  const reason = live ? '' : reasonLine(task);
  const actions = primaryActions(task, { compact: true });
  return `<div class="card task ${attention ? 'attention' : ''}" role="button" tabindex="0" data-action="open-task" data-task="${esc(task.id)}" aria-label="任务 ${esc(task.title)}，${STATUS[/** @type {keyof typeof STATUS} */ (task.status)]}">
    <div class="spread"><span class="task-title">${esc(task.title)}</span>${opts.showStatus === false ? '' : statusChip(task)}</div>
    ${live ? `<div data-live="${esc(task.id)}">${live}</div>` : `<div data-live="${esc(task.id)}" hidden></div>`}
    ${reason ? `<div class="reason">${esc(reason)}</div>` : ''}
    <div class="task-meta">${projectChip(task)}${opts.showIdea === false || !idea ? '' : `<span class="ellipsis">${esc(idea.title)}</span>`}<span class="faint" style="margin-left:auto">${ago(task.updatedAt)}</span></div>
    ${actions ? `<div class="task-actions">${actions}</div>` : ''}
  </div>`;
}

/** Live task card inside the chat (Claude Projects thread card / Devin session status). @param {any} task */
function chatTaskCard(task) {
  const live = liveHtml(task);
  const reason = live ? '' : reasonLine(task);
  const attention = task.blocked || task.status === 'pending_review' || (task.status === 'todo' && task.consent === 'pending');
  const actions = primaryActions(task);
  const consent = task.status === 'todo' && !task.sessionId && !task.blocked && task.consent !== 'given';
  return `<div class="card inline-card ${attention ? 'attention' : ''}">
    <div class="title-line"><span class="dot ${task.status}"></span><strong class="grow ellipsis">${esc(task.title)}</strong>${statusChip(task) || `<span class="chip">${STATUS[/** @type {keyof typeof STATUS} */ (task.status)]}</span>`}</div>
    ${consent ? `<dl class="kv"><dt>做什么</dt><dd>${esc(task.objective)}</dd><dt>产出</dt><dd>${esc(task.deliverable)}</dd><dt>做完</dt><dd>${esc(task.doneCriteria)}</dd><dt>在哪做</dt><dd>${task.projectDir ? `<span class="mono" title="${esc(task.projectDir)}">${esc(shortPath(task.projectDir))}</span>` : '<span class="faint">不绑定项目，产出放到协作的产出目录</span>'}</dd></dl>` : ''}
    ${live ? `<div data-live="${esc(task.id)}">${live}</div>` : `<div data-live="${esc(task.id)}" hidden></div>`}
    ${reason ? `<div class="reason">${esc(reason)}</div>` : ''}
    ${task.blocked?.reason === 'need_approval' && task.approvals[0] ? approvalCard(task.approvals[0], task.id) : ''}
    ${task.blocked?.reason === 'need_info' && task.question ? questionCard(task.question, task.id) : ''}
    <div class="row">${task.blocked?.reason === 'need_approval' || task.blocked?.reason === 'need_info' ? '' : actions}<button type="button" class="link small" data-action="open-task" data-task="${esc(task.id)}">详情</button></div>
  </div>`;
}

/** @param {any} approval @param {string} owner 'momo' or taskId */
function approvalCard(approval, owner) {
  return `<div class="card inline-card attention" role="group" aria-label="待批准">
    <div class="spread"><strong>需要你批准：${esc(toolName(approval.toolName))}</strong><span class="chip warn">待批准</span></div>
    ${approval.reason ? `<div class="subtle">${esc(approval.reason)}</div>` : ''}
    ${approval.toolInput ? `<pre class="pre">${esc(approval.toolInput)}</pre>` : ''}
    <div class="row end">
      <button type="button" class="secondary xsmall" data-action="approval" data-owner="${esc(owner)}" data-request="${esc(approval.requestId)}" data-decision="deny">拒绝</button>
      <button type="button" class="primary xsmall" data-action="approval" data-owner="${esc(owner)}" data-request="${esc(approval.requestId)}" data-decision="allowOnce">批准这一次</button>
    </div>
  </div>`;
}

/**
 * Inline questionnaire with option chips (Qoder: choices + recommended + write your own).
 * Single-select single-step questions answer on click; others collect then submit.
 * @param {any} pending @param {string} owner 'momo' or taskId
 */
function questionCard(pending, owner) {
  const request = pending.request;
  const picked = ui.answers.get(pending.requestId) ?? new Map();
  const quick = request.steps.length === 1 && request.steps[0].selectionMode === 'single';
  const steps = request.steps
    .map((/** @type {any} */ step) => {
      const selected = picked.get(step.id) ?? new Set();
      return `<div class="section" data-step="${esc(step.id)}">
        <div>${md(step.header && step.header !== step.question ? `**${step.header}** ${step.question}` : step.question)}</div>
        ${step.description ? `<div class="subtle">${esc(step.description)}</div>` : ''}
        <div class="options">${step.options
          .map((/** @type {any} */ option, /** @type {number} */ index) => {
            const recommended = index === 0 && /推荐|recommend/i.test(`${option.label}${option.description ?? ''}`);
            return `<button type="button" class="option-chip" aria-pressed="${selected.has(option.id)}" data-action="pick-option" data-owner="${esc(owner)}" data-request="${esc(pending.requestId)}" data-step="${esc(step.id)}" data-option="${esc(option.id)}" data-quick="${quick}">
              <span class="grow"><span class="label">${esc(option.label.replace(/[（(]推荐[)）]/, ''))}</span>${option.description ? `<span class="desc">${esc(option.description.replace(/^推荐[。.，,:：\s]*/, ''))}</span>` : ''}</span>${recommended ? '<span class="chip accent rec">推荐</span>' : ''}
            </button>`;
          })
          .join('')}</div>
        <input class="other-input" type="text" data-other="${esc(step.id)}" placeholder="或者自己写，回车提交" data-owner="${esc(owner)}" data-request="${esc(pending.requestId)}" />
      </div>`;
    })
    .join('');
  return `<div class="card inline-card attention" role="group" aria-label="问题">
    ${request.title ? `<strong>${esc(request.title)}</strong>` : ''}
    ${steps}
    <div class="row end">${quick ? '' : `<button type="button" class="primary xsmall" data-action="submit-answer" data-owner="${esc(owner)}" data-request="${esc(pending.requestId)}">提交</button>`}<button type="button" class="link small" data-action="skip-answer" data-owner="${esc(owner)}" data-request="${esc(pending.requestId)}">跳过</button></div>
  </div>`;
}

// --------------------------------------------------------------------- render

const NAV = /** @type {const} */ ([
  ['chat', '对话'],
  ['inbox', '待处理'],
  ['board', '看板'],
  ['ideas', '想法'],
]);

function render() {
  if (!state) return;
  applyAvatar();
  const attention = needsYou().filter((/** @type {any} */ task) => task.status !== 'todo' || task.blocked).length;
  const todo = needsYou().length - attention;
  document.title = attention ? `(${attention}) 协作 · MoMo` : '协作 · MoMo';
  $('nav').innerHTML = NAV.map(([view, label]) => {
    const badge = view === 'inbox' ? (attention ? `<span class="count">${attention}</span>` : todo ? `<span class="count muted">${todo}</span>` : '') : view === 'board' && attention ? `<span class="count">${attention}</span>` : '';
    return `<button type="button" role="tab" data-view="${view}" aria-selected="${ui.view === view}">${label}${badge}</button>`;
  }).join('');
  $('popout').hidden = !windowApi || ui.windowMode === 'window';
  $('main').dataset.view = ui.view;
  if (ui.focusIdeaId && !ideaById(ui.focusIdeaId)) ui.focusIdeaId = null;
  renderChat();
  renderSide();
  renderComposer();
  renderDrawer();
}

/** Updates only the live lines (activity frames arrive often). */
function renderLive() {
  document.querySelectorAll('[data-live]').forEach((node) => {
    const task = taskById(/** @type {HTMLElement} */ (node).dataset.live ?? '');
    if (!task) return;
    const html = liveHtml(task);
    node.innerHTML = html;
    /** @type {HTMLElement} */ (node).hidden = !html;
  });
}

function renderComposer() {
  const busy = state.momo?.busy;
  $('stop').hidden = !busy;
  /** @type {HTMLButtonElement} */ ($('send')).disabled = !state.agentAvailable;
  const focus = ui.focusIdeaId ? ideaById(ui.focusIdeaId) : null;
  const context = $('composer-context');
  context.hidden = !focus;
  context.innerHTML = focus
    ? `<span class="momo" data-size="16"></span><span>正在聊：<strong>${esc(focus.title)}</strong></span><button type="button" class="icon-button" data-action="unfocus" aria-label="回到全局"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`
    : '';
  $('attachments').innerHTML = ui.attachments
    .map((item) => `<span class="attachment"><img src="${esc(item.url)}" alt="待发送图片" /><button type="button" data-action="remove-attachment" data-id="${esc(item.id)}" aria-label="移除图片">×</button></span>`)
    .join('');
}

let lastChatSignature = '';
function renderChat() {
  const log = $('chat-log');
  const messages = state.chat.filter((/** @type {any} */ message) => message.status !== 'merged');
  const pending = state.momo ?? {};
  const referenced = new Set(messages.flatMap((/** @type {any} */ m) => m.receipts.filter((/** @type {any} */ r) => r.taskId).map((/** @type {any} */ r) => r.taskId)));
  for (const entry of ui.report?.needs_you ?? []) referenced.add(entry.task_id);
  const taskSig = state.tasks.filter((/** @type {any} */ t) => referenced.has(t.id)).map((/** @type {any} */ t) => [t.id, t.status, t.blocked?.reason, t.consent, t.updatedAt, t.dispatch ? 1 : 0, t.approvals.length, t.question?.requestId]);
  const signature = JSON.stringify([messages.map((/** @type {any} */ m) => [m.id, m.status, m.text.length, m.receipts.length, m.tools.length]), pending.question?.requestId, pending.approvals?.map((/** @type {any} */ a) => a.requestId), ui.report ? 1 : 0, state.ideas.length, taskSig, [...ui.answers.keys()]]);
  if (signature === lastChatSignature) return;
  lastChatSignature = signature;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement && active.dataset.other ? { step: active.dataset.other, request: active.dataset.request, value: active.value } : null;
  if (!messages.length && !state.ideas.length) {
    log.innerHTML = `<div class="hero"><span class="momo"></span><h2>我是 MoMo，你的项目管家</h2>
      <p>随手丢给我一句话、一张截图或一个链接。我帮你攒着、理清楚，写成任务后替你安排会话去做，做完先核对再交给你。</p>
      <div class="suggestions">${FIRST_PROMPTS.map((text) => `<button type="button" data-action="suggest" data-text="${esc(text)}">${esc(text)}</button>`).join('')}</div></div>`;
    return;
  }
  // A task card is shown once, at its latest mention; earlier mentions collapse to a link.
  const lastMention = new Map();
  messages.forEach((/** @type {any} */ m, /** @type {number} */ index) => m.receipts.forEach((/** @type {any} */ r) => r.taskId && r.kind === 'task_card' && lastMention.set(r.taskId, index)));
  const parts = [];
  let lastDay = '';
  messages.forEach((/** @type {any} */ message, /** @type {number} */ index) => {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastDay && lastDay) parts.push(`<div class="day-sep">${new Date(message.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</div>`);
    lastDay = day;
    parts.push(renderMessage(message, index, lastMention));
  });
  if (pending.question) parts.push(`<div class="msg from-momo"><span class="momo" data-size="28"></span><div class="body">${questionCard(pending.question, 'momo')}</div></div>`);
  for (const approval of pending.approvals ?? []) parts.push(`<div class="msg from-momo"><span class="momo" data-size="28"></span><div class="body">${approvalCard(approval, 'momo')}</div></div>`);
  if (ui.report) parts.push(renderReport(ui.report));
  if (!pending.busy && !pending.question) parts.push(`<div class="suggestions">${LATER_PROMPTS.map((text) => `<button type="button" data-action="suggest" data-text="${esc(text)}">${esc(text)}</button>`).join('')}</div>`);
  log.innerHTML = parts.join('');
  if (typing) {
    const input = /** @type {HTMLInputElement | null} */ (log.querySelector(`input[data-other="${CSS.escape(typing.step ?? '')}"][data-request="${CSS.escape(typing.request ?? '')}"]`));
    if (input) {
      input.value = typing.value;
      input.focus();
    }
  }
  scrollChat(nearBottom);
}

/** @param {boolean} force */
function scrollChat(force) {
  const log = $('chat-log');
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}

/** @param {any} message @param {number} index @param {Map<string, number>} lastMention */
function renderMessage(message, index, lastMention) {
  // Chips (receipts, task links) flow inline; full task cards stack below them.
  /** @type {string[]} */
  const chips = [];
  /** @type {string[]} */
  const cards = [];
  for (const receipt of message.receipts) {
    if (receipt.kind === 'task_card' || receipt.kind === 'task') {
      const task = taskById(receipt.taskId);
      if (!task) continue;
      if (lastMention.get(task.id) === index || (receipt.kind === 'task' && !lastMention.has(task.id))) cards.push(chatTaskCard(task));
      else chips.push(`<button type="button" class="receipt" data-action="open-task" data-task="${esc(task.id)}"><span class="dot ${task.status}"></span><span class="ellipsis">任务「<strong>${esc(task.title)}</strong>」</span></button>`);
    } else {
      chips.push(renderReceipt(receipt));
    }
  }
  const attachments = `${chips.length ? `<div class="row">${chips.join('')}</div>` : ''}${cards.join('')}`;
  if (message.role === 'system') {
    return `<div class="notice">${message.text ? `<div class="notice-text">${esc(message.text)}</div>` : ''}${attachments}</div>`;
  }
  const images = message.images.map((/** @type {any} */ image) => `<img class="thumb" src="/api/uploads/${encodeURIComponent(image.id)}" alt="附图" />`).join('');
  if (message.role === 'user') {
    const focus = message.focusIdeaId ? ideaById(message.focusIdeaId) : null;
    return `<div class="msg user"><div class="body">${message.text ? `<div class="bubble">${esc(message.text)}</div>` : ''}${images}
      <span class="meta">${focus ? `关于「${esc(focus.title)}」 · ` : ''}${message.kind === 'quick_capture' ? '随手记 · ' : ''}${clock(message.createdAt)}</span></div></div>`;
  }
  const live = message.status === 'thinking' || message.status === 'streaming';
  const text = live ? ui.streams.get(message.id) ?? '' : message.text;
  const running = message.tools.filter((/** @type {any} */ tool) => tool.ok === null);
  const toolLine = live && running.length ? `<div class="tool-line">${running.map((/** @type {any} */ tool) => `<span>正在${esc(toolName(tool.name))}…</span>`).join('')}</div>` : '';
  const failed = message.tools.filter((/** @type {any} */ tool) => tool.ok === false);
  return `<div class="msg from-momo ${message.status === 'error' ? 'error' : ''}">
    <span class="momo" data-size="28" data-state="${live ? 'thinking' : message.receipts.length ? 'noted' : 'idle'}"></span>
    <div class="body">
      ${text ? `<div class="bubble md" ${live ? `data-stream="${esc(message.id)}"` : ''}>${md(text)}</div>` : live ? `<div class="bubble" data-stream="${esc(message.id)}"><span class="typing"><span></span><span></span><span></span></span></div>` : ''}
      ${toolLine}
      ${attachments}
      ${failed.length ? `<div class="tool-line">${failed.map((/** @type {any} */ tool) => `<span class="danger-text">${esc(toolName(tool.name))}失败</span>`).join('')}</div>` : ''}
      <span class="meta">${clock(message.createdAt)}</span>
    </div>
  </div>`;
}

/** @param {any} receipt */
function renderReceipt(receipt) {
  const attrs = `data-action="open-receipt" data-idea="${esc(receipt.ideaId ?? '')}" data-record="${esc(receipt.recordId ?? '')}"`;
  const icon = '<span class="momo" data-size="16" data-state="noted"></span>';
  switch (receipt.kind) {
    case 'new_idea':
      return `<button type="button" class="receipt" ${attrs}>${icon}<span class="ellipsis">新想法「<strong>${esc(receipt.ideaTitle)}</strong>」</span></button>`;
    case 'record':
      return `<button type="button" class="receipt" ${attrs}>${icon}<span class="ellipsis">记到「<strong>${esc(receipt.ideaTitle)}</strong>」</span></button>`;
    case 'unattributed':
      return `<button type="button" class="receipt" ${attrs}>${icon}<span class="ellipsis">先记为<strong>未归属</strong></span></button>`;
    case 'moved':
      return `<button type="button" class="receipt" ${attrs}>${icon}<span class="ellipsis">已从「${esc(receipt.fromTitle)}」改记到「<strong>${esc(receipt.ideaTitle)}</strong>」</span></button>`;
    case 'gates':
      return `<button type="button" class="receipt" ${attrs}><span class="gates" aria-label="门槛 ${receipt.filled}/3">${[0, 1, 2].map((i) => `<span class="${i < receipt.filled ? 'on' : ''}"></span>`).join('')}</span><span class="ellipsis">「<strong>${esc(receipt.ideaTitle)}</strong>」写清了${esc(receipt.changed.join('、'))}</span></button>`;
    case 'task_done':
      return `<button type="button" class="receipt" data-action="open-task" data-task="${esc(receipt.taskId)}"><span class="dot done"></span><span class="ellipsis">「<strong>${esc(receipt.taskTitle)}</strong>」已完成</span></button>`;
    default:
      return '';
  }
}

/** Away briefing: the list was captured on arrival, but each row reflects the task as it is now. @param {any} report */
function renderReport(report) {
  const entries = report.needs_you
    .map((/** @type {any} */ entry) => ({ entry, task: taskById(entry.task_id) }))
    .filter(({ task }) => task && (task.status === 'pending_review' || task.blocked || (task.status === 'todo' && task.consent !== 'later')));
  const verb = (/** @type {any} */ task) => (task.status === 'pending_review' ? '等你审核' : task.blocked ? BLOCKED[task.blocked.reason] ?? '受阻' : task.interrupted ? '已暂停' : '等你说开始');
  return `<div class="msg from-momo"><span class="momo" data-size="28"></span><div class="body"><div class="card inline-card">
    <strong>${entries.length ? `你不在的时候，有 ${entries.length} 件事等你：` : '你不在时等你的事都处理完了'}</strong>
    <div class="options">${entries.slice(0, 6).map(({ entry, task }) => `<button type="button" class="option-chip" data-action="report-task" data-task="${esc(task.id)}"><span class="grow"><span class="label">${esc(task.title)}</span><span class="desc">${esc(entry.idea)}</span></span><span class="chip ${task.status === 'pending_review' ? 'accent' : 'warn'}">${esc(verb(task))}</span></button>`).join('')}</div>
    ${report.running.length ? `<div class="subtle">还在跑：${report.running.map((/** @type {any} */ entry) => `「${esc(entry.title)}」`).join('、')}</div>` : ''}
    ${report.almost_ready_idea ? `<div class="subtle">「<button type="button" class="link" data-action="open-idea" data-idea="${esc(report.almost_ready_idea.idea_id)}">${esc(report.almost_ready_idea.title)}</button>」只差${esc(report.almost_ready_idea.missing.join('、'))}</div>` : ''}
    <div class="row end"><button type="button" class="link small" data-action="dismiss-report">知道了</button></div>
  </div></div></div>`;
}

function renderSide() {
  const pane = $('pane-side');
  const view = ui.view === 'chat' ? 'rail' : ui.view;
  if (view === 'board') pane.innerHTML = renderBoard();
  else if (view === 'ideas') pane.innerHTML = renderIdeas();
  else pane.innerHTML = renderRail();
  const select = /** @type {HTMLSelectElement | null} */ (pane.querySelector('#board-filter'));
  if (select) select.value = ui.boardFilter;
}

/** Rail / inbox: 等你处理 → 进行中 → recent. */
function renderRail() {
  const waiting = needsYou();
  const urgent = waiting.filter((/** @type {any} */ task) => task.status !== 'todo' || task.blocked);
  const todo = waiting.filter((/** @type {any} */ task) => task.status === 'todo' && !task.blocked);
  const running = state.tasks.filter(isRunning);
  const recent = state.tasks.filter((/** @type {any} */ task) => task.status === 'done').slice(0, 3);
  const later = state.tasks.filter((/** @type {any} */ task) => task.status === 'todo' && task.consent === 'later' && !task.blocked);
  const section = (/** @type {string} */ title, /** @type {any[]} */ items, /** @type {string} */ empty, badge = false) => `<section class="section"><div class="section-head"><span>${title}</span>${items.length ? `<span class="count ${badge ? '' : 'muted'}">${items.length}</span>` : ''}</div>
    ${items.length ? items.map((task) => taskCard(task)).join('') : empty ? `<div class="empty">${empty}</div>` : ''}</section>`;
  if (!state.tasks.length) {
    return `<div class="rail"><div class="empty-block"><span class="momo" data-size="28"></span><span>还没有任务</span><span class="subtle">想法的三项门槛写清后，MoMo 会写成任务，进度会出现在这里。</span></div>${renderIdeaShortlist()}</div>`;
  }
  return `<div class="rail">
    ${section('等你处理', urgent, '没有要你处理的事', true)}
    ${running.length ? section('进行中', running, '') : ''}
    ${todo.length ? section('待开始', todo, '') : ''}
    ${later.length ? section('先放着', later, '') : ''}
    ${recent.length ? section('最近完成', recent, '') : ''}
    ${renderIdeaShortlist()}
  </div>`;
}

function renderIdeaShortlist() {
  const ideas = state.ideas.filter((/** @type {any} */ idea) => !tasksOf(idea.id).some((/** @type {any} */ task) => task.status !== 'done')).slice(0, 4);
  if (!ideas.length) return '';
  return `<section class="section"><div class="section-head"><span class="grow">想法</span><button type="button" class="link small" data-action="go" data-view="ideas">全部</button></div>${ideas.map(ideaCard).join('')}</section>`;
}

/** @param {any} idea */
function ideaCard(idea) {
  const tasks = tasksOf(idea.id);
  return `<button type="button" class="card idea" data-action="open-idea" data-idea="${esc(idea.id)}">
    <div class="spread"><strong class="ellipsis">${esc(idea.title)}</strong><span class="gates" aria-label="门槛 ${idea.progress.filled}/3">${[0, 1, 2].map((i) => `<span class="${i < idea.progress.filled ? 'on' : ''}"></span>`).join('')}</span></div>
    <span class="subtle">${idea.progress.missing.length ? `还差${esc(idea.progress.missing.join('、'))}` : '三项都写清了'} · ${recordsOf(idea.id).length} 条记录${tasks.length ? ` · ${tasks.length} 个任务` : ''} · ${ago(idea.updatedAt)}</span>
  </button>`;
}

function renderBoard() {
  const tasks = state.tasks.filter((/** @type {any} */ task) => !ui.boardFilter || task.ideaId === ui.boardFilter);
  const urgency = (/** @type {any} */ task) => (task.blocked ? 0 : 1);
  const columns = ['todo', 'in_progress', 'pending_review', 'done']
    .map((status) => {
      const items = tasks.filter((/** @type {any} */ task) => task.status === status).sort((/** @type {any} */ a, /** @type {any} */ b) => urgency(a) - urgency(b) || b.updatedAt - a.updatedAt);
      return `<section class="column" aria-label="${STATUS[/** @type {keyof typeof STATUS} */ (status)]}"><div class="column-head"><span class="dot ${status}"></span>${STATUS[/** @type {keyof typeof STATUS} */ (status)]}<span class="count muted">${items.length}</span></div>
        <div class="column-body">${items.length ? items.map((task) => taskCard(task, { showStatus: Boolean(task.blocked) || (status === 'todo' && task.interrupted) })).join('') : '<div class="empty">暂无</div>'}</div></section>`;
    })
    .join('');
  return `<div class="board-wrap"><div class="board-toolbar"><select id="board-filter" aria-label="按想法筛选"><option value="">全部想法</option>${state.ideas.map((/** @type {any} */ idea) => `<option value="${esc(idea.id)}">${esc(idea.title)}</option>`).join('')}</select><span class="subtle">状态跟着会话走，看板不能拖拽</span></div><div class="board">${columns}</div></div>`;
}

function renderIdeas() {
  const loose = recordsOf(null);
  return `<div class="rail">
    ${loose.length ? `<section class="section"><div class="section-head"><span>未归属</span><span class="count muted">${loose.length}</span></div>${loose
      .map((/** @type {any} */ record) => `<div class="card idea loose"><span class="ellipsis">${esc(record.text || '（图片）')}</span><div class="row tight"><button type="button" class="secondary xsmall" data-action="move-record" data-record="${esc(record.id)}">归到想法…</button><button type="button" class="link small danger-text" data-action="delete-record" data-record="${esc(record.id)}">删除</button></div></div>`)
      .join('')}</section>` : ''}
    <section class="section"><div class="section-head"><span>想法</span><span class="count muted">${state.ideas.length}</span></div>
      ${state.ideas.length ? state.ideas.map(ideaCard).join('') : '<div class="empty">还没有想法，在对话里跟 MoMo 说一句就能开始</div>'}</section>
  </div>`;
}

// --------------------------------------------------------------------- drawer (task / idea detail)

function renderDrawer() {
  const drawer = $('drawer');
  if (!ui.drawer) {
    drawer.hidden = true;
    return;
  }
  const entity = ui.drawer.kind === 'task' ? taskById(ui.drawer.id) : ideaById(ui.drawer.id);
  if (!entity) {
    ui.drawer = null;
    drawer.hidden = true;
    return;
  }
  drawer.hidden = false;
  $('drawer-title').textContent = entity.title;
  const scroll = $('drawer-body').scrollTop;
  $('drawer-body').innerHTML = ui.drawer.kind === 'task' ? taskDetail(entity) : ideaDetail(entity);
  $('drawer-body').scrollTop = scroll;
  if (ui.drawer.highlight) {
    const node = $('drawer-body').querySelector(`[data-record-id="${CSS.escape(ui.drawer.highlight)}"]`);
    node?.closest('details')?.setAttribute('open', '');
    node?.scrollIntoView({ block: 'center' });
    ui.drawer.highlight = undefined;
  }
}

/** @param {any} task */
function taskDetail(task) {
  const idea = ideaById(task.ideaId);
  const live = liveHtml(task);
  const reason = reasonLine(task);
  const actions = primaryActions(task);
  const checks = task.verification?.checks?.length ? task.verification.checks : task.criteria ?? [];
  const history = [...task.history].reverse().slice(0, 12);
  const editableProject = task.status === 'todo' && !task.sessionId;
  return `
    <div class="status-line"><span class="dot ${task.status}"></span><strong>${STATUS[/** @type {keyof typeof STATUS} */ (task.status)]}</strong>${statusChip(task)}<span class="subtle" style="margin-left:auto">${ago(task.updatedAt)}更新</span></div>
    ${live ? `<div data-live="${esc(task.id)}">${live}</div>` : `<div data-live="${esc(task.id)}" hidden></div>`}
    ${reason ? `<div class="reason">${esc(reason)}</div>` : ''}
    ${task.blocked?.reason === 'need_approval' ? task.approvals.map((/** @type {any} */ a) => approvalCard(a, task.id)).join('') : ''}
    ${task.blocked?.reason === 'need_info' && task.question ? questionCard(task.question, task.id) : ''}
    ${actions || task.sessionId ? `<div class="row">${actions}${task.sessionId ? '<button type="button" class="secondary xsmall" data-action="open-session" data-task="' + esc(task.id) + '">打开会话</button>' : ''}${task.status === 'in_progress' ? '<button type="button" class="link small danger-text" data-action="stop-task" data-task="' + esc(task.id) + '">停止</button>' : ''}</div>` : ''}

    ${task.status === 'pending_review' || task.status === 'done' ? `<section class="section"><h3>结果</h3>
      ${task.summary ? `<div class="md">${md(task.summary)}</div>` : '<div class="empty">没有提交结论</div>'}
      ${checks.length ? `<div class="section">${checks.map((/** @type {any} */ c) => `<div class="check"><span class="mark ${c.met ? 'ok' : 'no'}">${c.met ? '✓' : '!'}</span><span class="grow">${esc(c.criterion)}${c.evidence ? `<div class="evidence">${esc(c.evidence)}</div>` : ''}</span></div>`).join('')}</div>` : ''}
      ${task.verification ? `<div class="subtle">MoMo 核对${task.verification.verdict === 'pass' ? '通过' : '有疑问'}${task.verification.notes ? `：${esc(task.verification.notes)}` : ''}</div>` : ''}
    </section>` : ''}

    ${task.outputs.length ? `<section class="section"><h3>产出 · ${task.outputs.length}</h3>${task.outputs.map((/** @type {any} */ o, /** @type {number} */ i) => `<div class="output"><span class="grow"><span class="name" title="${esc(o.file)}">${esc(base(o.file))}</span>${o.description ? `<div class="subtle">${esc(o.description)}</div>` : ''}</span>${o.reviewed ? '<span class="chip ok">已审核</span>' : ''}<button type="button" class="link small" data-action="preview-output" data-task="${esc(task.id)}" data-index="${i}">预览</button></div>`).join('')}
      ${task.fileCheck?.missing?.length ? `<div class="subtle danger-text">找不到：${esc(task.fileCheck.missing.map(base).join('、'))}</div>` : ''}</section>` : ''}

    <section class="section"><h3>完成标准</h3>
      <div class="gate-row"><span class="label">做什么</span><span>${esc(task.objective)}</span></div>
      <div class="gate-row"><span class="label">产出什么</span><span>${esc(task.deliverable)}</span></div>
      <div class="gate-row"><span class="label">怎么算做完</span><span>${esc(task.doneCriteria)}</span></div>
      ${task.notes ? `<div class="subtle">${esc(task.notes)}</div>` : ''}
    </section>

    <section class="section"><h3>在哪做</h3>
      <div class="output"><span class="grow mono" title="${esc(task.projectDir ?? task.workspace ?? '')}">${task.projectDir ? esc(task.projectDir) : task.workspace ? esc(task.workspace) : '<span class="faint">不绑定项目，产出放到协作的产出目录</span>'}</span>${editableProject ? `<button type="button" class="link small" data-action="set-project" data-task="${esc(task.id)}">${task.projectDir ? '更换' : '设置'}</button>` : ''}</div>
    </section>

    ${idea ? `<section class="section"><h3>来源想法</h3><button type="button" class="card idea" data-action="open-idea" data-idea="${esc(idea.id)}"><span class="ellipsis"><strong>${esc(idea.title)}</strong></span><span class="subtle">${recordsOf(idea.id).length} 条记录</span></button></section>` : ''}

    <section class="section"><h3>经过</h3><ul class="timeline">${history.map((/** @type {any} */ h) => `<li><span class="dot ${h.to}"></span><span>${esc(h.note || STATUS[/** @type {keyof typeof STATUS} */ (h.to)])}${h.from ? ` <span class="faint">→ ${STATUS[/** @type {keyof typeof STATUS} */ (h.to)]}</span>` : ''}</span><span class="faint">${clock(h.at)}</span></li>`).join('')}</ul></section>`;
}

/** @param {any} idea */
function ideaDetail(idea) {
  const tasks = tasksOf(idea.id);
  const records = recordsOf(idea.id);
  const confirmed = idea.facts.filter((/** @type {any} */ f) => f.certainty === 'confirmed');
  const inferred = idea.facts.filter((/** @type {any} */ f) => f.certainty !== 'confirmed');
  const gate = (/** @type {[string, string]} */ [key, label]) => {
    const value = idea.gates[key];
    if (!value) return `<div class="gate-row missing"><span class="label">${label}</span><span>还没写清</span></div>`;
    return `<div class="gate-row"><span class="label"><span>${label}</span>${value.certainty === 'confirmed' ? '' : `<span class="row tight"><span class="chip dashed">推断</span><button type="button" class="link small" data-action="confirm-item" data-idea="${esc(idea.id)}" data-kind="gate" data-item="${key}">对</button></span>`}</span><span>${esc(value.text)}</span></div>`;
  };
  const fact = (/** @type {any} */ item) => `<div class="gate-row"><span class="label"><span></span>${item.certainty === 'confirmed' ? '' : `<span class="row tight"><span class="chip dashed">推断</span><button type="button" class="link small" data-action="confirm-item" data-idea="${esc(idea.id)}" data-kind="fact" data-item="${esc(item.id)}">对</button></span>`}</span><span>${esc(item.text)}</span></div>`;
  return `
    <div class="row"><span class="gates">${[0, 1, 2].map((i) => `<span class="${i < idea.progress.filled ? 'on' : ''}"></span>`).join('')}</span><span class="subtle">门槛 ${idea.progress.filled}/3${idea.progress.missing.length ? ` · 还差${esc(idea.progress.missing.join('、'))}` : ''}</span>
      <span class="row tight" style="margin-left:auto"><button type="button" class="secondary xsmall" data-action="focus-idea" data-idea="${esc(idea.id)}">和 MoMo 聊这个</button><button type="button" class="link small" data-action="rename-idea" data-idea="${esc(idea.id)}">改名</button><button type="button" class="link small danger-text" data-action="delete-idea" data-idea="${esc(idea.id)}">删除</button></span></div>
    <section class="section"><h3>下一个任务的三项门槛</h3>${GATES.map(gate).join('')}</section>
    ${confirmed.length ? `<section class="section"><h3>已确定</h3>${confirmed.map(fact).join('')}</section>` : ''}
    ${inferred.length ? `<section class="section"><h3>待确认</h3>${inferred.map(fact).join('')}</section>` : ''}
    <section class="section"><h3>任务 · ${tasks.length}</h3>${tasks.length ? tasks.map((task) => taskCard(task, { showIdea: false })).join('') : '<div class="empty">还没有任务</div>'}</section>
    <details class="section" ${records.length <= 3 ? 'open' : ''}><summary>记录 · ${records.length}</summary>${records.map(renderRecord).join('')}</details>`;
}

/** @param {any} record */
function renderRecord(record) {
  const images = record.images.map((/** @type {any} */ image) => `<img class="thumb" src="/api/uploads/${encodeURIComponent(image.id)}" alt="记录附图" />`).join('');
  const source = /** @type {Record<string, string>} */ ({ chat: '对话', quick_capture: '随手记', session_handoff: '会话交接', session_return: '任务回传', review: '修改意见' })[record.source] ?? record.source;
  return `<div class="record" data-record-id="${esc(record.id)}"><span class="text">${esc(record.text)}</span>${images}
    <span class="spread"><span class="subtle">${clock(record.createdAt)} · ${esc(source)}${record.movedFrom ? ` · 从「${esc(record.movedFrom.title)}」移来` : ''}</span>
    <span class="row tight">${record.attribution === 'inferred' ? `<span class="chip dashed">归属推断</span><button type="button" class="link small" data-action="confirm-record" data-record="${esc(record.id)}">对</button>` : ''}<button type="button" class="link small" data-action="move-record" data-record="${esc(record.id)}">不对</button><button type="button" class="link small danger-text" data-action="delete-record" data-record="${esc(record.id)}">删除</button></span></span></div>`;
}

// --------------------------------------------------------------------- modals

const modal = /** @type {HTMLDialogElement} */ ($('modal'));
/** @param {string} html @param {(form: HTMLFormElement) => Promise<void> | void} [onSubmit] */
function openModal(html, onSubmit) {
  modal.innerHTML = `<form method="dialog">${html}</form>`;
  const form = /** @type {HTMLFormElement} */ (modal.querySelector('form'));
  form.addEventListener('submit', async (event) => {
    const submitter = /** @type {HTMLButtonElement | null} */ (/** @type {SubmitEvent} */ (event).submitter);
    if (!submitter || submitter.value === 'cancel' || !onSubmit) return;
    event.preventDefault();
    submitter.disabled = true;
    try {
      await onSubmit(form);
      modal.close();
    } catch (error) {
      showError(error);
    } finally {
      submitter.disabled = false;
    }
  });
  modal.showModal();
}

/** @param {string} title @param {string} text @param {string} confirmLabel */
function confirmDialog(title, text, confirmLabel) {
  return new Promise((done) => {
    openModal(`<h2>${esc(title)}</h2><p class="subtle">${esc(text)}</p><div class="row end"><button value="cancel" class="secondary small">取消</button><button value="ok" class="primary small">${esc(confirmLabel)}</button></div>`, () => done(true));
    modal.addEventListener('close', () => done(false), { once: true });
  });
}

/** @param {string} recordId */
function moveRecordDialog(recordId) {
  const record = state.records.find((/** @type {any} */ item) => item.id === recordId);
  const options = state.ideas.filter((/** @type {any} */ idea) => idea.id !== record?.ideaId).map((/** @type {any} */ idea) => `<label class="option"><input type="radio" name="idea" value="${esc(idea.id)}" /><span>${esc(idea.title)}</span></label>`).join('');
  openModal(
    `<h2>记到哪个想法？</h2><p class="subtle">${esc(record?.text?.slice(0, 120) ?? '')}</p><div>${options || '<span class="subtle">没有其他想法</span>'}</div>
     <input type="text" name="newIdeaTitle" maxlength="80" placeholder="或者新建一个想法" />
     <div class="row end"><button value="cancel" class="secondary small">取消</button><button value="ok" class="primary small">改记过去</button></div>`,
    async (form) => {
      const data = new FormData(form);
      const newIdeaTitle = String(data.get('newIdeaTitle') ?? '').trim();
      const ideaId = String(data.get('idea') ?? '');
      if (!newIdeaTitle && !ideaId) throw new Error('选一个想法或写新想法的名字');
      const result = await post(`/api/records/${encodeURIComponent(recordId)}/move`, newIdeaTitle ? { newIdeaTitle } : { ideaId });
      ui.drawer = { kind: 'idea', id: result.idea.id, highlight: recordId };
      toast(`已改记到「${result.idea.title}」`);
    },
  );
}

/** @param {any} task */
function projectDialog(task) {
  const known = [...new Set(state.tasks.map((/** @type {any} */ t) => t.projectDir).filter(Boolean))];
  openModal(
    `<h2>「${esc(task.title)}」在哪做？</h2><p class="subtle">填项目文件夹的绝对路径（支持 ~/），任务会在这个目录里新开会话执行。留空表示不绑定项目。</p>
     ${known.length ? `<div class="options">${known.map((dir) => `<button type="button" class="option-chip" data-fill="${esc(dir)}"><span class="mono">${esc(dir)}</span></button>`).join('')}</div>` : ''}
     <input type="text" name="projectDir" value="${esc(task.projectDir ?? '')}" placeholder="例如 ~/projects/my-app" />
     <div class="row end"><button value="cancel" class="secondary small">取消</button><button value="ok" class="primary small">保存</button></div>`,
    async (form) => {
      await taskPost(task.id, 'project', { projectDir: String(new FormData(form).get('projectDir') ?? '') });
      toast('项目目录已更新');
    },
  );
  modal.querySelectorAll('[data-fill]').forEach((button) =>
    button.addEventListener('click', () => {
      /** @type {HTMLInputElement} */ (modal.querySelector('input[name="projectDir"]')).value = /** @type {HTMLElement} */ (button).dataset.fill ?? '';
    }),
  );
}

/** @param {any} task */
function reviseDialog(task) {
  openModal(
    `<h2>对「${esc(task.title)}」提修改意见</h2><p class="subtle">意见会回到原来的会话继续改，不用重新交代背景。</p>
     <div class="suggestions">${['把没满足的完成标准补上', '结论再精简一些', '补充来源和证据'].map((text) => `<button type="button" data-fill="${esc(text)}">${esc(text)}</button>`).join('')}</div>
     <textarea name="feedback" rows="4" required placeholder="比如：Claude Projects 那段再补一下"></textarea>
     <div class="row end"><button value="cancel" class="secondary small">取消</button><button value="ok" class="primary small">回到会话去改</button></div>`,
    async (form) => {
      await taskPost(task.id, 'revise', { feedback: String(new FormData(form).get('feedback') ?? '') });
      toast(`「${task.title}」回到进行中`);
    },
  );
  modal.querySelectorAll('[data-fill]').forEach((button) =>
    button.addEventListener('click', () => {
      const area = /** @type {HTMLTextAreaElement} */ (modal.querySelector('textarea'));
      area.value = area.value ? `${area.value}\n${/** @type {HTMLElement} */ (button).dataset.fill}` : /** @type {HTMLElement} */ (button).dataset.fill ?? '';
      area.focus();
    }),
  );
}

/** @param {string} taskId @param {number} index */
async function previewOutput(taskId, index) {
  const task = taskById(taskId);
  const output = task?.outputs[index];
  if (!output) return;
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/outputs/${index}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? '无法预览');
  }
  const type = response.headers.get('content-type') ?? '';
  let body;
  if (type.startsWith('image/')) body = `<img class="preview-img" src="${esc(URL.createObjectURL(await response.blob()))}" alt="${esc(base(output.file))}" />`;
  else if (type.startsWith('text/')) {
    const text = await response.text();
    body = /\.(md|markdown)$/i.test(output.file) ? `<div class="md preview" style="font-family:inherit;white-space:normal">${md(text)}</div>` : `<div class="preview">${esc(text)}</div>`;
  } else body = `<p class="subtle">这种文件不能在这里预览，请在文件夹里打开：</p><code>${esc(output.file)}</code>`;
  openModal(`<h2>${esc(base(output.file))}</h2><p class="subtle mono">${esc(output.file)}</p>${body}<div class="row end"><button value="cancel" class="secondary small">关闭</button></div>`);
}

function avatarDialog() {
  const current = state.settings.momoColor;
  openModal(
    `<h2>MoMo 的形象</h2><div class="color-row">${Object.keys(COLORS).map((color) => `<button type="button" class="swatch" data-action="pick-color" data-color="${color}" aria-pressed="${color === current && !state.settings.avatarUploadId}" aria-label="${color}" style="background:url('/collab/momo.svg') center/80% no-repeat, var(--mcode-bg-secondary);filter:${COLORS[color]}"></button>`).join('')}</div>
     <label class="secondary small" style="display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;width:max-content;border:1px solid var(--mcode-border-strong)">上传图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-action="avatar-file" hidden /></label>
     <div class="row end"><button value="cancel" class="secondary small">完成</button></div>`,
  );
}

// --------------------------------------------------------------------- actions

/** @param {any} task */
async function openSession(task) {
  if (!task.sessionId) return;
  track('collab_board_card_click', { task_id: task.id, status_type: task.status, action: 'session' });
  if (!agentApi?.open) {
    toast('这个页面不在 MiniMax Code 会话里打开，没法跳到会话');
    return;
  }
  try {
    await agentApi.open(task.sessionId);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    toast(code === 'session_not_found' ? '这个会话已经不存在了' : code === 'not_permitted' ? '请在 MiniMax Code 的会话侧栏里打开协作，才能跳到任务会话' : '打不开会话，稍后再试');
  }
}

/** @param {string} owner @param {string} requestId @param {QuestionAnswer[]} answers */
async function submitAnswers(owner, requestId, answers) {
  ui.answers.delete(requestId);
  if (owner === 'momo') await post('/api/momo/answer', { requestId, answers });
  else await taskPost(owner, 'answer', { requestId, answers });
}

/** @param {string} owner */
function pendingFor(owner) {
  return owner === 'momo' ? state.momo?.question : taskById(owner)?.question;
}

/** @param {string} owner @param {string} requestId @param {{ stepId?: string, otherText?: string }} [extra] */
function collectAnswers(owner, requestId, extra = {}) {
  const pending = pendingFor(owner);
  if (!pending || pending.requestId !== requestId) return null;
  const picked = ui.answers.get(requestId) ?? new Map();
  const log = $('drawer').hidden ? $('chat-log') : $('drawer-body');
  return pending.request.steps.map((/** @type {any} */ step) => {
    const ids = [...(picked.get(step.id) ?? [])];
    const input = /** @type {HTMLInputElement | null} */ (document.querySelector(`input[data-other="${CSS.escape(step.id)}"][data-request="${CSS.escape(requestId)}"]`) ?? log.querySelector(`input[data-other="${CSS.escape(step.id)}"]`));
    const otherText = extra.stepId === step.id ? extra.otherText ?? '' : input?.value.trim() ?? '';
    const selectedOther = Boolean(otherText);
    return {
      stepId: step.id,
      selectedOptionIds: ids,
      selectedOther,
      ...(selectedOther ? { otherText } : {}),
      ...(!ids.length && !selectedOther ? { skipped: true } : {}),
    };
  });
}

/** @param {File} file */
async function upload(file) {
  const response = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': file.type }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? '图片上传失败');
  return data.upload;
}

/** @param {FileList | File[]} files */
async function addFiles(files) {
  for (const file of [...files].slice(0, 9 - ui.attachments.length)) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const item = await upload(file);
      ui.attachments.push({ id: item.id, url: `/api/uploads/${encodeURIComponent(item.id)}` });
    } catch (error) {
      showError(error);
    }
  }
  renderComposer();
}

/** @param {string} text */
async function send(text) {
  const trimmed = text.trim();
  if (!trimmed && !ui.attachments.length) return;
  const attachments = ui.attachments.map((item) => item.id);
  ui.attachments = [];
  ui.report = null;
  try {
    await post('/api/chat', { text: trimmed, attachments, focusIdeaId: ui.focusIdeaId, source: ui.windowMode === 'window' ? 'quick_capture' : 'chat' });
  } catch (error) {
    showError(error);
  }
  scrollChat(true);
}

/** @param {'chat' | 'inbox' | 'board' | 'ideas'} view */
function go(view) {
  ui.view = view;
  track('collab_view', { view, entry: 'switch' });
  render();
}

const input = /** @type {HTMLTextAreaElement} */ ($('input'));
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
};
input.addEventListener('input', autosize);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (files.length) {
    event.preventDefault();
    void addFiles(files);
  }
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value;
  input.value = '';
  autosize();
  void send(text);
});
$('file-input').addEventListener('change', (event) => {
  const target = /** @type {HTMLInputElement} */ (event.target);
  if (target.files) void addFiles(target.files);
  target.value = '';
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files);
});
$('stop').addEventListener('click', () => void post('/api/chat/stop').catch(showError));
$('avatar-button').addEventListener('click', avatarDialog);
$('popout').addEventListener('click', () => {
  // Stays synchronous inside the click so the Host sees the user gesture.
  windowApi?.update({ mode: 'window', width: 1080, height: 720 }).catch(showError);
});

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (event.key === 'Escape' && ui.drawer && !modal.open) {
    ui.drawer = null;
    renderDrawer();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && target.matches('.task[role="button"]')) {
    event.preventDefault();
    target.click();
    return;
  }
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.dataset.other && target.value.trim()) {
    event.preventDefault();
    const owner = target.dataset.owner ?? '';
    const requestId = target.dataset.request ?? '';
    const answers = collectAnswers(owner, requestId, { stepId: target.dataset.other, otherText: target.value.trim() });
    if (answers) void submitAnswers(owner, requestId, answers).catch(showError);
  }
});

document.addEventListener('change', async (event) => {
  const target = /** @type {HTMLInputElement | HTMLSelectElement} */ (event.target);
  if (target.id === 'board-filter') {
    ui.boardFilter = target.value;
    renderSide();
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.action === 'avatar-file' && target.files?.[0]) {
    try {
      const item = await upload(target.files[0]);
      await post('/api/settings', { avatarUploadId: item.id });
      modal.close();
    } catch (error) {
      showError(error);
    }
  }
});

document.addEventListener('click', async (event) => {
  const target = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-action], [data-view]'));
  if (!target) return;
  if (target.matches('[role="tab"][data-view]')) {
    go(/** @type {any} */ (target.dataset.view));
    return;
  }
  const action = target.dataset.action;
  const task = target.dataset.task ? taskById(target.dataset.task) : undefined;
  if (action !== 'open-task') event.stopPropagation();
  try {
    switch (action) {
      case 'go':
        go(/** @type {any} */ (target.dataset.view));
        break;
      case 'suggest':
        if (target.dataset.text === '贴一张截图试试') /** @type {HTMLInputElement} */ ($('file-input')).click();
        else {
          // Fill, don't send (Multica/MiniMax Bot quick prompts): the user can edit first.
          input.value = target.dataset.text ?? '';
          autosize();
          input.focus();
        }
        break;
      case 'remove-attachment':
        ui.attachments = ui.attachments.filter((item) => item.id !== target.dataset.id);
        renderComposer();
        break;
      case 'close-drawer':
        ui.drawer = null;
        renderDrawer();
        break;
      case 'open-task':
        if (task) {
          ui.drawer = { kind: 'task', id: task.id };
          track('collab_board_card_click', { task_id: task.id, status_type: task.status });
          renderDrawer();
        }
        break;
      case 'open-idea':
        ui.drawer = { kind: 'idea', id: target.dataset.idea ?? '' };
        renderDrawer();
        break;
      case 'open-receipt':
        if (target.dataset.idea) ui.drawer = { kind: 'idea', id: target.dataset.idea, highlight: target.dataset.record || undefined };
        else go('ideas');
        renderDrawer();
        break;
      case 'focus-idea':
        ui.focusIdeaId = target.dataset.idea ?? null;
        ui.drawer = null;
        ui.view = 'chat';
        render();
        input.focus();
        break;
      case 'unfocus':
        ui.focusIdeaId = null;
        renderComposer();
        break;
      case 'dismiss-report':
        ui.report = null;
        renderChat();
        break;
      case 'report-task':
        if (task) {
          track('collab_report_click', { task_id: task.id, ...countBy(state.briefing.needs_you) });
          ui.drawer = { kind: 'task', id: task.id };
          renderDrawer();
        }
        break;
      case 'open-session':
        if (task) await openSession(task);
        break;
      case 'start-task':
        if (task) {
          await taskPost(task.id, 'start');
          await post('/api/track', { event: 'collab_board_card_click', fields: { task_id: task.id, status_type: task.status, action: 'start' } }).catch(() => {});
        }
        break;
      case 'defer-task':
        if (task) await taskPost(task.id, 'defer');
        break;
      case 'continue-task':
        if (task) await taskPost(task.id, 'continue');
        break;
      case 'stop-task':
        if (task && (await confirmDialog(`停止「${task.title}」？`, '会话会保留，之后可以点「继续执行」接着做。', '停止'))) await taskPost(task.id, 'stop');
        break;
      case 'stop-forget':
        if (task) await taskPost(task.id, 'defer');
        break;
      case 'set-project':
        if (task) projectDialog(task);
        break;
      case 'approve-task':
        if (task) {
          await taskPost(task.id, 'approve');
          toast(`「${task.title}」已完成`);
        }
        break;
      case 'revise-task':
        if (task) reviseDialog(task);
        break;
      case 'preview-output':
        await previewOutput(target.dataset.task ?? '', Number(target.dataset.index));
        break;
      case 'approval': {
        const owner = target.dataset.owner ?? '';
        const body = { requestId: target.dataset.request, decision: target.dataset.decision };
        target.closest('.inline-card')?.querySelectorAll('button').forEach((b) => ((/** @type {HTMLButtonElement} */ (b)).disabled = true));
        if (owner === 'momo') await post('/api/momo/approval', body);
        else await taskPost(owner, 'approval', body);
        break;
      }
      case 'pick-option': {
        const owner = target.dataset.owner ?? '';
        const requestId = target.dataset.request ?? '';
        const stepId = target.dataset.step ?? '';
        const optionId = target.dataset.option ?? '';
        const pending = pendingFor(owner);
        const step = pending?.request.steps.find((/** @type {any} */ s) => s.id === stepId);
        if (!step) break;
        const picked = ui.answers.get(requestId) ?? new Map();
        const set = new Set(step.selectionMode === 'multiple' ? picked.get(stepId) ?? [] : []);
        if (set.has(optionId)) set.delete(optionId);
        else set.add(optionId);
        picked.set(stepId, set);
        ui.answers.set(requestId, picked);
        if (target.dataset.quick === 'true') {
          const answers = collectAnswers(owner, requestId);
          if (answers) await submitAnswers(owner, requestId, answers);
        } else {
          renderChat();
          renderDrawer();
        }
        break;
      }
      case 'submit-answer':
      case 'skip-answer': {
        const owner = target.dataset.owner ?? '';
        const requestId = target.dataset.request ?? '';
        const pending = pendingFor(owner);
        if (!pending) break;
        const answers =
          action === 'skip-answer'
            ? pending.request.steps.map((/** @type {any} */ s) => ({ stepId: s.id, selectedOptionIds: [], selectedOther: false, skipped: true }))
            : collectAnswers(owner, requestId);
        if (answers) await submitAnswers(owner, requestId, answers);
        break;
      }
      case 'confirm-item':
        await post(`/api/ideas/${encodeURIComponent(target.dataset.idea ?? '')}/confirm-item`, { kind: target.dataset.kind, itemId: target.dataset.item });
        break;
      case 'confirm-record':
        await post(`/api/records/${encodeURIComponent(target.dataset.record ?? '')}/confirm`);
        break;
      case 'move-record':
        moveRecordDialog(target.dataset.record ?? '');
        break;
      case 'delete-record':
        if (await confirmDialog('删除这条记录？', '原话会从想法里移除，无法恢复。', '删除')) await post(`/api/records/${encodeURIComponent(target.dataset.record ?? '')}/delete`);
        break;
      case 'delete-idea': {
        const idea = ideaById(target.dataset.idea ?? '');
        if (idea && (await confirmDialog(`删除想法「${idea.title}」？`, `它的记录会变成未归属，不会丢${tasksOf(idea.id).length ? '；已有的任务会保留' : ''}。`, '删除'))) {
          await post(`/api/ideas/${encodeURIComponent(idea.id)}/delete`);
          ui.drawer = null;
          render();
        }
        break;
      }
      case 'rename-idea': {
        const idea = ideaById(target.dataset.idea ?? '');
        if (!idea) break;
        openModal(
          `<h2>改名</h2><input type="text" name="title" maxlength="80" value="${esc(idea.title)}" required /><div class="row end"><button value="cancel" class="secondary small">取消</button><button value="ok" class="primary small">保存</button></div>`,
          async (form) => {
            await post(`/api/ideas/${encodeURIComponent(idea.id)}/rename`, { title: String(new FormData(form).get('title') ?? '') });
          },
        );
        break;
      }
      case 'pick-color':
        await post('/api/settings', { momoColor: target.dataset.color, avatarUploadId: null });
        modal.close();
        break;
      default:
        break;
    }
  } catch (error) {
    showError(error);
  }
});

if (windowApi) {
  windowApi.getState().then((value) => {
    ui.windowMode = value.mode;
    render();
  }).catch(() => {});
  windowApi.onDidChangeState((value) => {
    ui.windowMode = value.mode;
    render();
  });
}

// Elapsed time on live lines and "x 分钟前" labels refresh without a server round trip.
setInterval(() => {
  if (!state) return;
  renderLive();
}, 15_000);

connect();
