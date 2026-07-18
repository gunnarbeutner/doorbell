// Interactive simulator server. The server owns every electrical step; the doorbell session also
// owns one ESPHome host process, so there is no browser-only bypass around the firmware policy.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { importNetlist, PROJECTS } from './src/import.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(ROOT, '..');
const PORT = process.env.PORT || 8080;
const HOST_YAML = join(REPO, 'firmware', 'doorbell-host.yaml');
const HOST_BINARY = join(REPO, 'firmware', '.esphome', 'build', 'doorbell-host', '.pioenvs', 'doorbell-host', 'program');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml' };
const cache = new Map();

async function inputsMtime(dir) {
  let newest = (await stat(join(ROOT, 'src', 'import.js'))).mtimeMs;
  for (const file of await readdir(dir)) {
    if (file.endsWith('.kicad_sch') || file.endsWith('.kicad_pcb') || file.endsWith('.sim'))
      newest = Math.max(newest, (await stat(join(dir, file))).mtimeMs);
  }
  return newest;
}

async function netlistObject(board) {
  const key = await inputsMtime(PROJECTS[board].dir);
  const cached = cache.get(board);
  if (cached && key <= cached.key) return cached.object;
  const object = importNetlist(board);
  cache.set(board, { object, json: JSON.stringify(object), key });
  process.stderr.write(`[netlist] ${board}: imported live from KiCad\n`);
  return object;
}

