# MoMo Collab

English | [简体中文](README.zh-CN.md)

MoMo is a project steward for MiniMax Code. Drop a half-formed thought, a screenshot, or a link on MoMo and it files the note under the right idea. MoMo helps you think the idea through and, once it is clear, writes it up as a task. After you agree, it runs the task in an Agent session. It hands over the background, follows progress, checks the result against your done criteria, and brings the conclusion back to the idea. A board shows every task as To do, In progress, In review, or Done.

Author: [amszuidas](https://github.com/amszuidas) · Version: `0.2.0`

![MoMo Collab with synthetic data: a chat with MoMo, a running task card, and the "needs you" rail](docs/preview.png)

*The preview uses synthetic data. The app interface is currently in Chinese.*

## Install and open

Copy this entire directory, including the hidden `.minimax-plugin` directory, to `<dataDir>/plugins/momo-collab/`. By default `<dataDir>` is `~/.minimax`. Restart MiniMax Code and confirm the plugin is recognized and enabled.

Open it from a **project conversation** (one with a project folder): type `@协作 · MoMo` in the input box and send, or open it from the Mini App entry in the conversation's side panel. The page can be popped out into its own window. Tasks run in the project of the conversation the page is open in, unless MoMo sets another folder on the task.

## What it does

- **One conversation with MoMo.** Send a sentence, a screenshot, or a link. MoMo files it as a record under an existing idea, opens a new idea, or keeps it unattributed, and shows a receipt under its reply. Say "不对，记到 X" to move a record.
- **Ideas.** Each idea tracks three things: what to do, what to produce, and how to tell it is done. Each is marked as confirmed or inferred. An idea also keeps its records, decisions, tasks, and outputs. MoMo can question you one item at a time to sharpen an idea.
- **Tasks.** When all three are clear, MoMo writes a task card. Press **开始** (Start) to run it, or **先不做** (Later) to park it. Starting creates a new Agent session with the full handoff: goal, deliverable, done criteria, confirmed facts, and records. Task status follows that session; the board has no drag-and-drop and no manual status buttons.
- **Live progress.** While a task runs, its card shows elapsed time, the current tool, and the step count. Click the card to open the task session in the chat side panel and watch it or take over.
- **Blocked tasks.** Cards show why a task is blocked (needs approval, needs information, run failed, or project unavailable) and offer the one next step: approve or deny, answer, retry, or set a project folder.
- **Review.** When a session submits, MoMo checks the outputs against each done criterion in a separate session, then hands the task to you. Approve it, or send change requests back to the same session.
- **Hand a chat to MoMo.** In any ordinary conversation, say "把这个会话交给 MoMo". The bundled Skill files that conversation's conclusions as records under the matching idea (MoMo Collab must be running).
- **Coming back.** When you return after a while, MoMo lists what needs you. The **试用指标** (Trial metrics) page summarizes local usage.

![The board with synthetic data](docs/board.png)

## Tested environment

- MiniMax Code 3.1.3 (internal preview build) on macOS 26.6. The package declares `agentAccess`, `agentConcurrency`, and `surface.window`, so MiniMax Code 3.1.2 or later is required.
- Windows has not been tested.
- The task lifecycle (create, start, host stop, continue, approval, submit, verification, review, done) was also exercised end to end against the real Node entry and MCP endpoint with a mock Agent, and the page was checked in a browser at 1180 px and 420 px widths.

## Data & access

- **Agent turns.** The package declares `agentAccess: ["session.run"]` with `agentConcurrency: 8`. It runs three kinds of Agent turns, each with the Agent's full capabilities (files, shell, Skills, MCP):
  - **MoMo**: one long-lived session that files records, maintains ideas, and writes tasks through this plugin's `momo` MCP tools.
  - **Task sessions**: one per task. The page creates each one with `agent.create()`, so it uses that conversation's agent, model, and project folder. The first message hands over the task and asks the Agent to report progress and submit outputs through the `momo` tools.
  - **Verification**: a separate session per check that reads the submitted outputs and records a pass or fail for each done criterion.
- **Approvals.** Every `permission.requested` is shown on the task card or in the chat. `allowOnce` is sent only after you click it; nothing is approved automatically. A failed task run is retried once automatically, in the same session, with a message asking the Agent to pick up where it left off. That happens when the turn ends with `status: "error"`, or when the call is rejected as retryable before any tool started. `AGENT_OUTCOME_UNKNOWN` is never retried.
- **Files written by the plugin:**
  - `context.dataDir/state.json`: ideas, records, tasks, and chat, written atomically through a temporary file and rename.
  - `context.dataDir/telemetry.jsonl`: local usage events for the trial metrics page. Nothing is uploaded.
  - An Agent-readable folder next to the Host's per-agent data: `<dataDir>/agents/mavis/miniapps/momo-collab/`. Its `uploads/` subfolder holds images you attach. Its `outputs/<taskId>/` subfolder holds outputs of tasks that have no project folder. The plugin locates it from `context.dataDir` by going up four levels. This relies on the current, unspecified layout of the Host data directory; when that folder does not exist, the plugin uses `context.dataDir` instead. It is used because the primary agent can read it without an approval prompt, so a task can read your screenshots.
- **Files read outside `dataDir`.** The page previews a task output (at most 5 MiB) only if the task session reported that path. The verifier reads text outputs the same way. Anything inside the MiniMax Code data directory is refused, except the outputs folder above. A project folder must be an existing absolute directory and may not be inside the MiniMax Code data directory.
- **Files written by the Agent.** Task sessions work in the project folder, and they may create or change files there as the task requires. That is the point of a task, and it is subject to your approvals.
- **Processes.** None spawned by the plugin.
- **Network.** The Node service makes no outbound requests, and the page loads no remote resources.
- **Browser storage.** `sessionStorage` keeps a random page ID so a reloaded page keeps receiving its own dispatch requests.
- **MCP.** `servers.mcp.json` declares the `momo` MCP server, served by this Mini App at `/mcp/momo`. Its tools read and change ideas, records, and tasks; they cannot read or write files.

## Known limitations

- Task sessions are created through the Mini App Agent API. They are hidden from the conversation list, and you open them from the task card.
- When a task has no project folder set, it runs in the project of the conversation the page is open in. Opened outside a project conversation, it falls back to the plugin's own Agent folder.
- There is no sidebar entry, global shortcut, or system notification; open the Mini App from a conversation.
- Restarting MiniMax Code interrupts running tasks. They show **执行失败** (run failed); click **继续执行** (Continue) to resume in the same session.
- The `momo` MCP tools are available only while the Mini App is running.

## Source

The page is in `miniapp/client/` and the Node service in `miniapp/node/`: `server.mjs` handles HTTP, SSE, and uploads; `engine.mjs` handles dispatch, verification, and Agent events; `store.mjs` handles state; `mcp.mjs` serves the MCP endpoint; and `prompts.mjs` holds the role, handoff, and verification prompts. No build step and no dependencies.

## License

[MIT](LICENSE).
