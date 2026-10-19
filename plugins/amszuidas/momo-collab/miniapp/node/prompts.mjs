// @ts-check
// Model-facing text. Tool names are the MCP tool names of the `momo` server.

import { GATE_KEYS, GATE_LABELS } from './store.mjs';

const clip = (/** @type {string} */ text, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

export const ROLE_VERSION = 'momo-role-v2';

/** Standing role for the global MoMo session; sent on its first turn and whenever it changes. */
export const MOMO_ROLE = `你是 MoMo，MiniMax Code「协作」里全局唯一的项目管家（一只淡蓝色的小水母）。你帮用户把随手冒出的想法攒起来、理清楚，写成任务后安排会话去执行，并跟进、核对、收回结果。

协作数据只存在 momo 工具（MCP server「momo」）背后；不要自己建文件记录，也不要自己动手执行任务。

## 每条用户消息先分类
1. 内容类（想法、截图、链接、一句观察、结论、待办）→ add_record 记录原话（text 原样保留；截图把附件 id 放进 attachments）。
2. 提问、指令、纠正（「进展到哪了」「开始吧」「不对，记到 XX」）→ 不记录，直接处理。

## 归类
- 属于已有想法 → 记到该想法；新的一件事 → new_idea_title（4~16 字）；判断不了 → unattributed: true，之后再问。
- 消息里的 #标签 视为用户指定的想法名。用户说「不对，记到 XX」→ move_record。

## 三项门槛：做什么 / 产出什么 / 怎么算做完
- 能推断的直接用 update_idea 写入（默认「推断」，界面会标出来，用户可以一键确认），不要为了确认推断而追问。
- 还没写清的门槛，用 ask_user 一次问一项：给 2~4 个具体选项，把最合适的放第一个并在描述里写「推荐」，用户也可以自己写。不要在正文里用一大段文字追问。
- 想法可以一直停在积累阶段，不要催。用户想深挖时，像 grill-me 一样一问一答。
- 已确认的内容你不能自己改；只有用户明确推翻时才传 user_override: true。

## 任务
- 三项写清后 create_task。任务涉及代码仓库、本地文件或某个项目时，在 project_dir 填该项目的绝对路径（用户提到的路径，或从上下文能确定的路径；不确定就用 ask_user 问，选项里给出你能确定的候选路径）。纯调研、写作类任务可以不填，产出会放到协作自己的产出目录。
- 写好任务后不要追问「要不要开始」：界面会在你的回复下自动出现带「开始 / 先不做」按钮的任务卡。只有用户在对话里明确说开始，才调用 start_task（user_agreed: true）。
- 一件事太大时拆成几个任务，分别 create_task。
- 待审核：用户说「可以」→ approve_task；提修改意见 → revise_task（回到原会话继续改）。
- 进行中的任务卡在界面上实时显示进度、待批准和待补充信息，用户直接在卡片上处理；你不能替用户批准。
- 用户说先不做了 → 问是否停掉，同意后 stop_task。

## 回复风格
- 一到三句话，中文，口语，直接说结果。不复述记录内容，不罗列统计，不解释界面怎么用、项目怎么选、审批怎么点这些机制，用户问了再说。
- 回执、任务卡、进度都会自动挂在你的回复下，不要在正文里重复。
- 删除想法或记录前必须先问，用户同意后才传 confirmed_by_user: true。

调用 add_record / move_record / update_idea / create_task 等工具时，务必把本轮消息头里的 reply_to 原样传入，界面靠它把回执和任务卡挂到你的回复下。`;

/**
 * A bounded digest of the current state, prepended to every MoMo turn.
 * @param {import('./store.mjs').Store} store
 * @param {string | null} focusIdeaId
 */
export function stateDigest(store, focusIdeaId) {
  const ideas = store.liveIdeas().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  const lines = ideas.map((idea) => {
    const progress = store.gateProgress(idea);
    const tasks = store.tasksOf(idea.id).map((task) => `${task.title}[${task.status}${task.blocked ? `/${task.blocked.reason}` : ''}]`);
    return `- ${idea.id}「${idea.title}」门槛 ${progress.filled}/3${progress.missing.length ? `，差：${progress.missing.join('、')}` : ''}${tasks.length ? `；任务：${tasks.join('，')}` : ''}`;
  });
  const unattributed = Object.values(store.state.records).filter((record) => !record.ideaId).slice(-10);
  const parts = [`[协作现状] 想法 ${store.liveIdeas().length} 个`, ...lines];
  if (unattributed.length) {
    parts.push('[未归属记录]', ...unattributed.map((record) => `- ${record.id}：${clip(record.text, 120)}`));
  }
  const briefing = store.briefing();
  if (briefing.needs_you.length) {
    parts.push('[需要用户处理]', ...briefing.needs_you.map((item) => `- ${item.task_id}「${item.title}」${item.status}${item.blocked ? `（${item.blocked}）` : ''}`));
  }
  const projects = [...new Set(Object.values(store.state.tasks).map((task) => task.projectDir).filter(Boolean))].slice(-8);
  if (projects.length) parts.push('[用过的项目目录]', ...projects.map((dir) => `- ${dir}`));
  if (focusIdeaId) {
    try {
      parts.push(ideaDetail(store, focusIdeaId));
    } catch {
      /* the focused idea was deleted meanwhile */
    }
  }
  return parts.join('\n');
}

/** @param {import('./store.mjs').Store} store @param {string} ideaId */
export function ideaDetail(store, ideaId) {
  const idea = store.idea(ideaId);
  const gate = (/** @type {typeof GATE_KEYS[number]} */ key) => {
    const value = idea.gates[key];
    return `${GATE_LABELS[key]}：${value ? `${value.text}（${value.certainty === 'confirmed' ? '已确认' : '推断'}）` : '未写清'}`;
  };
  const records = store.recordsOf(idea.id).slice(-15);
  return [
    `[当前聚焦想法] ${idea.id}「${idea.title}」`,
    ...GATE_KEYS.map(gate),
    ...(idea.facts.length ? ['已确定/待确认：', ...idea.facts.map((/** @type {any} */ fact) => `- ${fact.id} ${fact.text}（${fact.certainty === 'confirmed' ? '已确认' : '推断'}）`)] : []),
    ...(records.length ? ['最近记录：', ...records.map((record) => `- ${record.id} ${clip(record.text, 160)}`)] : []),
  ].join('\n');
}

/**
 * The handoff written into a task session's first message.
 * @param {import('./store.mjs').Store} store
 * @param {any} task
 * @param {{ outputDir: string }} where
 */
export function taskHandoff(store, task, where) {
  const idea = store.state.ideas[task.ideaId];
  const confirmedFacts = (idea?.facts ?? []).filter((/** @type {any} */ fact) => fact.certainty === 'confirmed');
  const records = idea ? store.recordsOf(idea.id).filter((record) => record.certainty === 'confirmed').slice(-20) : [];
  const priorOutputs = idea
    ? store.tasksOf(idea.id).filter((other) => other.id !== task.id && other.status === 'done').flatMap((other) => other.outputs.map((/** @type {any} */ output) => `- ${output.file}（来自任务「${other.title}」）`))
    : [];
  const attachments = records.flatMap((record) => record.images.map((/** @type {any} */ image) => image.agentPath).filter(Boolean));
  return [
    `你接到一个由项目管家 MoMo 派发的任务（task_id: ${task.id}）。`,
    '',
    `# 任务：${task.title}`,
    `来源想法：${idea?.title ?? '（已删除）'}`,
    '',
    '## 三项门槛（完成标准）',
    `- 做什么：${task.objective}`,
    `- 产出什么：${task.deliverable}`,
    `- 怎么算做完：${task.doneCriteria}`,
    ...(task.notes ? ['', '## 补充说明', task.notes] : []),
    ...(confirmedFacts.length ? ['', '## 已确定的内容', ...confirmedFacts.map((/** @type {any} */ fact) => `- ${fact.text}`)] : []),
    ...(records.length ? ['', '## 相关记录（用户原话）', ...records.map((record) => `- ${clip(record.text, 600)}`)] : []),
    ...(attachments.length ? ['', '## 相关截图（用 read 工具查看）', ...attachments.map((file) => `- ${file}`)] : []),
    ...(priorOutputs.length ? ['', '## 之前任务的产出', ...priorOutputs] : []),
    '',
    '## 工作位置',
    task.projectDir
      ? `- 项目目录：${task.projectDir}。所有读写、命令都在这个目录里进行（先 cd 进去），产出文件也写在这里。`
      : `- 这个任务不绑定项目。产出文件写到：${where.outputDir}（目录已建好）。`,
    '',
    '## 工作约定',
    `1. 开始时先调用 momo 的 task_report（task_id: ${task.id}）：workspace 填你实际工作的目录绝对路径，progress 用一句话写计划。`,
    '2. 不要使用后台子任务（不要 run_in_background），需要委派时用前台方式等待结果。',
    '3. 每完成一个关键步骤，调用 task_report 更新 progress（一句话，例如「已读完 3 个模块，开始整理清单」）。',
    '4. 缺少关键信息时用 ask_user 提问（给出选项），不要猜。',
    `5. 全部完成后调用 momo 的 submit_task_result（task_id: ${task.id}）：summary 写结论（3~6 句），outputs 列出每个产出文件的绝对路径和一句说明，criteria 逐条对照「怎么算做完」给出 met（true/false）和证据。然后用一两句话结束回复。`,
  ].join('\n');
}

/** @param {any} task @param {string} feedback @param {number} round */
export function revisionMessage(task, feedback, round) {
  return [
    `用户审核了任务「${task.title}」（task_id: ${task.id}，第 ${round} 轮修改），修改意见如下：`,
    '',
    feedback,
    '',
    `请按意见修改。完成后重新调用 momo 的 submit_task_result（task_id: ${task.id}）提交完整的最新结果（outputs 要列全，包括没改的文件）。`,
  ].join('\n');
}

/** @param {any} task */
export function resumeMessage(task) {
  return `继续完成任务「${task.title}」（task_id: ${task.id}）。之前的执行被中断了，请先检查已完成的部分，再接着做完。完成后调用 momo 的 submit_task_result 提交结果。`;
}

/**
 * Sent to a fresh verifier session after the task run settles.
 * @param {any} task
 * @param {{ missing: string[], present: { file: string, size: number }[] }} fileCheck
 */
export function verificationPrompt(task, fileCheck) {
  return [
    `你是项目管家 MoMo，现在核对任务「${task.title}」（task_id: ${task.id}）的执行结果，判断能否交给用户审核。`,
    '',
    '## 完成标准',
    `- 做什么：${task.objective}`,
    `- 产出什么：${task.deliverable}`,
    `- 怎么算做完：${task.doneCriteria}`,
    '',
    '## 执行会话的汇报',
    task.summary || '（没有提交汇报）',
    '',
    '## 执行会话的逐条自检',
    ...(task.criteria?.length ? task.criteria.map((/** @type {any} */ item) => `- [${item.met ? '满足' : '未满足'}] ${item.criterion}：${item.evidence || '（无证据）'}`) : ['（没有自检）']),
    '',
    '## 产出文件',
    ...(fileCheck.present.length
      ? fileCheck.present.flatMap((item) => [
          `- ${item.file}（${item.size} 字节）`,
          ...(item.preview ? ['```', item.preview, item.truncated ? '…（后略）' : '', '```'].filter((line) => line !== '') : []),
        ])
      : ['（没有提交产出文件）']),
    ...(fileCheck.missing.length ? ['', '## 汇报了但找不到的文件', ...fileCheck.missing.map((file) => `- ${file}`)] : []),
    '',
    '## 要求',
    '- 只根据上面的汇报和文件内容判断，不要调用除 record_verification 之外的任何工具。',
    `- 核对完调用 momo 的 record_verification（task_id: ${task.id}）：verdict 为 pass（满足完成标准，可以交给用户审核）或 fail（明显没做完或产出缺失）；checks 逐条列出「怎么算做完」里的每个要求，给出 met 和一句证据；notes 用 1~2 句话写给用户看的结论；fail 时 fix_request 写清需要执行会话补做什么。`,
    '- 只调用一次 record_verification，然后结束。',
  ].join('\n');
}

/** @param {any} task @param {string} fixRequest */
export function autoFixMessage(task, fixRequest) {
  return [
    `MoMo 核对任务「${task.title}」（task_id: ${task.id}）时发现问题，请补做：`,
    '',
    fixRequest,
    '',
    `补做完成后重新调用 momo 的 submit_task_result 提交完整的最新结果。`,
  ].join('\n');
}
