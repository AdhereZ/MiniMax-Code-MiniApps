// @ts-check
// MoMo collaboration Mini App: Node entry. Serves the page, its JSON/SSE API, uploads, and the
// managed MCP endpoint. All mutations go through Store → Engine.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

import { Engine, errorCode } from './engine.mjs';
import { createMcpHandler } from './mcp.mjs';
import { DomainError, Store } from './store.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./miniapp-api.js').MiniAppLifecycle} MiniAppLifecycle */

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_ID = /^[a-f0-9]{12}\.(png|jpe?g|gif|webp)$/;
const MEDIA_TYPES = /** @type {Record<string, string>} */ ({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
});
const STATIC_FILES = /** @type {Record<string, [string, string]>} */ ({
  '/collab': ['index.html', 'text/html; charset=utf-8'],
  '/collab/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/collab/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/collab/momo.svg': ['momo.svg', 'image/svg+xml'],
});

/**
 * `context.dataDir` is `<mcodeData>/v2/plugin-data/liveboards/<pluginId>`. The primary agent may
 * read its own `agents/mavis/miniapps/<pluginId>` directory without approval, so uploaded images
 * live there; otherwise every screenshot read would need an approval the user cannot pre-grant.
 * @param {MiniAppContext} context
 */
function agentReadableDir(context) {
  const root = resolve(context.dataDir, '..', '..', '..', '..');
  if (existsSync(join(root, 'agents'))) return join(root, 'agents', 'mavis', 'miniapps', context.pluginId);
  return context.dataDir;
}

/**
 * @param {MiniAppContext} context
 * @returns {Promise<MiniAppLifecycle>}
 */
