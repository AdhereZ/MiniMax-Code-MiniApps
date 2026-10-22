# Mini App security rules

Verified against MiniMax Code 3.1.2.

## Process boundary

- Bind only `context.listen.host` and `context.listen.port`, with a `node:http` server. Serve
  `surface.path` and your own routes; do not proxy arbitrary URLs or arbitrary files.
- The Host authenticates every request to that port (see "Loopback authentication" in
  `docs/runtime.md`). Do not add another scheme that expects or forwards the Host's credential, and
  do not log request headers.
- Keep routes out of the Host-reserved `/__mavis/` prefix.
- Validate every request parameter. Treat the page as untrusted input to the Node process.
- Secrets stay in the Node process. Never place credentials in HTML, Client JavaScript, log
  messages, or error responses.

## State

- Store durable state under `context.dataDir`.
- Browser storage may hold view preferences (filters, sort order, expanded rows), not domain data.

## Writing outside `dataDir`

A Mini App that edits Host or user files must document, in its README, which files it writes and
how. Write atomically (temp file in the same directory, then rename), preserve the original file
mode, serialize concurrent writes, and make Undo refuse when the file changed underneath it. Back up
before bulk edits and say where the backups go.

## Spawning processes

Disclose every command in the README. Pass arguments as an array, never through a shell, and never
place user input in a command line.

## Network

Disclose every outbound host in the README. The default is none.

## Agent turns

An Agent run by a Mini App (`agentAccess: ["session.run"]`, see `docs/agent.md`) can read and write files, run
shell commands, and call MCP tools.

- Declare `agentAccess` only when the Mini App needs it, and state in the README `## Data & access`
  that it runs Agent turns and what it asks them to do.
- Leave approvals to the user. Show every `permission.requested` to the user and send `allowOnce`
  only after they choose it, or `open` the session so they can decide in the chat side panel. Never
  answer `allowOnce` automatically.
- Text from the page, files, or the network is untrusted. Build prompts from your own instructions
  plus that text clearly marked as data, and validate anything the Agent returns before acting on it.

## Read-only sessions and microphone extensions

`session.read` grants access to user conversation status and content on supporting Host builds;
it does not authorize Agent turns or user-conversation mutations. Request it only when needed,
explain the data shown and retained, and treat titles, replies and tool input as untrusted data.
Do not insert them as HTML or executable code. Do not persist or send private conversation data
elsewhere without disclosing that behavior and obtaining authorization.

`deviceAccess: ["microphone"]` separately declares microphone use. Record only after a user action,
show recording state, and release audio capture on stop, cancel or page disposal. Host speech
transcription may send audio to the Host's speech service; state this in the Mini App README and
preserve text input when the feature or permission is unavailable. Neither extension has a
verified minimum released client version; declaration validation is not a permission grant or
a runtime compatibility guarantee.
