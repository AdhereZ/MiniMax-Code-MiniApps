// @ts-check
// Streamable HTTP MCP server "momo": the only way the Agent reads or writes collaboration data.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DomainError, GATE_KEYS, GATE_LABELS, newId } from './store.mjs';
import { ideaDetail } from './prompts.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const replyTo = { type: 'string', description: '本轮消息头里的 reply_to，原样传入；不在 MoMo 对话里时省略' };
const ideaRef = { type: 'string', description: '想法 id（idea_xxx）或完整想法名' };
const taskId = { type: 'string', pattern: '^task_[a-f0-9]{10}$', description: '任务 id（task_xxx）' };

/** @param {Record<string, unknown>} properties @param {string[]} [required] */
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'get_overview',
    description: '读取协作全貌：全部想法（门槛进度）、未归属记录、需要用户处理的任务、进行中的任务。回答「进展到哪了」「哪些事要我处理」时先调用。',
    inputSchema: schema({}),
  },
  {
    name: 'get_idea',
    description: '读取一个想法的详情：三项门槛、已确定/待确认的内容、任务、产出和记录。',
    inputSchema: schema({ idea: ideaRef }, ['idea']),
  },
  {
    name: 'add_record',
    description:
      '把用户丢进来的一条内容（原话、截图、链接、结论）记成一条记录。三选一：idea 记到已有想法；new_idea_title 新建想法并记进去；unattributed: true 记为未归属。提问、指令、纠正不要调用。',
    inputSchema: schema(
      {
        text: { type: 'string', maxLength: 20000, description: '用户原话，原样保留' },
        idea: ideaRef,
        new_idea_title: { type: 'string', maxLength: 80, description: '新想法的名字，4~16 个字' },
        unattributed: { type: 'boolean', description: '判断不了归属时为 true' },
        attachments: { type: 'array', maxItems: 9, items: { type: 'string' }, description: '本条消息附件 id' },
        source: { type: 'string', enum: ['chat', 'quick_capture', 'session_handoff'], description: '默认 chat；用户把普通会话交给 MoMo 时用 session_handoff' },
        origin_title: { type: 'string', maxLength: 120, description: '出处说明，如来源会话标题' },
        reply_to: replyTo,
      },
      ['text'],
    ),
  },
  {
    name: 'move_record',
    description: '用户说「不对，记到 XX」时把记录改记到另一个想法（或新建想法）。改记后归属变为已确认。',
    inputSchema: schema(
      { record_id: { type: 'string' }, idea: ideaRef, new_idea_title: { type: 'string', maxLength: 80 }, reply_to: replyTo },
      ['record_id'],
    ),
  },
  {
    name: 'confirm_record',
    description: '用户明确说这条记录和它的归属是对的时调用，去掉「推断」标签。',
    inputSchema: schema({ record_id: { type: 'string' }, reply_to: replyTo }, ['record_id']),
  },
  {
    name: 'update_idea',
    description:
      '更新想法：改名、写三项门槛（objective 做什么 / deliverable 产出什么 / done_criteria 怎么算做完）、追加已确定或待确认的内容。MoMo 推断的写入默认为「推断」；用户明确认可时 confirmed: true。已确认的门槛只有用户明确推翻时才传 user_override: true。',
    inputSchema: schema(
      {
        idea: ideaRef,
        title: { type: 'string', maxLength: 80 },
        objective: { type: 'string', maxLength: 2000 },
        deliverable: { type: 'string', maxLength: 2000 },
        done_criteria: { type: 'string', maxLength: 2000 },
        facts: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 2000 }, description: '已确定或待确认的要点' },
        confirmed: { type: 'boolean', description: '用户明确认可这些内容' },
        user_override: { type: 'boolean', description: '用户明确推翻了已确认的内容' },
        reply_to: replyTo,
      },
      ['idea'],
    ),
  },
  {
    name: 'revise_item',
    description: '确认、修正或删除想法里的一项门槛或要点。item_kind=gate 时 item_id 为 objective/deliverable/done_criteria；item_kind=fact 时为 fact_xxx。已确认内容只有用户明确推翻时才能改（user_override: true）。',
    inputSchema: schema(
      {
        idea: ideaRef,
        item_kind: { type: 'string', enum: ['gate', 'fact'] },
        item_id: { type: 'string' },
        action: { type: 'string', enum: ['confirm', 'correct', 'remove'] },
        text: { type: 'string', maxLength: 2000, description: 'correct 时的新内容' },
        user_override: { type: 'boolean' },
        reply_to: replyTo,
      },
      ['idea', 'item_kind', 'item_id', 'action'],
    ),
  },
  {
    name: 'delete_record',
    description: '删除一条记录。必须先问用户，用户同意后才传 confirmed_by_user: true。',
    inputSchema: schema({ record_id: { type: 'string' }, confirmed_by_user: { type: 'boolean' } }, ['record_id', 'confirmed_by_user']),
  },
  {
    name: 'delete_idea',
    description: '删除一个想法；它的记录变为未归属，已产出的任务保留。必须先问用户，用户同意后才传 confirmed_by_user: true。',
    inputSchema: schema({ idea: ideaRef, confirmed_by_user: { type: 'boolean' }, reply_to: replyTo }, ['idea', 'confirmed_by_user']),
  },
  {
    name: 'create_task',
    description:
      '三项门槛都写清后，把想法写成一个待办任务（门槛自动带入）。界面会在你的回复下挂带「开始 / 先不做」按钮的任务卡，不要再追问要不要开始。涉及代码仓库、本地文件或某个项目时必须填 project_dir。',
    inputSchema: schema(
      {
        idea: ideaRef,
        title: { type: 'string', maxLength: 80, description: '任务名，也是执行会话的名字，10~24 字' },
        project_dir: { type: 'string', maxLength: 4096, description: '任务要在其中工作的项目目录绝对路径，例如 /Users/me/projects/app；纯调研、写作类任务可以省略' },
        notes: { type: 'string', maxLength: 4000 },
        reply_to: replyTo,
      },
      ['idea', 'title'],
    ),
  },
  {
    name: 'update_task',
    description: '修改还没开始的待办任务：改任务名、补项目目录或补充说明。',
    inputSchema: schema(
      { task_id: taskId, title: { type: 'string', maxLength: 80 }, project_dir: { type: 'string', maxLength: 4096 }, notes: { type: 'string', maxLength: 4000 } },
      ['task_id'],
    ),
  },
  {
    name: 'start_task',
    description: '用户在对话里明确同意开始时调用：新任务新开会话执行（工作目录为任务的 project_dir）；已有会话的任务回到原会话继续。',
    inputSchema: schema({ task_id: taskId, user_agreed: { type: 'boolean', description: '用户已明确同意开始' }, reply_to: replyTo }, ['task_id', 'user_agreed']),
  },
  {
    name: 'approve_task',
    description: '用户审核待审核任务后说「可以」时调用：任务变为已完成，结论和产出收回想法。',
    inputSchema: schema({ task_id: taskId, reply_to: replyTo }, ['task_id']),
  },
  {
    name: 'revise_task',
    description: '用户对待审核（或已完成）的任务提修改意见时调用：意见记入想法，任务回到原会话继续改，状态回到进行中。',
    inputSchema: schema({ task_id: taskId, feedback: { type: 'string', maxLength: 8000, description: '用户的修改意见原话' }, reply_to: replyTo }, ['task_id', 'feedback']),
  },
  {
    name: 'stop_task',
    description: '用户说进行中的任务先不做了，且同意停掉会话时调用；任务回到待办，会话保留。',
    inputSchema: schema({ task_id: taskId, user_agreed: { type: 'boolean' } }, ['task_id', 'user_agreed']),
  },
  {
    name: 'task_report',
    description: '【执行会话专用】任务执行会话开工时和关键进展时调用：workspace 填当前工作目录绝对路径，progress 一句话进展。',
    inputSchema: schema({ task_id: taskId, workspace: { type: 'string', maxLength: 4096 }, progress: { type: 'string', maxLength: 200 } }, ['task_id']),
  },
  {
    name: 'submit_task_result',
    description: '【执行会话专用】任务完成后提交结论和全部产出文件，交给 MoMo 核对。',
    inputSchema: schema(
      {
        task_id: taskId,
        summary: { type: 'string', maxLength: 8000, description: '结论' },
        outputs: {
          type: 'array',
          maxItems: 50,
          items: schema({ file: { type: 'string', maxLength: 4096, description: '产出文件绝对路径' }, description: { type: 'string', maxLength: 300 } }, ['file']),
        },
        criteria: {
          type: 'array',
          maxItems: 20,
          description: '逐条对照「怎么算做完」',
          items: schema({ criterion: { type: 'string', maxLength: 300 }, met: { type: 'boolean' }, evidence: { type: 'string', maxLength: 600 } }, ['criterion', 'met']),
        },
      },
      ['task_id', 'summary', 'outputs'],
    ),
  },
  {
    name: 'record_verification',
    description: '【MoMo 核对会话专用】提交对任务结果的核对结论。',
    inputSchema: schema(
      {
        task_id: taskId,
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        notes: { type: 'string', maxLength: 1000, description: '写给用户看的 1~2 句核对结论' },
        checks: {
          type: 'array',
          maxItems: 20,
          description: '逐条核对「怎么算做完」里的每个要求',
          items: schema({ criterion: { type: 'string', maxLength: 300 }, met: { type: 'boolean' }, evidence: { type: 'string', maxLength: 600 } }, ['criterion', 'met']),
        },
        fix_request: { type: 'string', maxLength: 2000, description: 'fail 时需要补做的内容' },
      },
      ['task_id', 'verdict', 'notes', 'checks'],
    ),
  },
];
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/** @param {unknown} value */
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {{ store: import('./store.mjs').Store, engine: import('./engine.mjs').Engine, pageCount: () => number, resolveAttachments: (ids: string[]) => Promise<any[]> }} deps
 */
