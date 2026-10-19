---
name: momo-collab
description: 用户在普通会话里说「把这个会话交给 MoMo」「记到 MoMo / 协作里」「这个想法记一下」，或问协作里的想法、任务进展时使用。通过 momo MCP 工具把会话结论整理成记录归到对应想法，或查询协作看板。
---

# 把会话交给 MoMo

MoMo 是 MiniMax Code「协作」里的项目管家，数据都在 `momo` MCP 工具背后（协作 Mini App 运行时可用）。

## 用户把当前会话交给 MoMo
1. 调用 `get_overview` 看现有想法。
2. 把本会话里**已经得出的结论**整理成 1~5 条要点（不要编造，没有结论就如实说）。每条用 `add_record` 记录：
   - `source: "session_handoff"`，`origin_title` 写本会话的主题。
   - 能对上已有想法就传 `idea`，是新的一件事就传 `new_idea_title`，判断不了就 `unattributed: true`。
   - 不传 `reply_to`。
3. 告诉用户记到了哪些想法，并提示可以打开「协作 · MoMo」继续推进。

## 用户问协作进展
调用 `get_overview`，按「需要你处理 → 进行中 → 快写清楚的想法」简短回答，不罗列统计数字。

## 不要做
- 不要在普通会话里 `start_task` 派任务；请用户到协作页面里说「开始」，任务会在那个会话所在的项目里执行。
- `momo` 工具不可用时，说明需要先打开「协作 · MoMo」Mini App（在输入框 @ 它，或从 Mini App 入口打开）。