async function netlistJson(board) {
  await netlistObject(board);
  return cache.get(board).json;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: REPO, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})`));
    });
  });
}

export async function buildHostFirmware() {
  if (process.env.DOORBELL_SKIP_HOST_BUILD !== '1') {
    process.stderr.write('[firmware] incrementally compiling ESPHome host target…\n');
    await run('esphome', ['compile', HOST_YAML]);
  }
  await stat(HOST_BINARY);
}

class Session {
  constructor(board, object, environment) {
    this.id = randomUUID();
    this.board = board;
    this.netlist = object;
    this.environment = environment;
    this.clients = new Set();
    this.latest = new Map();
    this.nextActionId = 0;
    this.pendingActions = new Map();
    this.ready = null;
    this.lastUsed = Date.now();
  }

  async start() {
    let resolveReady;
    let rejectReady;
    this.ready = new Promise((resolvePromise, reject) => {
      resolveReady = resolvePromise;
      rejectReady = reject;
    });
    const worker = new Worker(new URL('./src/session-worker.js', import.meta.url), { workerData: {
      board: this.board, netlist: this.netlist, binary: HOST_BINARY, repoRoot: REPO, sessionId: this.id,
      environment: this.environment,
    } });
    this.worker = worker;
    worker.on('message', (message) => {
      this.lastUsed = Date.now();
      if (message.type === 'action-complete' || message.type === 'action-error') {
        const pending = this.pendingActions.get(message.actionId);
        if (!pending) return;
        this.pendingActions.delete(message.actionId);
        if (message.type === 'action-complete') pending.resolve();
        else pending.reject(Object.assign(new Error(message.message), { stack: message.stack }));
        return;
      }
      if (['ready', 'sample', 'firmware', 'status', 'error'].includes(message.type)) this.latest.set(message.type, message);
      if (message.type === 'ready') resolveReady(message);
      if (message.type === 'error' && !this.latest.has('ready')) rejectReady(new Error(message.message));
      this.broadcast(message);
    });
    worker.on('error', (error) => {
      rejectReady(error);
      this.rejectPendingActions(error);
      this.broadcast({ type: 'error', message: error.message, stack: error.stack });
    });
    worker.on('exit', (code) => {
      this.rejectPendingActions(new Error(`simulation worker exited with code ${code}`));
      if (this.worker === worker && code !== 0)
        this.broadcast({ type: 'error', message: `simulation worker exited with code ${code}` });
    });
    return this.ready;
  }

  broadcast(message) {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const response of this.clients) response.write(data);
  }

  attach(response) {
    this.lastUsed = Date.now();
    this.clients.add(response);
    response.write(`data: ${JSON.stringify({ type: 'session', id: this.id, board: this.board })}\n\n`);
    for (const message of this.latest.values())
      response.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  detach(response) {
    this.clients.delete(response);
    this.lastUsed = Date.now();
  }

  rejectPendingActions(error) {
    for (const pending of this.pendingActions.values()) pending.reject(error);
    this.pendingActions.clear();
  }

  action(message) {
    this.lastUsed = Date.now();
    const actionId = ++this.nextActionId;
    return new Promise((resolvePromise, reject) => {
      this.pendingActions.set(actionId, { resolve: resolvePromise, reject });
      try {
        this.worker.postMessage({ ...message, actionId });
      } catch (error) {
        this.pendingActions.delete(actionId);
        reject(error);
      }
    });
  }

  async stop() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.rejectPendingActions(new Error('simulation session stopped'));
    worker.postMessage({ type: 'shutdown' });
    const exited = new Promise((resolvePromise) => worker.once('exit', resolvePromise));
    const timer = new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    await Promise.race([exited, timer]);
    await worker.terminate();
  }

  async reset() {
    await this.stop();
    this.latest.clear();
    this.broadcast({ type: 'status', status: 'resetting' });
    await this.start();
  }
}

const sessions = new Map();

async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('request body exceeds 1 MiB');
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function sessionRoute(path) {
  const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(events|actions))?$/);
  if (!match) return null;
  return { session: sessions.get(match[1]), id: match[1], tail: match[2] };
}

export function createSimulatorServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'POST' && path === '/api/sessions') {
        const body = await jsonBody(request);
        const board = body.board || 'doorbell';
        if (!PROJECTS[board]) return sendJson(response, 400, { error: `unknown board ${board}` });
        const environment = body.environment || 'tv20s';
        if (!['tv20s', 'lab'].includes(environment))
          return sendJson(response, 400, { error: `unsupported ${board} environment ${environment}` });
        const session = new Session(board, await netlistObject(board), environment);
        sessions.set(session.id, session);
        try {
          const ready = await session.start();
          return sendJson(response, 201, { id: session.id, board, environment,
            capabilities: ready.capabilities, config: ready.config, policy: ready.policy });
        } catch (error) {
          sessions.delete(session.id);
          await session.stop();
          throw error;
        }
      }

      const route = sessionRoute(path);
      if (route) {
        if (!route.session) return sendJson(response, 404, { error: 'unknown or expired session' });
        if (request.method === 'GET' && route.tail === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
            connection: 'keep-alive' });
          route.session.attach(response);
          const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
          request.on('close', () => { clearInterval(keepalive); route.session.detach(response); });
          return;
        }
        if (request.method === 'POST' && route.tail === 'actions') {
          const action = await jsonBody(request);
          if (action.type === 'reset') await route.session.reset();
          else await route.session.action(action);
          return sendJson(response, 202, { ok: true });
        }
        if (request.method === 'DELETE' && !route.tail) {
          sessions.delete(route.id);
          await route.session.stop();
          return sendJson(response, 200, { ok: true });
        }
      }

      if (path === '/netlist.json') {
        const board = url.searchParams.get('board') || 'doorbell';
        if (!PROJECTS[board]) return sendJson(response, 400,
          { error: `unknown board "${board}" (have: ${Object.keys(PROJECTS).join(', ')})` });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(await netlistJson(board));
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405);
        response.end('method not allowed');
        return;
      }
      const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
      if (rel.startsWith('..')) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const data = await readFile(join(ROOT, rel));
      response.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream',
        'cache-control': 'no-store' });
      if (request.method === 'HEAD') response.end();
      else response.end(data);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

export async function stopAllSessions() {
  await Promise.all([...sessions.values()].map((session) => session.stop()));
  sessions.clear();
}

async function main() {
  await buildHostFirmware();
  const server = createSimulatorServer();
  server.listen(PORT, () => process.stdout.write(
    `sim + firmware → http://localhost:${PORT} (doorbell=HEAD host firmware, wf26=passive)\n`));
  const shutdown = async () => {
    server.close();
    await stopAllSessions();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, session] of sessions)
      if (!session.clients.size && session.lastUsed < cutoff) {
        sessions.delete(id);
        session.stop().catch(() => {});
      }
  }, 60000).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(error); process.exitCode = 1; });