export function createMcpHandler({ store, engine, pageCount, resolveAttachments }) {
  /** @param {string} ref */
  const idea = (ref) => {
    const found = store.findIdea(ref);
    if (!found) throw new DomainError('not_found', `找不到想法「${ref}」，先用 get_overview 看看现有想法`);
    return found;
  };
  /** @param {any} item */
  const ideaView = (item) => ({ idea_id: item.id, title: item.title, progress: store.gateProgress(item) });
  /**
   * Normalizes a model-supplied project folder: `~` expansion, absolute, existing, not MiniMax
   * Code's own data. Empty means "no project".
   * @param {unknown} value
   */
  const projectArg = async (value) => {
    const raw = str(value);
    if (!raw) return null;
    const dir = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
    const problem = await engine.checkProjectDir(resolve(dir));
    if (problem) throw new DomainError('invalid', `${problem}。请向用户确认正确的项目路径`);
    return resolve(dir);
  };

  /** @param {string} name @param {Record<string, any>} args */
  async function callTool(name, args) {
    switch (name) {
      case 'get_overview': {
        const ideas = store.liveIdeas().sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({
          ...ideaView(item),
          tasks: store.tasksOf(item.id).map((task) => ({ task_id: task.id, title: task.title, status: task.status, blocked: task.blocked?.reason ?? null })),
          record_count: store.recordsOf(item.id).length,
        }));
        const unattributed = Object.values(store.state.records).filter((record) => !record.ideaId).map((record) => ({ record_id: record.id, text: record.text.slice(0, 300) }));
        return { ideas, unattributed_records: unattributed, ...store.briefing(), open_pages: pageCount() };
      }
      case 'get_idea': {
        const item = idea(args.idea);
        const tasks = store.tasksOf(item.id).map((task) => ({
          task_id: task.id,
          title: task.title,
          status: task.status,
          blocked: task.blocked,
          summary: task.summary,
          outputs: task.outputs,
          verification: task.verification,
          review_round: task.reviewRound,
        }));
        return { detail: ideaDetail(store, item.id), tasks, records: store.recordsOf(item.id).map((record) => ({ record_id: record.id, text: record.text, certainty: record.certainty, attribution: record.attribution, source: record.source })) };
      }
      case 'add_record': {
        const choices = [Boolean(str(args.idea)), Boolean(str(args.new_idea_title)), args.unattributed === true].filter(Boolean).length;
        if (choices !== 1) throw new DomainError('invalid', 'idea、new_idea_title、unattributed 三选一');
        const images = await resolveAttachments(Array.isArray(args.attachments) ? args.attachments.map(String) : []);
        const target = args.unattributed === true ? null : str(args.new_idea_title) ? { newIdeaTitle: str(args.new_idea_title) } : idea(args.idea).id;
        const { record, idea: owner, createdIdea } = await store.addRecord({
          text: String(args.text ?? ''),
          target,
          images,
          source: str(args.source) || 'chat',
          certainty: 'confirmed',
          attribution: 'inferred',
          originTitle: str(args.origin_title) || undefined,
        });
        await engine.receipt(str(args.reply_to) || undefined, {
          kind: createdIdea ? 'new_idea' : owner ? 'record' : 'unattributed',
          recordId: record.id,
          ideaId: owner?.id ?? null,
          ideaTitle: owner?.title ?? null,
          excerpt: record.text.slice(0, 60),
        });
        return { record_id: record.id, idea: owner ? ideaView(owner) : null, created_idea: createdIdea };
      }
      case 'move_record': {
        if (Boolean(str(args.idea)) === Boolean(str(args.new_idea_title))) throw new DomainError('invalid', 'idea 和 new_idea_title 二选一');
        const target = str(args.new_idea_title) ? { newIdeaTitle: str(args.new_idea_title) } : idea(args.idea).id;
        const { record, idea: to, from } = await store.moveRecord(str(args.record_id), target);
        await engine.receipt(str(args.reply_to) || undefined, {
          kind: 'moved',
          recordId: record.id,
          ideaId: to.id,
          ideaTitle: to.title,
          fromTitle: from?.title ?? '未归属',
          excerpt: record.text.slice(0, 60),
        });
        return { record_id: record.id, idea: ideaView(to), moved_from: from?.title ?? '未归属' };
      }
      case 'confirm_record': {
        const record = await store.confirmRecord(str(args.record_id));
        return { record_id: record.id, attribution: record.attribution };
      }
      case 'update_idea': {
        let item = idea(args.idea);
        if (str(args.title)) item = await store.renameIdea(item.id, str(args.title));
        const gates = Object.fromEntries(GATE_KEYS.filter((key) => str(args[key])).map((key) => [key, str(args[key])]));
        let gateResult;
        if (Object.keys(gates).length) {
          gateResult = await store.updateGates(item.id, gates, { confirmed: args.confirmed === true, userOverride: args.user_override === true });
        }
        const facts = Array.isArray(args.facts) ? args.facts.map(str).filter(Boolean) : [];
        for (const fact of facts) await store.addFact(item.id, fact, args.confirmed === true);
        const progress = store.gateProgress(store.idea(item.id));
        if (gateResult?.changed.length) {
          await engine.receipt(str(args.reply_to) || undefined, { kind: 'gates', ideaId: item.id, ideaTitle: item.title, changed: gateResult.changed, filled: progress.filled });
        }
        return {
          idea: ideaView(store.idea(item.id)),
          gates_changed: gateResult?.changed ?? [],
          gates_refused_confirmed: gateResult?.refused ?? [],
          ready_for_task: progress.filled === GATE_KEYS.length,
          ...(gateResult?.refused.length ? { note: `这些门槛用户已确认，没有修改：${gateResult.refused.join('、')}。只有用户明确推翻时才传 user_override: true` } : {}),
        };
      }
      case 'revise_item': {
        const item = idea(args.idea);
        const updated = await store.reviseItem(
          item.id,
          { kind: args.item_kind, id: str(args.item_id), text: str(args.text) },
          args.action,
          { userOverride: args.user_override === true },
        );
        return { idea: ideaView(updated) };
      }
      case 'delete_record': {
        if (args.confirmed_by_user !== true) throw new DomainError('confirm_required', '删除前先问用户，用户同意后再调用');
        const record = await store.deleteRecord(str(args.record_id));
        return { deleted: record.id };
      }
      case 'delete_idea': {
        if (args.confirmed_by_user !== true) throw new DomainError('confirm_required', '删除前先问用户，用户同意后再调用');
        const { idea: removed, keptTasks } = await store.deleteIdea(idea(args.idea).id, 'momo');
        await store.emit('collab_confirm_ask', { action_type: 'delete', result: 'agree' });
        return {
          deleted: removed.title,
          kept_tasks: keptTasks.map((task) => ({ task_id: task.id, title: task.title, status: task.status })),
          note: keptTasks.length ? '已产出的任务保留了，问用户要不要一起处理' : undefined,
        };
      }
      case 'create_task': {
        const owner = idea(args.idea);
        const projectDir = await projectArg(args.project_dir);
        const task = await store.createTask({ ideaId: owner.id, title: str(args.title), notes: str(args.notes), projectDir });
        await engine.receipt(str(args.reply_to) || undefined, { kind: 'task_card', taskId: task.id });
        return {
          task_id: task.id,
          title: task.title,
          status: task.status,
          project_dir: task.projectDir,
          next: '任务卡已挂在你的回复下，用户点「开始」或在对话里说开始时再 start_task；不要追问要不要开始',
        };
      }
      case 'update_task': {
        const task = store.task(str(args.task_id));
        if (task.status !== 'todo' || task.sessionId) throw new DomainError('invalid', '只能修改还没开始的待办任务');
        const projectDir = args.project_dir === undefined ? undefined : await projectArg(args.project_dir);
        await store.updateTask(task.id, {
          blocked: projectDir !== undefined && task.blocked?.reason === 'project_unavailable' ? null : undefined,
          patch: {
            ...(str(args.title) ? { title: str(args.title).slice(0, 80) } : {}),
            ...(projectDir !== undefined ? { projectDir } : {}),
            ...(str(args.notes) ? { notes: str(args.notes).slice(0, 4000) } : {}),
          },
        });
        const updated = store.task(task.id);
        return { task_id: updated.id, title: updated.title, project_dir: updated.projectDir };
      }
      case 'start_task': {
        if (args.user_agreed !== true) {
          await store.emit('collab_confirm_ask', { action_type: 'dispatch', result: 'no_reply' });
          throw new DomainError('confirm_required', '派任务前先问用户，用户同意后再调用');
        }
        await store.emit('collab_confirm_ask', { action_type: 'dispatch', result: 'agree' });
        const result = await engine.requestDispatch(str(args.task_id), null);
        const task = store.task(str(args.task_id));
        await engine.receipt(str(args.reply_to) || undefined, { kind: 'task_card', taskId: task.id });
        return { task_id: task.id, mode: result.mode, project_dir: task.projectDir, note: '进度会实时显示在任务卡上，不必在回复里复述' };
      }
      case 'approve_task': {
        await engine.approveTask(str(args.task_id));
        const task = store.task(str(args.task_id));
        await engine.receipt(str(args.reply_to) || undefined, { kind: 'task_done', taskId: task.id, ideaId: task.ideaId, taskTitle: task.title });
        return { task_id: task.id, status: task.status };
      }
      case 'revise_task': {
        await engine.reviseTask(str(args.task_id), String(args.feedback ?? ''));
        const task = store.task(str(args.task_id));
        return { task_id: task.id, status: task.status, review_round: task.reviewRound, note: '修改意见已收进想法，任务回到原会话继续改' };
      }
      case 'stop_task': {
        if (args.user_agreed !== true) throw new DomainError('confirm_required', '停掉会话前先问用户');
        await engine.stopTask(str(args.task_id));
        return { task_id: str(args.task_id), note: '已停止，任务回到待办，会话保留' };
      }
      case 'task_report': {
        const task = store.task(str(args.task_id));
        const workspace = str(args.workspace);
        await store.updateTask(task.id, {
          patch: {
            ...(workspace ? { workspace } : {}),
            ...(str(args.progress) ? { progress: str(args.progress).slice(0, 200) } : {}),
          },
        });
        return { ok: true };
      }
      case 'submit_task_result': {
        const outputs = (Array.isArray(args.outputs) ? args.outputs : [])
          .map((output) => ({ file: str(output?.file), description: str(output?.description) }))
          .filter((output) => output.file);
        const criteria = (Array.isArray(args.criteria) ? args.criteria : [])
          .map((item) => ({ criterion: str(item?.criterion), met: item?.met === true, evidence: str(item?.evidence) }))
          .filter((item) => item.criterion);
        await engine.submitResult(str(args.task_id), { summary: str(args.summary), outputs, criteria });
        return { ok: true, note: 'MoMo 会核对后交给用户审核。请用一两句话结束本轮回复。' };
      }
      case 'record_verification': {
        const checks = (Array.isArray(args.checks) ? args.checks : [])
          .map((item) => ({ criterion: str(item?.criterion), met: item?.met === true, evidence: str(item?.evidence) }))
          .filter((item) => item.criterion);
        await engine.recordVerification(str(args.task_id), {
          verdict: args.verdict === 'fail' ? 'fail' : 'pass',
          notes: str(args.notes),
          fixRequest: str(args.fix_request),
          checks,
        });
        return { ok: true };
      }
      default:
        throw new DomainError('invalid', `未知工具 ${name}`);
    }
  }

  const sessions = new Set();

  /** @param {any} message */
  async function handleRpc(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'momo', version: '0.2.0' },
            instructions: `MoMo 协作工具：想法、记录、三项门槛（${GATE_KEYS.map((key) => GATE_LABELS[key]).join(' / ')}）、任务。普通会话里用户说「把这个会话交给 MoMo」时，把会话结论用 add_record（source: session_handoff）记进对应想法。`,
          },
        };
      }
      case 'ping':
        return isNotification ? undefined : { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = params?.name;
        if (!TOOL_NAMES.has(name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        try {
          const value = await callTool(name, params?.arguments ?? {});
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] } };
        } catch (error) {
          const text = error instanceof DomainError ? `${error.code}: ${error.message}` : '内部错误';
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
        }
      }
      default:
        if (isNotification) return undefined;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {unknown} body
   */
  return async function handleMcp(request, response, body) {
    if (request.method === 'DELETE') {
      sessions.delete(request.headers['mcp-session-id']);
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    let session = request.headers['mcp-session-id'];
    if (session && !sessions.has(session)) {
      response.writeHead(404).end();
      return;
    }
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!batch && /** @type {any} */ (body)?.method === 'initialize') {
      session = newId('mcp');
      sessions.add(session);
      response.setHeader('mcp-session-id', session);
    }
    const replies = (await Promise.all(messages.map(handleRpc))).filter((reply) => reply !== undefined);
    if (!replies.length) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(batch ? replies : replies[0]));
  };
}
