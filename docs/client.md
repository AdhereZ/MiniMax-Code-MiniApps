# Mini App page APIs

Verified against MiniMax Code 3.1.2.

Session reads require 3.1.4 or later (observed on 3.1.4-preview). Observation and speech additionally
require a Host build that implements them; their minimum released client version is unverified.
These capabilities are not part of the 3.1.2 verification claim.

MiniMax Code injects `window.mcode.miniapp` into the Mini App's own page. Older clients, ordinary
Browser tabs, and other browsers do not provide it, so check that a method exists before calling
it. No SDK is needed. For type checking, copy `examples/hello-miniapp/miniapp/client/client-api.ts`
next to your Client source and reference it from TypeScript or JSDoc; never load it with a script
tag or import it at runtime.

The bridge only works in the page's own top-level document on its own origin. Keep third-party
scripts out of that document: anything running there shares the page's access to the bridge.

## `miniapp.message.append(text)`

Asks the user to add plain text to the chat input of the conversation the Mini App is open in. The
Host shows its own confirmation with the plugin, the target conversation, and the text. After the
user confirms, the text is appended to the unsent draft; the user can still edit it and must press
Send. This method cannot send messages, read chat history, or change sent messages.

```js
async function addToChat(text, status) {
  const message = window.mcode?.miniapp?.message;
  if (!message?.append) {
    status.textContent = 'This version of MiniMax Code cannot add text to the chat input.';
    return;
  }
  try {
    await message.append(text);
    status.textContent = 'Added to the chat input. Review it there and press Send.';
  } catch (error) {
    status.textContent = error?.message === 'user_cancelled' ? 'Cancelled.' : `Not added (${error?.message}).`;
  }
}
```

- Call it from a user action, such as a button click. `text` is at most 100,000 UTF-16 code units
  and is appended literally. Every call needs its own confirmation.
- Failures reject with an `Error` whose `message` is `user_cancelled`, `invalid_request`,
  `text_too_large`, `not_allowed`, `target_unavailable` (no conversation to add to), or
  `result_unknown`. After `result_unknown` the text may already be in the draft; never repeat the
  call automatically.
- A resolved promise means the text reached the draft, not that the Agent started or replied.

## `miniapp.agent`

Runs Agent turns from the page with `agentAccess: ["session.run"]` on MiniMax Code 3.1.2 or later.
Hosts with the read extension also offer `sessions`, `session` and `observe` with
`agentAccess: ["session.read"]`; this does not authorize running or answering a turn. The calls,
sessions, events, and errors are in `docs/agent.md`.

## Capability checks for Host extensions

Some Host builds expose `window.mcode.miniapp.capabilities.has(name)`. It reports whether the Host
offers an API, independently of the Mini App's manifest and the user's permission switches.
Older Hosts may omit `capabilities` altogether. Check both the capability and the method before
showing an extension-dependent control, and still handle permission and runtime errors.

For read-only session features, the capability names are `agent.sessions`, `agent.session`, and
`agent.observe`. For speech, check `speech.transcribe`. Neither a capability probe nor a passing
repository validator guarantees that the user granted access.

## `miniapp.speech` (Host extension)

Requires a Host build with `capabilities?.has('speech.transcribe') === true`, a callable
`speech.transcribe`, `deviceAccess: ["microphone"]`, and microphone permission. A released minimum
client version has not been verified. Feature-detect it and keep text input available when absent.

The page captures an utterance only after the user starts recording. Stop the microphone tracks
when recording ends or the page closes. `transcribe({ audio, format }, { onPartial? })` accepts raw
signed 16-bit mono PCM at 16,000 Hz (`format: { sampleRate: 16000, channelCount: 1,
sampleFormat: 's16' }`), not an encoded WAV/WebM/MP3 file. It returns `{ text }`; optional
`onPartial(text)` receives transcription progress. The supported build accepts up to 16,000,000
audio bytes and one transcription per Mini App at a time. Handle rejection and preserve the user's
existing text; do not automatically retry a result whose outcome is unknown.

The Host performs transcription and may contact its speech service. Disclose that audio leaves
the page through the Host; do not claim an offline-only flow unless that environment was tested.
Transcription fills the Mini App's draft. Appending to the chat still uses `message.append`, with
its separate Host confirmation, and the user still presses Send.

## `miniapp.window` (proposed)

Present on MiniMax Code 3.1.2 or later. **Proposed:** the shape may still change. Feature-detect
`window.mcode?.miniapp?.window` and do not rely on it long-term.

The handle controls this Mini App's own window: whether the page sits in the side panel (`inline`)
or is popped out (`window`), and, when popped out, its position, size, and a few flags.

```js
const handle = window.mcode?.miniapp?.window;
if (handle) {
  const state = await handle.getState(); // { mode: 'inline' } or { mode: 'window', window: {...} }
  button.addEventListener('click', () => {
    void handle.update({ mode: 'window', width: 900, height: 650 }).catch(showError);
  });
  const subscription = handle.onDidChangeState((next) => render(next));
  addEventListener('pagehide', () => subscription.dispose());
}
```

- `id` is an opaque string that stays the same while the page pops out and back.
- `update(patch)` accepts `mode`, `width`, `height`, `x`, `y`, `visible`, `resizable`,
  `alwaysOnTop`, `clickThrough`, and `skipTaskbar`; omitted fields are unchanged. `frame`,
  `transparent`, `minWidth`, and `minHeight` can only be declared in `surface.window`
  (`docs/package-contract.md`), and a patch containing them is rejected.
- Changing `mode`, and `focus()`, must come from a user gesture (for example, synchronously inside
  a click handler); otherwise they reject with `not_permitted`.
- `alwaysOnTop: true` and `clickThrough: true` are allowed only when `surface.window` declares that
  field `true`. `width` / `height` are rejected when the window is not resizable. `x` / `y` are
  rejected when the window would not overlap any display.
- Several `update` calls in one animation frame are merged into one request and share its outcome.
- Failures reject with an `Error` whose `message` is `inline_mode` (only `mode` may change while
  inline), `not_permitted`, `busy` (a `mode` change is already in progress), `invalid_request`, or
  `result_unknown`.

Pitfalls:

- `frame: false` removes the title bar. Add a CSS `-webkit-app-region: drag` area so the user can
  move the window.
- `transparent: true` also needs a transparent page background. The window has no native shadow;
  use CSS `box-shadow` with transparent padding.
- The window does not resize with content. Keep `html, body { height: 100%; overflow: hidden }` and
  scroll inside the page.
- Leaving `clickThrough` on makes the whole window, including its own controls, unclickable. Turn
  it on only for the state that needs it.
- `update({ visible: false })` hides the window but the page keeps running.
- The window title is always the plugin's `displayName`.