export async function start(context) {
  const clientDir = join(context.pluginRoot, 'miniapp', 'client');
  const agentDir = agentReadableDir(context);
  const uploadsDir = join(agentDir, 'uploads');
  const mcodeRoot = resolve(context.dataDir, '..', '..', '..', '..');
  const store = new Store(context.dataDir, context.logger);
  await store.load();

  /** Connected pages: clientId → SSE response. @type {Map<string, import('node:http').ServerResponse>} */
  const clients = new Map();
  /** @param {Record<string, unknown>} event */
  const broadcast = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients.values()) client.write(frame);
  };
  let snapshotQueued = false;
  store.subscribe(() => {
    if (snapshotQueued) return;
    snapshotQueued = true;
    queueMicrotask(() => {
      snapshotQueued = false;
      broadcast({ type: 'state', state: viewState() });
    });
  });

  const engine = new Engine({
    store,
    agent: context.agent,
    logger: context.logger,
    broadcast,
    // MiniMax Code's own data (credentials, sessions) is never served as a task output.
    protectedRoots: [mcodeRoot, context.dataDir],
    outputsRoot: join(agentDir, 'outputs'),
    pickPage: (preferred) => (preferred && clients.has(preferred) ? preferred : ([...clients.keys()].at(-1) ?? null)),
  });

  const viewState = () => ({
    ...store.snapshot(),
    agentAvailable: engine.available,
    momo: engine.momoPendingView(),
    activity: engine.activityView(),
    pages: clients.size,
  });
  await engine.recover();

  /** @param {string[]} ids */
  const resolveAttachments = async (ids) => {
    const out = [];
    for (const id of ids.slice(0, 9)) {
      if (!UPLOAD_ID.test(id)) continue;
      const info = await stat(join(uploadsDir, id)).catch(() => undefined);
      if (info?.isFile()) out.push({ id, name: id, agentPath: join(uploadsDir, id) });
    }
    return out;
  };

  const handleMcp = createMcpHandler({ store, engine, pageCount: () => clients.size, resolveAttachments });

  // ------------------------------------------------------------------ helpers

  /** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  /** @param {import('node:http').IncomingMessage} request */
  const readBody = (request) =>
    new Promise((done, fail) => {
      let size = 0;
      /** @type {Buffer[]} */
      const chunks = [];
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          fail(new DomainError('too_large', '请求太大'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (!chunks.length) return done({});
        try {
          done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          fail(new DomainError('invalid', '请求不是合法 JSON'));
        }
      });
      request.on('error', fail);
    });

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const receiveUpload = async (request, response) => {
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
    if (!ext) {
      request.resume();
      return json(response, 415, { error: 'unsupported', message: '只支持 PNG、JPEG、GIF、WebP 图片' });
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const ok = await new Promise((done) => {
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          request.destroy();
          done(false);
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => done(true));
      request.on('error', () => done(false));
    });
    if (!ok || !size) return json(response, ok ? 400 : 413, { error: 'invalid', message: ok ? '图片是空的' : '图片超过 20MB' });
    const data = Buffer.concat(chunks);
    const id = `${createHash('sha256').update(data).digest('hex').slice(0, 12)}.${ext}`;
    await mkdir(uploadsDir, { recursive: true });
    const temp = join(uploadsDir, `.part-${randomBytes(4).toString('hex')}`);
    await writeFile(temp, data);
    await rename(temp, join(uploadsDir, id));
    return json(response, 200, { upload: { id, name: id, size } });
  };

  /** @param {import('node:http').ServerResponse} response @param {string} file @param {number} size */
  const sendFile = (response, file, size) => {
    const type = MEDIA_TYPES[extname(file).toLowerCase()];
    response.writeHead(200, {
      'content-type': type ?? 'application/octet-stream',
      'content-length': size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'no-store',
      ...(type ? {} : { 'content-disposition': 'attachment' }),
    });
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  };

  // ------------------------------------------------------------------ routes

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const route = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (path === '/mcp/momo') return handleMcp(request, response, method === 'POST' ? await readBody(request) : undefined);

    const asset = method === 'GET' ? STATIC_FILES[path] : undefined;
    if (asset) {
      const content = await readFile(join(clientDir, asset[0]));
      response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
      response.end(content);
      return;
    }

    if (method === 'GET' && path === '/api/events') {
      const clientId = String(url.searchParams.get('client') ?? '').slice(0, 64) || randomBytes(6).toString('hex');
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      clients.get(clientId)?.end();
      clients.set(clientId, response);
      response.write(`data: ${JSON.stringify({ type: 'state', state: viewState() })}\n\n`);
      const ping = setInterval(() => response.write(': ping\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(ping);
        if (clients.get(clientId) === response) clients.delete(clientId);
      });
      return;
    }

    if (method === 'GET' && path === '/api/state') return json(response, 200, viewState());

    if (method === 'POST' && path === '/api/uploads') return receiveUpload(request, response);
    const upload = method === 'GET' ? /^\/api\/uploads\/([^/]+)$/.exec(path) : null;
    if (upload) {
      const id = decodeURIComponent(upload[1]);
      if (!UPLOAD_ID.test(id)) return json(response, 404, { error: 'not_found', message: '图片不存在' });
      const info = await stat(join(uploadsDir, id)).catch(() => undefined);
      if (!info?.isFile()) return json(response, 404, { error: 'not_found', message: '图片不存在' });
      return sendFile(response, join(uploadsDir, id), info.size);
    }

    const output = method === 'GET' ? /^\/api\/tasks\/([^/]+)\/outputs\/(\d+)$/.exec(path) : null;
    if (output) {
      const { file, size } = await engine.outputFile(decodeURIComponent(output[1]), Number(output[2]));
      return sendFile(response, file, size);
    }

    if (method === 'GET' && path === '/api/metrics') return json(response, 200, await metrics(store));

    if (method !== 'POST') return json(response, 404, { error: 'not_found', message: '没有这个接口' });
    const body = /** @type {Record<string, any>} */ (await readBody(request));
    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null;

    switch (path) {
      case '/api/chat': {
        const images = await resolveAttachments(Array.isArray(body.attachments) ? body.attachments.map(String) : []);
        const result = await engine.sendToMomo({
          text: String(body.text ?? ''),
          images,
          focusIdeaId: typeof body.focusIdeaId === 'string' && body.focusIdeaId ? body.focusIdeaId : null,
          clientId,
          source: body.source === 'quick_capture' ? 'quick_capture' : 'chat',
        });
        return json(response, 200, result);
      }
      case '/api/chat/stop':
        engine.stopMomo();
        return json(response, 200, { ok: true });
      case '/api/momo/answer':
        return json(response, 200, { message: await engine.answerMomoQuestion(String(body.requestId), body.answers ?? []) });
      case '/api/momo/approval':
        await engine.replyMomoApproval(String(body.requestId), body.decision === 'allowOnce' ? 'allowOnce' : 'deny');
        return json(response, 200, { ok: true });
      case '/api/seen':
        await store.updateSettings({ lastSeenAt: Date.now() });
        return json(response, 200, { ok: true });
      case '/api/settings': {
        const patch = {};
        if (['sky', 'mint', 'peach', 'lilac', 'lemon'].includes(body.momoColor)) Object.assign(patch, { momoColor: body.momoColor });
        if (body.avatarUploadId === null || (typeof body.avatarUploadId === 'string' && UPLOAD_ID.test(body.avatarUploadId))) {
          Object.assign(patch, { avatarUploadId: body.avatarUploadId });
        }
        await store.updateSettings(patch);
        return json(response, 200, { ok: true });
      }
      case '/api/track': {
        const allowed = new Set(['collab_view', 'collab_report_view', 'collab_report_click', 'collab_board_card_click']);
        if (!allowed.has(body.event)) throw new DomainError('invalid', '未知埋点');
        const fields = Object.fromEntries(
          Object.entries(body.fields ?? {})
            .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
            .slice(0, 12)
            .map(([key, value]) => [key.slice(0, 40), typeof value === 'string' ? value.slice(0, 120) : value]),
        );
        await store.emit(body.event, fields);
        return json(response, 200, { ok: true });
      }
      default:
        break;
    }

    const recordRoute = /^\/api\/records\/([^/]+)\/(move|confirm|delete)$/.exec(path);
    if (recordRoute) {
      const id = decodeURIComponent(recordRoute[1]);
      if (recordRoute[2] === 'move') {
        const target = typeof body.newIdeaTitle === 'string' && body.newIdeaTitle.trim() ? { newIdeaTitle: body.newIdeaTitle } : String(body.ideaId ?? '');
        return json(response, 200, await store.moveRecord(id, target));
      }
      if (recordRoute[2] === 'confirm') return json(response, 200, await store.confirmRecord(id));
      return json(response, 200, await store.deleteRecord(id));
    }

    const ideaRoute = /^\/api\/ideas\/([^/]+)\/(delete|rename|confirm-item)$/.exec(path);
    if (ideaRoute) {
      const id = decodeURIComponent(ideaRoute[1]);
      if (ideaRoute[2] === 'delete') {
        const result = await store.deleteIdea(id, 'user');
        return json(response, 200, { keptTasks: result.keptTasks.length });
      }
      if (ideaRoute[2] === 'rename') return json(response, 200, await store.renameIdea(id, String(body.title ?? '')));
      return json(response, 200, await store.reviseItem(id, { kind: body.kind === 'fact' ? 'fact' : 'gate', id: String(body.itemId ?? '') }, 'confirm'));
    }

    const taskRoute = /^\/api\/tasks\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (taskRoute) {
      const id = decodeURIComponent(taskRoute[1]);
      switch (taskRoute[2]) {
        case 'start':
          return json(response, 200, await engine.requestDispatch(id, clientId));
        case 'claim':
          return json(response, 200, await engine.claimDispatch(id, String(body.sessionId ?? '')));
        case 'dispatch-failed': {
          const task = store.task(id);
          if (task.dispatch && !task.sessionId) {
            await store.updateTask(id, {
              patch: { dispatch: null },
              blocked: { reason: 'project_unavailable', detail: `没法开工（${String(body.code ?? 'unknown').slice(0, 40)}），刷新协作页面后再试` },
            });
          }
          return json(response, 200, { ok: true });
        }
        case 'continue':
          await engine.continueTask(id);
          return json(response, 200, { ok: true });
        case 'redispatch':
          await store.updateTask(id, { blocked: null, patch: { sessionId: null } });
          return json(response, 200, await engine.requestDispatch(id, clientId));
        case 'defer':
          await engine.deferTask(id);
          return json(response, 200, { ok: true });
        case 'project': {
          const task = store.task(id);
          if (task.sessionId) throw new DomainError('invalid', '任务已经开工，不能换项目');
          const raw = typeof body.projectDir === 'string' ? body.projectDir.trim() : '';
          const dir = raw ? resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw) : null;
          if (dir) {
            const problem = await engine.checkProjectDir(dir);
            if (problem) throw new DomainError('invalid', problem);
          }
          await store.updateTask(id, {
            patch: { projectDir: dir },
            blocked: task.blocked?.reason === 'project_unavailable' ? null : undefined,
          });
          return json(response, 200, { ok: true, projectDir: dir });
        }
        case 'approve':
          await engine.approveTask(id);
          return json(response, 200, { ok: true });
        case 'revise':
          await engine.reviseTask(id, String(body.feedback ?? ''));
          return json(response, 200, { ok: true });
        case 'stop':
          await engine.stopTask(id);
          return json(response, 200, { ok: true });
        case 'approval':
          await engine.replyTaskApproval(id, String(body.requestId), body.decision === 'allowOnce' ? 'allowOnce' : 'deny');
          return json(response, 200, { ok: true });
        case 'answer':
          await engine.answerTaskQuestion(id, String(body.requestId), body.answers ?? []);
          return json(response, 200, { ok: true });
        default:
          break;
      }
    }
    return json(response, 404, { error: 'not_found', message: '没有这个接口' });
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const known = error instanceof DomainError;
      const agentCode = errorCode(error);
      const status = known
        ? { not_found: 404, forbidden: 403, busy: 409, too_large: 413 }[/** @type {string} */ (error.code)] ?? 400
        : agentCode === 'BUSY'
          ? 409
          : 500;
      if (!known) context.logger.error('momo.request_failed', { path: (request.url ?? '').split('?')[0], code: agentCode });
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, status, {
        error: known ? error.code : agentCode || 'internal',
        message: known ? error.message : agentCode === 'BUSY' ? '正忙，稍后再试' : '内部错误',
      });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', fail);
      done(undefined);
    });
  });
  context.logger.info('momo.listening', { agent: Boolean(context.agent) });

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    engine.dispose();
    for (const client of clients.values()) client.end();
    clients.clear();
    await store.chain;
    const closed = new Promise((done) => server.close(() => done(undefined)));
    server.closeAllConnections?.();
    await closed;
  };
  const onAbort = () => void dispose();
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();
  return { dispose };
}

