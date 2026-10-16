import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createMcpHandler } from "../miniapp/node/mcp.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t, work) {
  const engine = {
    bindCallerTurn() {},
    bindToolPart() {},
    setLive() {},
    attachEvent() {},
    tasks: { dispatch: (who, args, invocation) => work(who, args.tasks[0].to, args.tasks[0].message, invocation.signal) },
  };
  const team = {
    store: { getBot() {} },
    resolveBot: () => ({ id: "bot", name: "Reviewer" }),
  };
  const handler = createMcpHandler({ team, engine });
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      await handler(req, res, JSON.parse(body));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const rpc = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
  return { rpc };
}
const call = {
  id: 2,
  method: "tools/call",
  params: {
    name: "message_bot",
    arguments: { to: "Reviewer", message: "Review" },
  },
};

test("SSE sends headers before slow work finishes and disconnect does not cancel tool execution", async (t) => {
  const gate = deferred();
  let finished = false;
  let signal;
  t.after(() => gate.resolve());
  const { rpc } = await fixture(t, async (_who, _to, _text, s) => {
    signal = s;
    await gate.promise;
    finished = true;
    return { status: "done", text: "Reviewed" };
  });
  const response = await rpc(call, {
    accept: "application/json, text/event-stream",
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(finished, false);
  const reader = response.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /: connected/,
  );
  await reader.cancel();
  assert.equal(signal.aborted, false);
  gate.resolve();
  for (let i = 0; !finished && i < 100; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(finished, true);
});

test("SSE carries a JSON-RPC result; legacy JSON callers still get the same reply", async (t) => {
  const { rpc } = await fixture(t, async () => ({
    status: "done",
    text: "Reviewed",
  }));
  const stream = await rpc(call, { accept: "text/event-stream" });
  const text = await stream.text();
  const payload = JSON.parse(
    text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      .slice(6),
  );
  assert.equal(payload.id, 2);
  assert.match(payload.result.content[0].text, /Reviewed/);
  const json = await rpc(call);
  assert.equal(
    json.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.match((await json.json()).result.content[0].text, /Reviewed/);
});

test("explicit cancellation is scoped to the initialized MCP session, not the disconnected observer", async (t) => {
  const started = deferred();
  let aborted = false;
  const { rpc } = await fixture(t, async (_who, _to, _text, signal) => {
    started.resolve();
    await new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    throw new Error("Admission cancelled");
  });
  const init = await rpc({
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const response = await rpc(call, {
    accept: "text/event-stream",
    "mcp-session-id": session,
  });
  await started.promise;
  await (
    await rpc({ method: "notifications/cancelled", params: { requestId: 2 } })
  ).text();
  assert.equal(aborted, false);
  await (
    await rpc(
      { method: "notifications/cancelled", params: { requestId: 2 } },
      { "mcp-session-id": session },
    )
  ).text();
  assert.equal(aborted, true);
  assert.match(await response.text(), /isError/);
});
