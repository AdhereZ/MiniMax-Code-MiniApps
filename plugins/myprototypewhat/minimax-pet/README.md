# MiniMax Pet / 桌宠

English | [简体中文](README.zh-CN.md)

A lightweight desktop companion for MiniMax Code, by **大志**. It shows visible conversation activity, answer-needed reminders and recent results without creating another chat. The interface is currently in Chinese.

## Features

- **Appearance:** preview and select pets, play short interactions, import compatible pet JSON and spritesheets, and remove imported pets.
- **Tasks:** recent reminders, visible user conversations, and a scrollable latest reply. Desktop cards preview up to five lines. Clicking a card keeps the pet visible; observed `ask_user` calls show “需要你回答” (needs your answer).
- **Settings:** pet size, page-local reminder dismissal and mute, connection status, and reconnect.
- **Desktop window:** a draggable transparent pet with compact notification cards. Return it to the main panel to use the three tabs.
- **Original-chat draft:** explicitly open the draft tool, then ask the Host to confirm appending text to the chat that opened the pet. The user still sends it. Voice-to-text is available only when the Host provides it and microphone permission is granted.

The pet does not run Agent turns, create independent chats, comment on every session, stop tasks, or answer questionnaires. Selecting a task only reads its details; it does not navigate the Host to an arbitrary conversation.

## Install and open

1. Copy the entire `plugins/myprototypewhat/minimax-pet/` directory, including `.minimax-plugin`, into `<dataDir>/plugins/minimax-pet/`. The default data directory is `~/.minimax`; use your configured directory if different. The `myprototypewhat` author directory is not part of the installed path.
2. Restart MiniMax Code and confirm the plugin is enabled.
3. Open “桌宠” from the MiniApp list, or ask the Agent “打开桌宠”.
4. Choose **放到桌面** to show the desktop pet.

To update, close the app and exit the client before replacing the complete package. Keep backups outside the client's plugins directory. Imported pets and preferences are stored separately in the Host-assigned plugin data directory.

Earlier local prototypes use a different plugin ID. The Host gives `minimax-pet` its own data directory; importing the new package does not automatically move an older plugin's pets or preferences. Keep any existing installation/data until you have exported what you need.

## Tested environment

- MiniMax Code **3.1.2 or later** is the repository's baseline installation requirement for `surface.window` and Agent declarations. **This is not a claim that every 3.1.2 release provides the read/observe or speech APIs below.**
- Task monitoring requires a Host build exposing `agent.sessions`, `agent.session`, `agent.observe`, `agent.cancel`, and the `session.read` grant. A minimum released version for these APIs has not been established for this plugin. Missing APIs are reported as unsupported.
- Voice input additionally requires `deviceAccess: ["microphone"]`, `speech.transcribe`, and microphone permission; otherwise it remains unavailable.
- The preceding UI version was exercised on macOS in a MiniMax Code development build: three tabs, wide/narrow layouts, task reading, real session/ask activity, import/delete, draft confirmation, and desktop round trips. This open-source revision has Node/DOM tests and an isolated HTTP smoke test.
- No Windows GUI, released-client installation, or real microphone recording/transcription has been verified for this revision. Automated tests use synthetic data and do not prove those paths.

## Data & access

- **Conversation data:** requests only `session.read`. Reads visible user-conversation metadata, status and a selected conversation's latest reply through the public Host API. It does not read the Host database, logs, configuration, credentials or private files. Conversation state and reminders stay in page memory.
- **Observations:** one global observer aggregates visible task lifecycle events. Up to three detailed observers follow active tasks and detect new ask tool events. A completed/removed task releases its detailed slot; another task enters only after the previous subscription settles. The initial snapshot contains up to 50 recent visible conversations; observed tasks remain while the Host confirms visibility.
- **Coverage limits:** observers are tail-only. They cannot reconstruct questionnaires opened before subscribing or during a disconnect. More than three active tasks means only three receive detailed ask coverage. No observed ask does not prove no pending question. Historical idle tasks are not presented as newly completed.
- **Local files:** the Node service serves packaged assets and stores preferences and user-imported JSON/WebP/PNG spritesheets under opaque `context.dataDir`. Imports, replacement recovery and deletion are limited to that plugin data. Browser storage is used only to migrate old view preferences.
- **Drafts:** `message.append(text)` goes through Host confirmation and targets the original chat. Monitoring or selecting another task does not change that target or send a message.
- **Microphone and network:** recording is user-initiated in the draft tool. Audio stays in memory and is passed to Host `speech.transcribe`; leaving the tool cancels capture/transcription. The Host transcription service may use its configured network services. The plugin has no hard-coded external runtime endpoint; its own HTTP requests use its assigned loopback origin.
- **Processes and Agent turns:** the Host starts one Node process. The plugin spawns no additional runtime process, launches no shell command, offers no MCP server, and never calls `agent.run`.

## Development

The complete editable source is at `sources/myprototypewhat/minimax-pet/`. The installable package is self-contained at `plugins/myprototypewhat/minimax-pet/`. See [PROVENANCE.md](PROVENANCE.md) for build and byte-comparison steps; developer notes and tests stay outside the distributed runtime payload.

## License

Original code and documentation: [MIT](LICENSE), Copyright 2026 大志. The two bundled pet spritesheets retain their original third-party terms, described in [ATTRIBUTION.md](ATTRIBUTION.md); they are **not** relicensed under MIT. The template icon has its own preserved MiniMax MIT notice.