/** Trial metrics computed from local telemetry. @param {Store} store */
async function metrics(store) {
  const events = await store.readTelemetry();
  const ideas = Object.values(store.state.ideas);
  const tasks = Object.values(store.state.tasks);
  const day = 24 * 60 * 60 * 1000;
  const activity = store.state.activity;
  const eligible = ideas.filter((idea) => Date.now() - idea.createdAt >= day);
  const returned = eligible.filter((idea) => activity.some((at) => at >= idea.createdAt + day && at <= idea.createdAt + 7 * day));
  const withTask = ideas.filter((idea) => tasks.some((task) => task.ideaId === idea.id));
  const dispatched = tasks.filter((task) => task.startedAt);
  const done = dispatched.filter((task) => task.status === 'done');
  const firstPass = done.filter((task) => task.reviewRound === 0);
  const revise = events.filter((event) => event.event === 'idea_fact_revise');
  const inferredOf = (/** @type {string} */ type) => events.filter((event) => event.event === 'idea_fact_infer' && event.fact_type === type).length;
  const corrections = (/** @type {string} */ type) =>
    revise.filter((event) => event.fact_type === type && (event.revise_type === 'correct' || event.revise_type === 'overturn')).length;
  const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const correction = (/** @type {string} */ type) => ({ value: pct(corrections(type), inferredOf(type)), numerator: corrections(type), denominator: inferredOf(type) });
  return {
    seven_day_return: { value: pct(returned.length, eligible.length), numerator: returned.length, denominator: eligible.length },
    idea_to_task: { value: pct(withTask.length, ideas.length), numerator: withTask.length, denominator: ideas.length },
    task_pass_rate: { value: pct(done.length, dispatched.length), numerator: done.length, denominator: dispatched.length },
    first_pass_rate: { value: pct(firstPass.length, done.length), numerator: firstPass.length, denominator: done.length },
    attribution_correction_rate: correction('attribution'),
    content_correction_rate: { value: pct(corrections('gate') + corrections('record'), inferredOf('gate') + inferredOf('record')), numerator: corrections('gate') + corrections('record'), denominator: inferredOf('gate') + inferredOf('record') },
    event_count: events.length,
  };
}
